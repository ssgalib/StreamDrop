package main

import (
	"crypto/rand"
	"slices"
	"strings"
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

func TestRejoinGetOrCreate(t *testing.T) {
	h, _ := newTestHub()
	id := rand.Text()
	a, b := &Peer{}, &Peer{}
	r, created, err := h.Rejoin(id, a)
	if err != nil || !created || !a.isCreator {
		t.Fatalf("first arrival should create: %v created=%v", err, created)
	}
	r2, created, err := h.Rejoin(id, b)
	if err != nil || created || r2 != r || b.isCreator {
		t.Fatalf("second arrival should join: %v created=%v", err, created)
	}
	if h.Other(a) != b || h.Other(b) != a {
		t.Fatal("peers should be paired")
	}
	if _, _, err := h.Rejoin(id, &Peer{}); err != ErrRoomFull {
		t.Fatalf("third peer: %v", err)
	}
	// After one leaves, the next arrival starts a fresh room: the server keeps no memory.
	h.Leave(a)
	if _, created, err := h.Rejoin(id, &Peer{}); err != nil || !created {
		t.Fatalf("after leave: %v created=%v", err, created)
	}
}

func TestRejoinRejectsBadIDs(t *testing.T) {
	h, _ := newTestHub()
	good := rand.Text()
	bad := []string{"", "short", good + "A", good[:25], strings.ToLower(good), good[:25] + "1", good[:25] + "/", "r:" + good[:24], good[:24] + "..", "../" + good[:23]}
	for _, id := range bad {
		if _, _, err := h.Rejoin(id, &Peer{}); err != ErrInvalidToken {
			t.Errorf("id %q: got %v, want invalid-token", id, err)
		}
	}
}

func TestRejoinAndInviteTokensAreSeparate(t *testing.T) {
	h, _ := newTestHub()
	invite, _ := h.Create(&Peer{})
	// Rejoining with a string equal to an invite token must not reach that invite room.
	p := &Peer{}
	if r, created, err := h.Rejoin(invite.token, p); err != nil || !created || r == invite {
		t.Fatalf("rejoin with an invite token reached it: %v created=%v", err, created)
	}
	// And a rejoin room can't be entered through the invite path.
	id := rand.Text()
	h.Rejoin(id, &Peer{})
	if _, err := h.Join("r:"+id, &Peer{}); err != ErrInvalidToken {
		t.Fatalf("join into a rejoin room: %v", err)
	}
}

func TestRejoinChecks(t *testing.T) {
	h, clock := newTestHub()
	a := &Peer{}
	if _, _, err := h.Rejoin(rand.Text(), a); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.Rejoin(rand.Text(), a); err != ErrAlreadyInRoom {
		t.Fatalf("already in room: %v", err)
	}
	// An unpaired rejoin room expires and its creator is returned by Sweep.
	*clock = clock.Add(tokenTTL)
	if got := h.Sweep(); len(got) != 1 || got[0] != a {
		t.Fatalf("swept %v", got)
	}
	// Server busy at the room cap.
	h2, _ := newTestHub()
	for range maxRooms {
		h2.Rejoin(rand.Text(), &Peer{})
	}
	if _, _, err := h2.Rejoin(rand.Text(), &Peer{}); err != ErrServerBusy {
		t.Fatalf("at cap: %v", err)
	}
}

func TestRejoinConcurrentArrivals(t *testing.T) {
	h, _ := newTestHub()
	id := rand.Text()
	var creators, joiners atomic.Int32
	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, created, err := h.Rejoin(id, &Peer{})
			switch {
			case err == nil && created:
				creators.Add(1)
			case err == nil:
				joiners.Add(1)
			}
		}()
	}
	wg.Wait()
	if creators.Load() != 1 || joiners.Load() != 1 {
		t.Fatalf("creators=%d joiners=%d, want 1 and 1", creators.Load(), joiners.Load())
	}
}

const idA, idB = "AAAAAAAAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBBBBBBBB"

func TestListenChecksItsInput(t *testing.T) {
	h := NewHub()
	if _, err := h.Listen([]string{"../etc"}, &Peer{}); err != ErrInvalidToken {
		t.Fatalf("bad id: %v", err)
	}
	if _, err := h.Listen(make([]string, maxListenIDs+1), &Peer{}); err != errBadMessage {
		t.Fatalf("too many ids: %v", err)
	}
	p := &Peer{}
	h.Create(p)
	if _, err := h.Listen([]string{idA}, p); err != ErrAlreadyInRoom {
		t.Fatalf("in a room: %v", err)
	}
	if len(h.listening) != 0 {
		t.Fatal("a refused listen was registered")
	}
}

func TestBothDevicesOfAPairStayRegistered(t *testing.T) {
	h := NewHub()
	a, b := &Peer{}, &Peer{}
	h.Listen([]string{idA}, a)
	h.Listen([]string{idA}, b)
	rung, listeners := h.Ring(idA)
	if listeners != 2 || len(rung) != 2 {
		t.Fatalf("rung %d, listeners %d", len(rung), listeners)
	}
}

func TestRingIsLimitedPerListener(t *testing.T) {
	h := NewHub()
	now := time.Now()
	h.now = func() time.Time { return now }
	a := &Peer{}
	h.Listen([]string{idA}, a)
	if rung, _ := h.Ring(idA); len(rung) != 1 {
		t.Fatal("first ring missing")
	}
	if rung, listeners := h.Ring(idA); len(rung) != 0 || listeners != 1 {
		t.Fatal("second ring not limited, or listener forgotten")
	}
	// A device arriving just after someone else was rung must still hear about it.
	b := &Peer{}
	h.Listen([]string{idA}, b)
	if rung, _ := h.Ring(idA); len(rung) != 1 || rung[0] != b {
		t.Fatal("the limit should not cover a different listener")
	}
	now = now.Add(ringInterval)
	if rung, _ := h.Ring(idA); len(rung) != 2 {
		t.Fatal("ring did not recover after the interval")
	}
}

func TestListenFindsARoomAlreadyWaiting(t *testing.T) {
	h := NewHub()
	h.Rejoin(idA, &Peer{})
	waiting, err := h.Listen([]string{idA, idB, idA}, &Peer{})
	if err != nil || len(waiting) != 1 || waiting[0] != idA {
		t.Fatalf("waiting %v, err %v", waiting, err)
	}
}

func TestOldestListenerIsDroppedPastTheCap(t *testing.T) {
	h := NewHub()
	var ps []*Peer
	for range maxPerID + 1 {
		p := &Peer{}
		ps = append(ps, p)
		h.Listen([]string{idA}, p)
	}
	rung, _ := h.Ring(idA)
	if len(rung) != maxPerID || slices.Contains(rung, ps[0]) {
		t.Fatalf("rung %d, oldest included: %v", len(rung), slices.Contains(rung, ps[0]))
	}
	h.Leave(ps[0]) // its entry is gone already; leaving must not disturb the others
	if len(h.byID[idA]) != maxPerID {
		t.Fatalf("%d left", len(h.byID[idA]))
	}
}

func TestListenerLimitAndCleanup(t *testing.T) {
	h := NewHub()
	var ps []*Peer
	for range maxListeners {
		p := &Peer{}
		ps = append(ps, p)
		if _, err := h.Listen([]string{idB}, p); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.Listen([]string{idA}, &Peer{}); err != ErrServerBusy {
		t.Fatalf("over the cap: %v", err)
	}
	if _, err := h.Listen([]string{idA}, ps[0]); err != nil {
		t.Fatalf("a socket already listening can change its ids: %v", err)
	}
	for _, p := range ps {
		h.Leave(p)
	}
	if len(h.listening) != 0 || len(h.byID) != 0 {
		t.Fatalf("left behind: %d sockets, %d ids", len(h.listening), len(h.byID))
	}
}
