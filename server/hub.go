package main

import (
	"crypto/rand"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	tokenTTL = 10 * time.Minute
	maxRooms = 1000

	maxListeners = 2000 // sockets
	maxListenIDs = 32   // saved devices per socket
	maxPerID     = 4    // both devices of a pair use the same id, and a dead socket can linger until its ping fails
	ringInterval = 5 * time.Second
)

var (
	errBadMessage    = errors.New("bad-message")
	ErrInvalidToken  = errors.New("invalid-token")
	ErrExpired       = errors.New("expired")
	ErrRoomFull      = errors.New("room-full")
	ErrAlreadyInRoom = errors.New("already-in-room")
	ErrServerBusy    = errors.New("server-busy")
)

type Peer struct {
	conn      *websocket.Conn // nil in unit tests
	room      *Room           // guarded by Hub.mu
	isCreator bool
}

type Room struct {
	token           string
	expiresAt       time.Time
	creator, joiner *Peer
}

type Hub struct {
	mu        sync.Mutex
	rooms     map[string]*Room
	listening map[*Peer]map[string]time.Time // each socket's ids, with when it was last rung for each
	byID      map[string][]*Peer             // oldest first
	now       func() time.Time               // tests replace this to fake the clock
}

func NewHub() *Hub {
	return &Hub{rooms: map[string]*Room{}, listening: map[*Peer]map[string]time.Time{}, byID: map[string][]*Peer{}, now: time.Now}
}

func (h *Hub) Create(p *Peer) (*Room, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if p.room != nil {
		return nil, ErrAlreadyInRoom
	}
	if len(h.rooms) >= maxRooms {
		return nil, ErrServerBusy
	}
	r := &Room{token: rand.Text(), expiresAt: h.now().Add(tokenTTL), creator: p}
	h.rooms[r.token] = r
	p.room, p.isCreator = r, true
	return r, nil
}

func (h *Hub) Join(token string, p *Peer) (*Room, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if p.room != nil {
		return nil, ErrAlreadyInRoom
	}
	// Rooms made by Rejoin are keyed with this prefix; an invite token never is.
	r, ok := h.rooms[token]
	if !ok || strings.HasPrefix(token, rejoinPrefix) {
		return nil, ErrInvalidToken
	}
	if err := h.joinLocked(r, p); err != nil {
		return nil, err
	}
	return r, nil
}

// joinLocked adds p as the joiner of r. Caller holds h.mu.
func (h *Hub) joinLocked(r *Room, p *Peer) error {
	if r.joiner != nil {
		return ErrRoomFull
	}
	if !h.now().Before(r.expiresAt) {
		return ErrExpired
	}
	r.joiner = p
	p.room = r
	return nil
}

const rejoinPrefix = "r:"

// validID reports whether s has the shape of rand.Text(): 26 base32 characters.
func validID(s string) bool {
	if len(s) != 26 {
		return false
	}
	for _, c := range s {
		if (c < 'A' || c > 'Z') && (c < '2' || c > '7') {
			return false
		}
	}
	return true
}

// Rejoin is get-or-create for a transfer id, so two peers who both reconnect meet whoever arrives
// first. It keeps no memory of past rooms: a room exists only while someone is waiting in it.
func (h *Hub) Rejoin(id string, p *Peer) (r *Room, created bool, err error) {
	if !validID(id) {
		return nil, false, ErrInvalidToken
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if p.room != nil {
		return nil, false, ErrAlreadyInRoom
	}
	key := rejoinPrefix + id
	if r, ok := h.rooms[key]; ok {
		if err := h.joinLocked(r, p); err != nil {
			return nil, false, err
		}
		return r, false, nil
	}
	if len(h.rooms) >= maxRooms {
		return nil, false, ErrServerBusy
	}
	r = &Room{token: key, expiresAt: h.now().Add(tokenTTL), creator: p}
	h.rooms[key] = r
	p.room, p.isCreator = r, true
	return r, true, nil
}

// Listen replaces the ids p waits on, and returns those with someone already waiting in a room, to ring at once.
// Everything here is in memory and gone when the socket closes.
func (h *Hub) Listen(ids []string, p *Peer) ([]string, error) {
	if len(ids) > maxListenIDs {
		return nil, errBadMessage
	}
	for _, id := range ids {
		if !validID(id) {
			return nil, ErrInvalidToken
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if p.room != nil {
		return nil, ErrAlreadyInRoom
	}
	if _, ok := h.listening[p]; !ok && len(h.listening) >= maxListeners {
		return nil, ErrServerBusy
	}
	h.unlistenLocked(p)
	mine := make(map[string]time.Time, len(ids))
	h.listening[p] = mine
	var waiting []string
	for _, id := range ids {
		if _, dup := mine[id]; dup {
			continue
		}
		mine[id] = time.Time{}
		h.byID[id] = append(h.byID[id], p)
		if l := h.byID[id]; len(l) > maxPerID {
			delete(h.listening[l[0]], id)
			h.byID[id] = l[1:]
		}
		if r, ok := h.rooms[rejoinPrefix+id]; ok && r.joiner == nil && h.ringableLocked(p, id) {
			waiting = append(waiting, id)
		}
	}
	return waiting, nil
}

// unlistenLocked requires h.mu to be held.
func (h *Hub) unlistenLocked(p *Peer) {
	for id := range h.listening[p] {
		h.byID[id] = slices.DeleteFunc(h.byID[id], func(q *Peer) bool { return q == p })
		if len(h.byID[id]) == 0 {
			delete(h.byID, id)
		}
	}
	delete(h.listening, p)
}

// ringableLocked reports whether p may be rung for id now, and if so records that it was.
func (h *Hub) ringableLocked(p *Peer, id string) bool {
	if t := h.listening[p][id]; !t.IsZero() && h.now().Sub(t) < ringInterval {
		return false
	}
	h.listening[p][id] = h.now()
	return true
}

// Ring returns who should be told that someone is waiting for id, and whether anyone listens at all.
// The caller's own device is usually among them, because both sides of a pair listen on the same id;
// the server can't tell its sockets apart, so a client ignores a ring for a room it is already in.
func (h *Hub) Ring(id string) (rung []*Peer, listening bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, p := range h.byID[id] {
		listening = true
		if h.ringableLocked(p, id) {
			rung = append(rung, p)
		}
	}
	return rung, listening
}

func (h *Hub) Other(p *Peer) *Peer {
	h.mu.Lock()
	defer h.mu.Unlock()
	return other(p)
}

// other requires h.mu to be held.
func other(p *Peer) *Peer {
	if p.room == nil {
		return nil
	}
	if p.isCreator {
		return p.room.joiner
	}
	return p.room.creator
}

func (h *Hub) Leave(p *Peer) *Peer {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.unlistenLocked(p)
	r := p.room
	if r == nil {
		return nil
	}
	o := other(p)
	delete(h.rooms, r.token)
	p.room = nil
	if o != nil {
		o.room = nil
	}
	return o
}

func (h *Hub) Sweep() []*Peer {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []*Peer
	for t, r := range h.rooms {
		if r.joiner == nil && !h.now().Before(r.expiresAt) {
			delete(h.rooms, t)
			r.creator.room = nil
			out = append(out, r.creator)
		}
	}
	return out
}
