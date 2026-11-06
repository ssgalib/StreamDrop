package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type storeEnv struct {
	t      *testing.T
	s      *Store
	srv    *httptest.Server
	dir    string
	clock  *time.Time
	free   *int64
	budget *Budget
}

func newStoreEnv(t *testing.T, totalLimit int64, budget *Budget) *storeEnv {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "files")
	return startStoreEnv(t, dir, totalLimit, budget, time.Unix(1_700_000_000, 0))
}

func startStoreEnv(t *testing.T, dir string, totalLimit int64, budget *Budget, now time.Time) *storeEnv {
	t.Helper()
	clock, free := now, int64(1<<40)
	s, err := newStore(dir, "passcode", totalLimit, 1000, budget, func() time.Time { return clock })
	if err != nil {
		t.Fatal(err)
	}
	s.freeDisk = func(string) (int64, error) { return free, nil }
	mux := http.NewServeMux()
	s.Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &storeEnv{t: t, s: s, srv: srv, dir: dir, clock: &clock, free: &free, budget: budget}
}

func (e *storeEnv) do(method, path string, body []byte, headers map[string]string) (int, []byte) {
	e.t.Helper()
	req, _ := http.NewRequest(method, e.srv.URL+path, bytes.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	// Don't follow redirects: Go's router redirects paths like /store/x/.. before any handler runs.
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data
}

type created struct{ ID, Token string }

// create reserves a file of size ciphertext bytes in chunks pieces.
func (e *storeEnv) create(size int64, chunks int) (created, int) {
	e.t.Helper()
	body, _ := json.Marshal(createReq{Size: size, Chunks: chunks, Meta: "encrypted-name"})
	code, data := e.do("POST", "/store", body, map[string]string{"X-Store-Key": "passcode"})
	var out struct {
		ID         string `json:"id"`
		WriteToken string `json:"writeToken"`
	}
	json.Unmarshal(data, &out)
	return created{out.ID, out.WriteToken}, code
}

func (e *storeEnv) put(c created, n int, data []byte) int {
	code, _ := e.do("PUT", fmt.Sprintf("/store/%s/%d", c.ID, n), data, map[string]string{"X-Write-Token": c.Token})
	return code
}

func (e *storeEnv) finish(c created) int {
	code, _ := e.do("POST", "/store/"+c.ID+"/finish", nil, map[string]string{"X-Write-Token": c.Token})
	return code
}

// upload makes a finished file of two chunks: 60 and 40 bytes.
func (e *storeEnv) upload() (created, []byte, []byte) {
	e.t.Helper()
	c, code := e.create(100, 2)
	if code != 200 {
		e.t.Fatalf("create: %d", code)
	}
	a, b := bytes.Repeat([]byte{1}, 60), bytes.Repeat([]byte{2}, 40)
	if e.put(c, 0, a) != 204 || e.put(c, 1, b) != 204 || e.finish(c) != 200 {
		e.t.Fatal("upload failed")
	}
	return c, a, b
}

func TestStoreUploadDownloadRoundTrip(t *testing.T) {
	e := newStoreEnv(t, 1<<20, nil)
	c, a, b := e.upload()
	code, data := e.do("GET", "/store/"+c.ID, nil, nil)
	var m struct {
		Chunks int
		Size   int64
		Meta   string
	}
	json.Unmarshal(data, &m)
	if code != 200 || m.Chunks != 2 || m.Size != 100 || m.Meta != "encrypted-name" {
		t.Fatalf("meta: %d %+v", code, m)
	}
	for n, want := range [][]byte{a, b} {
		code, got := e.do("GET", fmt.Sprintf("/store/%s/%d", c.ID, n), nil, nil)
		if code != 200 || !bytes.Equal(got, want) {
			t.Fatalf("chunk %d: %d", n, code)
		}
	}
}

func TestStoreZeroByteFile(t *testing.T) {
	e := newStoreEnv(t, 1<<20, nil)
	c, code := e.create(16, 1) // just the AES-GCM tag
	if code != 200 || e.put(c, 0, make([]byte, 16)) != 204 || e.finish(c) != 200 {
		t.Fatal("zero-byte file should store")
	}
}

func TestStoreWrongPasscode(t *testing.T) {
	e := newStoreEnv(t, 1<<20, nil)
	body, _ := json.Marshal(createReq{Size: 100, Chunks: 2})
	for _, h := range []map[string]string{nil, {"X-Store-Key": "wrong"}, {"X-Store-Key": ""}, {"X-Store-Key": "passcod"}, {"X-Store-Key": "passcodes"}} {
		if code, _ := e.do("POST", "/store", body, h); code != 401 {
			t.Fatalf("headers %v: got %d, want 401", h, code)
		}
	}
	if entries, _ := os.ReadDir(e.dir); len(entries) != 0 {
		t.Fatal("a refused upload must leave nothing on disk")
	}
}

func TestStoreWrongWriteToken(t *testing.T) {
	e := newStoreEnv(t, 1<<20, nil)
	c, _ := e.create(100, 2)
	bad := created{c.ID, "WRONG"}
	if e.put(bad, 0, []byte("x")) != 404 || e.finish(bad) != 404 {
		t.Fatal("wrong token must not write or finish")
	}
	if code, _ := e.do("DELETE", "/store/"+c.ID, nil, map[string]string{"X-Write-Token": "WRONG"}); code != 404 {
		t.Fatalf("delete with wrong token: %d", code)
	}
	if code, _ := e.do("DELETE", "/store/"+c.ID, nil, nil); code != 404 {
		t.Fatalf("delete with no token: %d", code)
	}
}

func TestStoreRejectsBadIDsAndChunkNumbers(t *testing.T) {
	e := newStoreEnv(t, 1<<20, nil)
	c, _, _ := e.upload()
	parent := filepath.Dir(e.dir)
	before, _ := os.ReadDir(parent)
	for _, id := range []string{"..", "%2e%2e", "..%2f..%2fetc", "x", strings.ToLower(c.ID), c.ID + "A", "ABCDEFGHIJKLMNOPQRSTUVWXY!"} {
		for _, p := range []string{"/store/" + id, "/store/" + id + "/0"} {
			if code, _ := e.do("GET", p, nil, nil); code != 404 && code != 400 && code != 301 && code != 307 {
				t.Errorf("GET %s: %d", p, code)
			}
		}
		if code, _ := e.do("PUT", "/store/"+id+"/0", []byte("x"), map[string]string{"X-Write-Token": c.Token}); code == 204 {
			t.Errorf("PUT with id %q succeeded", id)
		}
	}
	for _, n := range []string{"-1", "2", "99999999999999999999", "abc", "..", "0x1", "1.5", " 1", "%2e%2e"} {
		if code, _ := e.do("GET", "/store/"+c.ID+"/"+n, nil, nil); code != 400 && code != 404 && code != 301 && code != 307 {
			t.Errorf("GET chunk %q: %d", n, code)
		}
	}
	after, _ := os.ReadDir(parent)
	if len(after) != len(before) {
		t.Fatal("something was created outside the store directory")
	}
}

func TestStoreChunkLimits(t *testing.T) {
	e := newStoreEnv(t, 1<<30, nil)
	c, _ := e.create(storeChunkMax, 1)
	if code := e.put(c, 0, make([]byte, storeChunkMax+1)); code != 413 {
		t.Fatalf("oversized chunk: %d", code)
	}
	if entries, _ := os.ReadDir(e.s.fileDir(c.ID)); len(entries) != 1 { // only meta.json
		t.Fatalf("a refused chunk left files behind: %v", entries)
	}
	// More than the reservation, even in several pieces.
	c2, _ := e.create(100, 2)
	if e.put(c2, 0, make([]byte, 90)) != 204 || e.put(c2, 1, make([]byte, 20)) != 413 {
		t.Fatal("total beyond the reservation must be refused")
	}
	// Re-sending a chunk replaces it instead of adding up (upload retries).
	if e.put(c2, 0, make([]byte, 90)) != 204 || e.put(c2, 0, make([]byte, 90)) != 204 {
		t.Fatal("a retried chunk should replace the old one")
	}
}

func TestStoreFinishNeedsEverything(t *testing.T) {
	e := newStoreEnv(t, 1<<20, nil)
	c, _ := e.create(100, 2)
	e.put(c, 0, make([]byte, 60))
	if e.finish(c) != 409 {
		t.Fatal("finish with a missing chunk")
	}
	e.put(c, 1, make([]byte, 30)) // 90 of 100 declared
	if e.finish(c) != 409 {
		t.Fatal("finish with the wrong total")
	}
	if code, _ := e.do("GET", "/store/"+c.ID, nil, nil); code != 404 {
		t.Fatal("unfinished files must be invisible")
	}
	if code, _ := e.do("GET", "/store/"+c.ID+"/0", nil, nil); code != 404 {
		t.Fatal("unfinished chunks must not be readable")
	}
	e.put(c, 1, make([]byte, 40))
	if e.finish(c) != 200 || e.put(c, 0, make([]byte, 60)) != 409 {
		t.Fatal("after finish the file is sealed")
	}
}

func TestStoreTotalCapAndRelease(t *testing.T) {
	e := newStoreEnv(t, 1000, nil)
	c, code := e.create(600, 1)
	if code != 200 {
		t.Fatal(code)
	}
	if _, code := e.create(600, 1); code != 507 {
		t.Fatalf("over the total cap: %d", code)
	}
	if code, _ := e.do("DELETE", "/store/"+c.ID, nil, map[string]string{"X-Write-Token": c.Token}); code != 204 {
		t.Fatal("delete")
	}
	if entries, _ := os.ReadDir(e.dir); len(entries) != 0 {
		t.Fatal("delete must remove the files")
	}
	if _, code := e.create(600, 1); code != 200 {
		t.Fatalf("space should be free again: %d", code)
	}
}

func TestStoreDiskFloor(t *testing.T) {
	e := newStoreEnv(t, 1<<30, nil)
	*e.free = 1000 + 99 // the floor is 1000: a 100-byte file would cross it
	if _, code := e.create(100, 2); code != 507 {
		t.Fatalf("create below the floor: %d", code)
	}
	*e.free = 1 << 40
	c, code := e.create(100, 2)
	if code != 200 {
		t.Fatal(code)
	}
	*e.free = 1000 // the disk filled up meanwhile (other sites)
	if e.put(c, 0, make([]byte, 10)) != 507 {
		t.Fatal("a chunk write must recheck the floor")
	}
}

func TestStoreBadCreateRequests(t *testing.T) {
	e := newStoreEnv(t, 1<<40, nil)
	cases := []createReq{
		{Size: 100, Chunks: 0}, {Size: 100, Chunks: -1}, {Size: 100, Chunks: storeMaxChunks + 1},
		{Size: 10, Chunks: 1},                     // smaller than a tag
		{Size: storeChunkMax + 1, Chunks: 1},      // chunk larger than allowed
		{Size: storeMaxFile + 1<<20, Chunks: 257}, // over the file limit
		{Size: 100, Chunks: 2, Meta: strings.Repeat("x", storeMetaMax+1)},
	}
	for _, c := range cases {
		body, _ := json.Marshal(c)
		if code, _ := e.do("POST", "/store", body, map[string]string{"X-Store-Key": "passcode"}); code != 400 {
			t.Errorf("%+v: got %d, want 400", c, code)
		}
	}
	if code, _ := e.do("POST", "/store", []byte("not json"), map[string]string{"X-Store-Key": "passcode"}); code != 400 {
		t.Error("garbage body")
	}
}

func TestStoreExpiry(t *testing.T) {
	e := newStoreEnv(t, 1000, nil)
	// An abandoned upload expires after an hour and frees its reservation.
	abandoned, _ := e.create(600, 1)
	*e.clock = e.clock.Add(storePendingTTL + time.Second)
	e.s.Sweep()
	if entries, _ := os.ReadDir(e.dir); len(entries) != 0 {
		t.Fatal("abandoned upload not removed")
	}
	if e.put(abandoned, 0, make([]byte, 10)) != 404 {
		t.Fatal("expired upload still accepts data")
	}
	// A finished file lives 24 hours from finishing, whatever the upload time.
	c, _, _ := e.upload()
	*e.clock = e.clock.Add(storeFinishedTTL - time.Minute)
	if code, _ := e.do("GET", "/store/"+c.ID, nil, nil); code != 200 {
		t.Fatalf("should still be there: %d", code)
	}
	*e.clock = e.clock.Add(2 * time.Minute)
	if code, _ := e.do("GET", "/store/"+c.ID, nil, nil); code != 404 {
		t.Fatalf("should have expired: %d", code)
	}
	if entries, _ := os.ReadDir(e.dir); len(entries) != 0 {
		t.Fatal("expired file left on disk")
	}
	if _, code := e.create(900, 1); code != 200 {
		t.Fatal("expired files must free their space")
	}
}

func TestStoreRestartRebuildsTotals(t *testing.T) {
	e := newStoreEnv(t, 1000, nil)
	c, a, _ := e.upload() // 100 bytes
	pending, _ := e.create(850, 1)
	_ = pending

	e2 := startStoreEnv(t, e.dir, 1000, nil, *e.clock)
	if code, got := e2.do("GET", "/store/"+c.ID+"/0", nil, nil); code != 200 || !bytes.Equal(got, a) {
		t.Fatalf("finished file lost across a restart: %d", code)
	}
	if e2.s.used != 950 {
		t.Fatalf("used after restart = %d, want 950", e2.s.used)
	}
	if _, code := e2.create(100, 1); code != 507 {
		t.Fatalf("the cap must still hold after a restart: %d", code)
	}
	// The unfinished upload can be completed after the restart.
	if code, _ := e2.do("PUT", "/store/"+pending.ID+"/0", make([]byte, 850), map[string]string{"X-Write-Token": pending.Token}); code != 204 {
		t.Fatalf("resume upload after restart: %d", code)
	}
	// Expired files and stray folders are cleaned up on start.
	os.MkdirAll(filepath.Join(e.dir, "not-an-id"), 0o700)
	later := e.clock.Add(storeFinishedTTL + time.Hour)
	e3 := startStoreEnv(t, e.dir, 1000, nil, later)
	if e3.s.used != 0 {
		t.Fatalf("expired files should be gone, used=%d", e3.s.used)
	}
	if entries, _ := os.ReadDir(e.dir); len(entries) != 1 {
		t.Fatalf("only the stray folder may remain: %v", entries)
	}
}

func TestStoreDownloadLimit(t *testing.T) {
	e := newStoreEnv(t, 1<<20, nil)
	c, _, _ := e.upload() // 100 bytes: 3x = 300 bytes served at most
	for i := range 5 {
		if code, _ := e.do("GET", "/store/"+c.ID+"/0", nil, nil); code != 200 { // 5 x 60 = 300
			t.Fatalf("download %d: %d", i, code)
		}
	}
	if code, _ := e.do("GET", "/store/"+c.ID+"/0", nil, nil); code != 429 {
		t.Fatalf("past the limit: %d", code)
	}
}

func TestStoreBudgetStopsReadsAndWrites(t *testing.T) {
	dir := t.TempDir()
	b := newBudget(filepath.Join(dir, "usage.json"), 100)
	e := newStoreEnv(t, 1<<20, b)
	c, code := e.create(100, 2)
	if code != 200 {
		t.Fatal(code)
	}
	e.put(c, 0, make([]byte, 60))
	e.put(c, 1, make([]byte, 40))
	if b.Used() != 100 {
		t.Fatalf("uploads must count against the budget: %d", b.Used())
	}
	if e.finish(c) != 200 {
		t.Fatal("finish costs nothing and must still work")
	}
	if code, _ := e.do("GET", "/store/"+c.ID+"/0", nil, nil); code != 503 {
		t.Fatalf("download with the budget used up: %d", code)
	}
	if _, code := e.create(100, 2); code != 503 {
		t.Fatalf("new upload with the budget used up: %d", code)
	}
	if code := e.put(c, 0, make([]byte, 1)); code != 503 && code != 409 {
		t.Fatalf("write with the budget used up: %d", code)
	}
	// Downloads count too, and next month everything works again.
	b2 := newBudget(filepath.Join(dir, "usage2.json"), 1000)
	e2 := newStoreEnv(t, 1<<20, b2)
	c2, _, _ := e2.upload()
	e2.do("GET", "/store/"+c2.ID+"/0", nil, nil)
	e2.do("GET", "/store/"+c2.ID+"/1", nil, nil)
	if b2.Used() != 200 {
		t.Fatalf("100 uploaded + 100 downloaded = 200, got %d", b2.Used())
	}
}

func TestBudgetAddSurvivesRestartAndRollsOver(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")
	b := newBudget(path, 1000)
	nov := time.Date(2026, 11, 30, 12, 0, 0, 0, time.UTC)
	b.now = func() time.Time { return nov }
	b.Add(400)
	b.Add(300)
	if b.Used() != 700 || !b.Allow() {
		t.Fatalf("used %d", b.Used())
	}
	b2 := newBudget(path, 1000) // a restart
	b2.now = b.now
	if b2.Used() != 700 {
		t.Fatalf("after restart: %d", b2.Used())
	}
	b2.Add(300)
	if b2.Allow() {
		t.Fatal("should be used up at 1000")
	}
	b2.now = func() time.Time { return time.Date(2026, 12, 1, 0, 0, 1, 0, time.UTC) }
	if !b2.Allow() || b2.Used() != 0 {
		t.Fatalf("new month should start at zero, used %d", b2.Used())
	}
}

func TestStoreInfo(t *testing.T) {
	e := newStoreEnv(t, 1<<20, nil)
	code, data := e.do("GET", "/store", nil, nil)
	var on struct{ Enabled bool }
	json.Unmarshal(data, &on)
	if code != 200 || !on.Enabled {
		t.Fatalf("enabled: %d %s", code, data)
	}
	mux := http.NewServeMux()
	registerStoreOff(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	resp, _ := http.Get(srv.URL + "/store")
	var off struct{ Enabled bool }
	json.NewDecoder(resp.Body).Decode(&off)
	if off.Enabled {
		t.Fatal("disabled store must say so")
	}
	if resp, _ := http.Post(srv.URL+"/store", "application/json", strings.NewReader("{}")); resp.StatusCode == 200 {
		t.Fatal("uploads must not exist when Stored mode is off")
	}
}

func TestStoreConcurrentUploadsAreSafe(t *testing.T) {
	e := newStoreEnv(t, 1<<30, nil)
	c, code := e.create(10*100, 10)
	if code != 200 {
		t.Fatal(code)
	}
	var wg sync.WaitGroup
	for n := range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			buf := make([]byte, 100)
			rand.Read(buf)
			if e.put(c, n, buf) != 204 {
				t.Errorf("chunk %d", n)
			}
		}()
	}
	wg.Wait()
	if e.finish(c) != 200 {
		t.Fatal("finish after concurrent uploads")
	}
}
