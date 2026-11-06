package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newTestHub() (*Hub, *time.Time) {
	t := time.Unix(1000, 0)
	h := NewHub()
	h.now = func() time.Time { return t }
	return h, &t
}

func TestTokensUnique(t *testing.T) {
	h, _ := newTestHub()
	seen := map[string]bool{}
	for range 1000 {
		r, err := h.Create(&Peer{})
		if err != nil {
			t.Fatal(err)
		}
		if len(r.token) < 26 || seen[r.token] {
			t.Fatalf("bad or duplicate token %q", r.token)
		}
		seen[r.token] = true
	}
}

func TestJoin(t *testing.T) {
	h, clock := newTestHub()
	r, _ := h.Create(&Peer{})

	if _, err := h.Join("nope", &Peer{}); err != ErrInvalidToken {
		t.Fatalf("unknown token: %v", err)
	}
	b := &Peer{}
	if _, err := h.Join(r.token, b); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Join(r.token, &Peer{}); err != ErrRoomFull {
		t.Fatalf("third peer: %v", err)
	}

	r2, _ := h.Create(&Peer{})
	*clock = clock.Add(tokenTTL)
	if _, err := h.Join(r2.token, &Peer{}); err != ErrExpired {
		t.Fatalf("at expiry: %v", err)
	}
}

func TestAlreadyInRoom(t *testing.T) {
	h, _ := newTestHub()
	a := &Peer{}
	r, _ := h.Create(a)
	if _, err := h.Create(a); err != ErrAlreadyInRoom {
		t.Fatalf("create: %v", err)
	}
	if _, err := h.Join(r.token, a); err != ErrAlreadyInRoom {
		t.Fatalf("join: %v", err)
	}
}

func TestSweep(t *testing.T) {
	h, clock := newTestHub()
	waiting := &Peer{}
	h.Create(waiting)
	paired, _ := h.Create(&Peer{})
	h.Join(paired.token, &Peer{})

	*clock = clock.Add(tokenTTL)
	got := h.Sweep()
	if len(got) != 1 || got[0] != waiting {
		t.Fatalf("swept %v", got)
	}
	if _, ok := h.rooms[paired.token]; !ok || len(h.rooms) != 1 {
		t.Fatal("paired room should survive")
	}
}

func TestLeave(t *testing.T) {
	h, _ := newTestHub()
	a, b := &Peer{}, &Peer{}
	r, _ := h.Create(a)
	h.Join(r.token, b)
	if h.Leave(a) != b {
		t.Fatal("Leave should return the other peer")
	}
	if _, err := h.Join(r.token, &Peer{}); err != ErrInvalidToken {
		t.Fatalf("after leave: %v", err)
	}
	if a.room != nil || b.room != nil {
		t.Fatal("rooms not cleared")
	}
}

func TestServerBusy(t *testing.T) {
	h, _ := newTestHub()
	for range maxRooms {
		if _, err := h.Create(&Peer{}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.Create(&Peer{}); err != ErrServerBusy {
		t.Fatalf("got %v", err)
	}
}

func TestConcurrentJoin(t *testing.T) {
	h, _ := newTestHub()
	r, _ := h.Create(&Peer{})
	var ok atomic.Int32
	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := h.Join(r.token, &Peer{}); err == nil {
				ok.Add(1)
			}
		}()
	}
	wg.Wait()
	if ok.Load() != 1 {
		t.Fatalf("%d joins succeeded", ok.Load())
	}
}
