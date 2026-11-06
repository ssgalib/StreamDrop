package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// Stored mode keeps an end-to-end encrypted file on disk for a day so the sender can leave.
// The server only ever sees ciphertext chunks and an encrypted name; the key stays in the link's #fragment.
const (
	storeChunk       = 8 << 20         // plaintext bytes per chunk, as the browser cuts them
	storeChunkMax    = storeChunk + 16 // plus the AES-GCM tag
	storeMaxFile     = 2 << 30
	storeMaxChunks   = storeMaxFile/storeChunk + 1
	storeMetaMax     = 4096
	storeFinishedTTL = 24 * time.Hour
	storePendingTTL  = time.Hour
	storeServeFactor = 3 // a file may be downloaded about three times
)

type Store struct {
	dir        string
	key        string
	totalLimit int64 // bytes of reserved plus stored files
	floor      int64 // free disk to always leave for the other sites
	budget     *Budget
	now        func() time.Time
	freeDisk   func(path string) (int64, error)

	mu    sync.Mutex
	files map[string]*entry
	used  int64
}

type entry struct {
	ID      string    `json:"id"`
	Token   string    `json:"token"`
	Size    int64     `json:"size"` // ciphertext bytes reserved
	Chunks  int       `json:"chunks"`
	Meta    string    `json:"meta"` // encrypted name, type and size; opaque to us
	Expires time.Time `json:"expires"`
	Ready   bool      `json:"ready"`

	written map[int]int64 // chunk -> bytes on disk
	served  int64         // shortcut: in memory, so it resets on restart; persist it if restarts become frequent
}

func newStore(dir, key string, totalLimit, floor int64, budget *Budget, now func() time.Time) (*Store, error) {
	s := &Store{
		dir: dir, key: key, totalLimit: totalLimit, floor: floor, budget: budget,
		now: now, freeDisk: statfsFree, files: map[string]*entry{},
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s.load()
	return s, nil
}

func statfsFree(path string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

// load rebuilds state from disk, so a restart leaks nothing and forgets nothing.
func (s *Store) load() {
	dirs, _ := os.ReadDir(s.dir)
	for _, d := range dirs {
		if !d.IsDir() || !validID(d.Name()) {
			continue
		}
		var e entry
		data, err := os.ReadFile(filepath.Join(s.dir, d.Name(), "meta.json"))
		if err != nil || json.Unmarshal(data, &e) != nil || e.ID != d.Name() || s.now().After(e.Expires) {
			os.RemoveAll(filepath.Join(s.dir, d.Name()))
			continue
		}
		e.written = map[int]int64{}
		for n := range e.Chunks {
			if fi, err := os.Stat(s.chunkPath(e.ID, n)); err == nil {
				e.written[n] = fi.Size()
			}
		}
		s.files[e.ID] = &e
		s.used += e.Size
	}
}

// Both are only called with an id that passed validID and an n that passed range checks.
func (s *Store) fileDir(id string) string { return filepath.Join(s.dir, id) }
func (s *Store) chunkPath(id string, n int) string {
	return filepath.Join(s.dir, id, "c"+strconv.Itoa(n))
}

func (s *Store) saveMeta(e *entry) error {
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	p := filepath.Join(s.fileDir(e.ID), "meta.json")
	if err := os.WriteFile(p+".tmp", data, 0o600); err != nil {
		return err
	}
	return os.Rename(p+".tmp", p)
}

// remove deletes a file from disk and the books. Caller holds s.mu.
func (s *Store) remove(id string) {
	if e, ok := s.files[id]; ok {
		s.used -= e.Size
		delete(s.files, id)
	}
	os.RemoveAll(s.fileDir(id))
}

// Sweep deletes expired files and abandoned uploads.
func (s *Store) Sweep() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, e := range s.files {
		if s.now().After(e.Expires) {
			s.remove(id)
		}
	}
}

func (s *Store) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /store", s.info)
	mux.HandleFunc("POST /store", s.create)
	mux.HandleFunc("PUT /store/{id}/{n}", s.putChunk)
	mux.HandleFunc("POST /store/{id}/finish", s.finish)
	mux.HandleFunc("DELETE /store/{id}", s.delete)
	mux.HandleFunc("GET /store/{id}", s.meta)
	mux.HandleFunc("GET /store/{id}/{n}", s.getChunk)
}

// registerStoreOff answers GET /store so the page can hide the option when Stored mode is not configured.
func registerStoreOff(mux *http.ServeMux) {
	mux.HandleFunc("GET /store", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"enabled": false})
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func same(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

// deadline gives a request its own time limit, because the server has no global timeouts
// (the long-lived WebSocket handler needs none).
func deadline(w http.ResponseWriter, d time.Duration) {
	rc := http.NewResponseController(w)
	rc.SetReadDeadline(time.Now().Add(d))
	rc.SetWriteDeadline(time.Now().Add(d))
}

func (s *Store) info(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{
		"enabled": true, "maxBytes": storeMaxFile, "chunkBytes": storeChunk, "ttlHours": int(storeFinishedTTL.Hours()),
	})
}

// entryFor finds a live file and expires it if its time is up.
func (s *Store) entryFor(id string) *entry {
	if !validID(id) {
		return nil // checked before anything touches a path
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.files[id]
	if e != nil && s.now().After(e.Expires) {
		s.remove(id)
		return nil
	}
	return e
}

func chunkIndex(e *entry, raw string) (int, bool) {
	n, err := strconv.Atoi(raw)
	return n, err == nil && n >= 0 && n < e.Chunks
}

type createReq struct {
	Size   int64  `json:"size"`
	Chunks int    `json:"chunks"`
	Meta   string `json:"meta"`
}

func (s *Store) create(w http.ResponseWriter, r *http.Request) {
	deadline(w, time.Minute)
	if !same(r.Header.Get("X-Store-Key"), s.key) {
		http.Error(w, "wrong passcode", http.StatusUnauthorized)
		return
	}
	var req createReq
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&req) != nil ||
		req.Chunks < 1 || req.Chunks > storeMaxChunks ||
		req.Size < int64(req.Chunks)*16 || req.Size > int64(req.Chunks)*storeChunkMax ||
		req.Size > storeMaxFile+int64(req.Chunks)*16 || len(req.Meta) > storeMetaMax {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if s.budget != nil && !s.budget.Allow() {
		http.Error(w, "monthly bandwidth budget used up", http.StatusServiceUnavailable)
		return
	}
	free, err := s.freeDisk(s.dir)
	if err != nil || free-req.Size < s.floor {
		http.Error(w, "not enough disk space", http.StatusInsufficientStorage)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.used+req.Size > s.totalLimit {
		http.Error(w, "storage is full", http.StatusInsufficientStorage)
		return
	}
	e := &entry{
		ID: rand.Text(), Token: rand.Text(), Size: req.Size, Chunks: req.Chunks, Meta: req.Meta,
		Expires: s.now().Add(storePendingTTL), written: map[int]int64{},
	}
	if err := os.MkdirAll(s.fileDir(e.ID), 0o700); err != nil || s.saveMeta(e) != nil {
		os.RemoveAll(s.fileDir(e.ID))
		http.Error(w, "cannot store", http.StatusInternalServerError)
		return
	}
	s.files[e.ID] = e
	s.used += e.Size
	writeJSON(w, map[string]any{"id": e.ID, "writeToken": e.Token, "expiresAt": e.Expires})
}

func (s *Store) putChunk(w http.ResponseWriter, r *http.Request) {
	deadline(w, 2*time.Minute)
	e := s.entryFor(r.PathValue("id"))
	if e == nil || !same(r.Header.Get("X-Write-Token"), e.Token) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	n, ok := chunkIndex(e, r.PathValue("n"))
	if !ok {
		http.Error(w, "bad chunk", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	ready := e.Ready
	s.mu.Unlock()
	if ready {
		http.Error(w, "already finished", http.StatusConflict)
		return
	}
	if s.budget != nil && !s.budget.Allow() {
		http.Error(w, "monthly bandwidth budget used up", http.StatusServiceUnavailable)
		return
	}
	if free, err := s.freeDisk(s.dir); err != nil || free-storeChunkMax < s.floor {
		http.Error(w, "not enough disk space", http.StatusInsufficientStorage)
		return
	}
	tmp := s.chunkPath(e.ID, n) + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		http.Error(w, "cannot store", http.StatusInternalServerError)
		return
	}
	size, err := io.Copy(f, http.MaxBytesReader(w, r.Body, storeChunkMax))
	f.Close()
	if err != nil {
		os.Remove(tmp)
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			http.Error(w, "chunk too large", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "upload failed", http.StatusBadRequest)
		}
		return
	}
	s.mu.Lock()
	var others int64
	for i, b := range e.written {
		if i != n {
			others += b
		}
	}
	if others+size > e.Size {
		s.mu.Unlock()
		os.Remove(tmp)
		http.Error(w, "more data than reserved", http.StatusRequestEntityTooLarge)
		return
	}
	// A half-written chunk is never served: it only gets its real name once complete.
	err = os.Rename(tmp, s.chunkPath(e.ID, n))
	if err == nil {
		e.written[n] = size
	}
	s.mu.Unlock()
	if err != nil {
		os.Remove(tmp)
		http.Error(w, "cannot store", http.StatusInternalServerError)
		return
	}
	if s.budget != nil {
		s.budget.Add(size)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Store) finish(w http.ResponseWriter, r *http.Request) {
	e := s.entryFor(r.PathValue("id"))
	if e == nil || !same(r.Header.Get("X-Write-Token"), e.Token) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var total int64
	for n := range e.Chunks {
		b, ok := e.written[n]
		if !ok {
			http.Error(w, "chunks missing", http.StatusConflict)
			return
		}
		total += b
	}
	if total != e.Size {
		http.Error(w, "size does not match", http.StatusConflict)
		return
	}
	e.Ready = true
	e.Expires = s.now().Add(storeFinishedTTL)
	if err := s.saveMeta(e); err != nil {
		e.Ready = false
		http.Error(w, "cannot store", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"expiresAt": e.Expires})
}

func (s *Store) delete(w http.ResponseWriter, r *http.Request) {
	e := s.entryFor(r.PathValue("id"))
	if e == nil || !same(r.Header.Get("X-Write-Token"), e.Token) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	s.mu.Lock()
	s.remove(e.ID)
	s.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

// meta is what a receiver fetches first. Unfinished uploads look like nothing at all.
func (s *Store) meta(w http.ResponseWriter, r *http.Request) {
	e := s.entryFor(r.PathValue("id"))
	s.mu.Lock()
	ready := e != nil && e.Ready
	s.mu.Unlock()
	if !ready {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]any{"chunks": e.Chunks, "size": e.Size, "meta": e.Meta, "expiresAt": e.Expires})
}

func (s *Store) getChunk(w http.ResponseWriter, r *http.Request) {
	deadline(w, 2*time.Minute)
	e := s.entryFor(r.PathValue("id"))
	s.mu.Lock()
	ready := e != nil && e.Ready
	s.mu.Unlock()
	if !ready {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	n, ok := chunkIndex(e, r.PathValue("n"))
	if !ok {
		http.Error(w, "bad chunk", http.StatusBadRequest)
		return
	}
	if s.budget != nil && !s.budget.Allow() {
		http.Error(w, "monthly bandwidth budget used up", http.StatusServiceUnavailable)
		return
	}
	f, err := os.Open(s.chunkPath(e.ID, n))
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	s.mu.Lock()
	if e.served+fi.Size() > storeServeFactor*e.Size {
		s.mu.Unlock()
		http.Error(w, "download limit reached", http.StatusTooManyRequests)
		return
	}
	e.served += fi.Size()
	s.mu.Unlock()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
	sent, _ := io.Copy(w, f)
	if s.budget != nil {
		s.budget.Add(sent)
	}
}
