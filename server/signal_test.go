package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestValidateSignal(t *testing.T) {
	cand := json.RawMessage(`{"candidate":"x"}`)
	tests := []struct {
		name      string
		m         Message
		isCreator bool
		ok        bool
	}{
		{"offer from creator", Message{Type: "offer", SDP: "s"}, true, true},
		{"offer from joiner", Message{Type: "offer", SDP: "s"}, false, false},
		{"offer empty sdp", Message{Type: "offer"}, true, false},
		{"answer from joiner", Message{Type: "answer", SDP: "s"}, false, true},
		{"answer from creator", Message{Type: "answer", SDP: "s"}, true, false},
		{"answer empty sdp", Message{Type: "answer"}, false, false},
		{"candidate", Message{Type: "candidate", Candidate: cand}, true, true},
		{"candidate empty", Message{Type: "candidate"}, true, false},
		{"chat", Message{Type: "chat"}, true, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := validateSignal(tc.m, tc.isCreator) == nil; got != tc.ok {
				t.Fatalf("got ok=%v, want %v", got, tc.ok)
			}
		})
	}
}

type client struct {
	t *testing.T
	c *websocket.Conn
}

func dial(t *testing.T, url string) *client {
	t.Helper()
	c, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(url, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return &client{t, c}
}

func (c *client) send(raw string) {
	c.t.Helper()
	if err := c.c.Write(context.Background(), websocket.MessageText, []byte(raw)); err != nil {
		c.t.Fatal(err)
	}
}

func (c *client) recv() Message {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, data, err := c.c.Read(ctx)
	if err != nil {
		c.t.Fatal(err)
	}
	var m Message
	if err := json.Unmarshal(data, &m); err != nil {
		c.t.Fatal(err)
	}
	return m
}

func (c *client) expect(typ string) Message {
	c.t.Helper()
	m := c.recv()
	if m.Type != typ {
		c.t.Fatalf("got %+v, want type %s", m, typ)
	}
	return m
}

func (c *client) expectError(code string) {
	c.t.Helper()
	if m := c.expect("error"); m.Code != code {
		c.t.Fatalf("got code %q, want %q", m.Code, code)
	}
}

// pair returns a creator and joiner that are already connected to each other.
func pair(t *testing.T) (a, b *client) {
	srv := httptest.NewServer(newHandler(NewHub(), nil))
	t.Cleanup(srv.Close)
	a, b = dial(t, srv.URL), dial(t, srv.URL)
	a.send(`{"type":"create"}`)
	tok := a.expect("created").Token
	b.send(`{"type":"join","token":"` + tok + `"}`)
	b.expect("joined")
	a.expect("peer-joined")
	return a, b
}

func TestPairAndRelay(t *testing.T) {
	a, b := pair(t)
	a.send(`{"type":"offer","sdp":"v=0 hello"}`)
	if m := b.expect("offer"); m.SDP != "v=0 hello" {
		t.Fatalf("sdp changed: %q", m.SDP)
	}
	b.send(`{"type":"candidate","candidate":{"candidate":"c1"}}`)
	if m := a.expect("candidate"); string(m.Candidate) != `{"candidate":"c1"}` {
		t.Fatalf("candidate changed: %s", m.Candidate)
	}
}

func TestOfferBeforeJoin(t *testing.T) {
	srv := httptest.NewServer(newHandler(NewHub(), nil))
	defer srv.Close()
	a := dial(t, srv.URL)
	a.send(`{"type":"create"}`)
	a.expect("created")
	a.send(`{"type":"offer","sdp":"x"}`)
	a.expectError("not-paired")
}

func TestMalformedJSON(t *testing.T) {
	srv := httptest.NewServer(newHandler(NewHub(), nil))
	defer srv.Close()
	a := dial(t, srv.URL)
	a.send(`{not json`)
	a.expectError("bad-message")
}

func TestChatRejected(t *testing.T) {
	a, b := pair(t)
	a.send(`{"type":"chat","text":"hi"}`)
	a.expectError("bad-message")
	// Next thing b sees must be this offer, not the chat.
	a.send(`{"type":"offer","sdp":"x"}`)
	b.expect("offer")
}

func TestPeerLeft(t *testing.T) {
	a, b := pair(t)
	b.c.Close(websocket.StatusNormalClosure, "")
	a.expect("peer-left")
}

func TestOversizeMessageCloses(t *testing.T) {
	srv := httptest.NewServer(newHandler(NewHub(), nil))
	defer srv.Close()
	a := dial(t, srv.URL)
	a.send(`{"type":"offer","sdp":"` + strings.Repeat("a", 40<<10) + `"}`)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := a.c.Read(ctx); websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
		t.Fatalf("got %v, want message-too-big close", err)
	}
}

func TestEvilOriginRejected(t *testing.T) {
	srv := httptest.NewServer(newHandler(NewHub(), nil))
	defer srv.Close()
	_, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"),
		&websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://evil.example"}}})
	if err == nil {
		t.Fatal("dial with foreign Origin should fail")
	}
}

func TestConnectionsPerIP(t *testing.T) {
	srv := httptest.NewServer(newHandler(NewHub(), nil))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	dialFrom := func(ip string) error {
		c, _, err := websocket.Dial(context.Background(), wsURL,
			&websocket.DialOptions{HTTPHeader: http.Header{"X-Forwarded-For": {ip}}})
		if err == nil {
			t.Cleanup(func() { c.CloseNow() })
		}
		return err
	}
	for range maxConnsPerIP {
		if err := dialFrom("203.0.113.1"); err != nil {
			t.Fatal(err)
		}
	}
	if err := dialFrom("203.0.113.1"); err == nil {
		t.Fatal("11th connection from one IP should be refused")
	}
	if err := dialFrom("203.0.113.2"); err != nil {
		t.Fatalf("a different IP should still connect: %v", err)
	}
}

func TestSilentConnectionCloses(t *testing.T) {
	old := firstMessageTimeout
	firstMessageTimeout = 100 * time.Millisecond
	t.Cleanup(func() { firstMessageTimeout = old })
	srv := httptest.NewServer(newHandler(NewHub(), nil))
	defer srv.Close()
	a := dial(t, srv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := a.c.Read(ctx); ctx.Err() != nil || err == nil {
		t.Fatalf("server should have closed the silent connection: %v", err)
	}
}

func TestMessageCap(t *testing.T) {
	srv := httptest.NewServer(newHandler(NewHub(), nil))
	defer srv.Close()
	a := dial(t, srv.URL)
	for range maxMessages + 1 {
		a.send(`{"type":"nope"}`)
	}
	replies := 0
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, _, err := a.c.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
				t.Fatalf("got %v, want policy-violation close", err)
			}
			break
		}
		replies++
	}
	if replies != maxMessages {
		t.Fatalf("got %d replies, want %d", replies, maxMessages)
	}
}

func TestExpiredCreatorIsToldAndClosed(t *testing.T) {
	h, clock := newTestHub()
	srv := httptest.NewServer(newHandler(h, nil))
	defer srv.Close()
	a := dial(t, srv.URL)
	a.send(`{"type":"create"}`)
	a.expect("created")
	h.mu.Lock()
	*clock = clock.Add(tokenTTL)
	h.mu.Unlock()
	sweepOnce(h)
	a.expectError("expired")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, _, err := a.c.Read(ctx); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Fatalf("got %v, want normal closure", err)
	}
}

func TestRejoinOverWebSocket(t *testing.T) {
	srv := httptest.NewServer(newHandler(NewHub(), nil))
	defer srv.Close()
	id := "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[:26]
	a, b := dial(t, srv.URL), dial(t, srv.URL)
	a.send(`{"type":"rejoin","token":"` + id + `"}`)
	if m := a.expect("created"); m.Token != "" {
		t.Fatalf("created for a rejoin should not echo a token: %+v", m)
	}
	b.send(`{"type":"rejoin","token":"` + id + `"}`)
	b.expect("joined")
	a.expect("peer-joined")
	// The paired room relays signaling like any other.
	a.send(`{"type":"offer","sdp":"v=0 resume"}`)
	if m := b.expect("offer"); m.SDP != "v=0 resume" {
		t.Fatalf("sdp changed: %q", m.SDP)
	}
	c := dial(t, srv.URL)
	c.send(`{"type":"rejoin","token":"` + id + `"}`)
	c.expectError("room-full")
}

func TestRejoinBadIDOverWebSocket(t *testing.T) {
	srv := httptest.NewServer(newHandler(NewHub(), nil))
	defer srv.Close()
	a := dial(t, srv.URL)
	for _, id := range []string{"", "nope", "../../etc/passwd", "ABCDEFGHIJKLMNOPQRSTUVWXY1"} {
		a.send(`{"type":"rejoin","token":"` + id + `"}`)
		a.expectError("invalid-token")
	}
}

func TestRejoinCannotReachInviteRoom(t *testing.T) {
	srv := httptest.NewServer(newHandler(NewHub(), nil))
	defer srv.Close()
	a, b := dial(t, srv.URL), dial(t, srv.URL)
	a.send(`{"type":"create"}`)
	token := a.expect("created").Token
	b.send(`{"type":"rejoin","token":"` + token + `"}`)
	b.expect("created") // a separate room, not the invite room
	a.send(`{"type":"offer","sdp":"x"}`)
	a.expectError("not-paired")
}
