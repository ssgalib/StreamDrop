package main

import (
	"crypto/rand"
	"errors"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	tokenTTL = 10 * time.Minute
	maxRooms = 1000
)

var (
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
	mu    sync.Mutex
	rooms map[string]*Room
	now   func() time.Time // tests replace this to fake the clock
}

func NewHub() *Hub {
	return &Hub{rooms: map[string]*Room{}, now: time.Now}
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
	r, ok := h.rooms[token]
	if !ok {
		return nil, ErrInvalidToken
	}
	if r.joiner != nil {
		return nil, ErrRoomFull
	}
	if !h.now().Before(r.expiresAt) {
		return nil, ErrExpired
	}
	r.joiner = p
	p.room = r
	return r, nil
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
