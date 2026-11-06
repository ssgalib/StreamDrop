package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type Message struct {
	Type       string          `json:"type"`
	Token      string          `json:"token,omitempty"`
	ExpiresAt  time.Time       `json:"expiresAt,omitzero"`
	SDP        string          `json:"sdp,omitempty"`
	Candidate  json.RawMessage `json:"candidate,omitempty"` // passed through unread
	Code       string          `json:"code,omitempty"`
	ICEServers []ICEServer     `json:"iceServers,omitempty"`
	IDs        []string        `json:"ids,omitempty"`       // listen
	Listeners  int             `json:"listeners,omitempty"` // created: sockets listening on this id, the caller's own included
}

const (
	maxConnsPerIP = 10
	maxMessages   = 256
)

// Variables so tests can shorten them.
var (
	firstMessageTimeout = 15 * time.Second
	pingInterval        = 45 * time.Second // under the ~100 s a proxy may allow an idle WebSocket
	pingTimeout         = 15 * time.Second
)

// The desktop app's bundled page. Browsers set Origin themselves, so no website can claim it.
var appOrigins = []string{"app://streamdrop"}

type ipLimiter struct {
	mu sync.Mutex
	n  map[string]int
}

func (l *ipLimiter) acquire(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.n[ip] >= maxConnsPerIP {
		return false
	}
	l.n[ip]++
	return true
}

func (l *ipLimiter) release(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.n[ip]--; l.n[ip] <= 0 {
		delete(l.n, ip)
	}
}

func clientIP(r *http.Request) string {
	// Safe only because signaling is reachable solely through Caddy, which replaces this header.
	if ip, _, _ := strings.Cut(r.Header.Get("X-Forwarded-For"), ","); ip != "" {
		return strings.TrimSpace(ip)
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}

func validateSignal(m Message, isCreator bool) error {
	switch m.Type {
	case "offer":
		if isCreator && m.SDP != "" {
			return nil
		}
	case "answer":
		if !isCreator && m.SDP != "" {
			return nil
		}
	case "candidate":
		if len(m.Candidate) > 0 {
			return nil
		}
	}
	return errBadMessage
}

// ice supplies relay servers for a freshly paired room; nil means none.
func newHandler(h *Hub, ice func() []ICEServer) http.HandlerFunc {
	limiter := &ipLimiter{n: map[string]int{}}
	firstTimeout, interval, timeout := firstMessageTimeout, pingInterval, pingTimeout // read once: tests change the variables between handlers
	return func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		if !limiter.acquire(ip) {
			http.Error(w, "too many connections", http.StatusTooManyRequests)
			return
		}
		defer limiter.release(ip)

		// Accept rejects other sites' pages, because Origin must match Host.
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: appOrigins})
		if err != nil {
			return
		}
		defer conn.CloseNow()

		pingCtx, stopPing := context.WithCancel(r.Context())
		defer stopPing()
		go keepAlive(pingCtx, conn, interval, timeout)

		p := &Peer{conn: conn}
		defer func() {
			if other := h.Leave(p); other != nil {
				send(other, Message{Type: "peer-left"})
			}
		}()

		for n := 1; ; n++ {
			// A connection that never speaks is holding a slot for nothing.
			ctx, cancel := r.Context(), context.CancelFunc(func() {})
			if n == 1 {
				ctx, cancel = context.WithTimeout(ctx, firstTimeout)
			}
			_, data, err := conn.Read(ctx) // 32 KiB limit by default
			cancel()
			if err != nil {
				return
			}
			if n > maxMessages {
				conn.Close(websocket.StatusPolicyViolation, "too many messages")
				return
			}
			var m Message
			if json.Unmarshal(data, &m) != nil {
				sendError(p, "bad-message")
				continue
			}
			handle(h, p, m, ice)
		}
	}
}

// keepAlive closes a socket whose device has vanished (a phone changing network sends no close), so it
// can't sit in a room as a ghost that a new arrival "joins". The traffic also keeps idle sockets open through proxies.
func keepAlive(ctx context.Context, conn *websocket.Conn, interval, timeout time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		pingCtx, cancel := context.WithTimeout(ctx, timeout)
		err := conn.Ping(pingCtx)
		cancel()
		if err != nil {
			conn.CloseNow()
			return
		}
	}
}

func handle(h *Hub, p *Peer, m Message, ice func() []ICEServer) {
	switch m.Type {
	case "create":
		room, err := h.Create(p)
		if err != nil {
			sendError(p, err.Error())
			return
		}
		send(p, Message{Type: "created", Token: room.token, ExpiresAt: room.expiresAt})
	case "join":
		if _, err := h.Join(m.Token, p); err != nil {
			sendError(p, err.Error())
			return
		}
		announcePaired(h, p, ice)
	case "rejoin":
		room, created, err := h.Rejoin(m.Token, p)
		if err != nil {
			sendError(p, err.Error())
			return
		}
		if created {
			rung, listeners := h.Ring(m.Token)
			send(p, Message{Type: "created", ExpiresAt: room.expiresAt, Listeners: listeners})
			for _, l := range rung {
				send(l, Message{Type: "ring", Token: m.Token})
			}
			return
		}
		announcePaired(h, p, ice)
	case "listen":
		waiting, err := h.Listen(m.IDs, p)
		if err != nil {
			sendError(p, err.Error())
			return
		}
		for _, id := range waiting {
			send(p, Message{Type: "ring", Token: id})
		}
	case "offer", "answer", "candidate":
		// p.isCreator is only written by Create before the handler loop continues, so this read is safe.
		if validateSignal(m, p.isCreator) != nil {
			sendError(p, "bad-message")
			return
		}
		o := h.Other(p)
		if o == nil {
			sendError(p, "not-paired")
			return
		}
		// Fresh Message so a client can't smuggle extra fields through.
		send(o, Message{Type: m.Type, SDP: m.SDP, Candidate: m.Candidate})
	default:
		sendError(p, "bad-message")
	}
}

// announcePaired tells a newly joined peer and the one waiting for it that the room is full.
func announcePaired(h *Hub, p *Peer, ice func() []ICEServer) {
	// Joiner must hear "joined" first so it is ready before an offer arrives.
	// Only paired peers get relay credentials; "created" carries none.
	var servers []ICEServer
	if ice != nil {
		servers = ice()
	}
	send(p, Message{Type: "joined", ICEServers: servers})
	if o := h.Other(p); o != nil {
		send(o, Message{Type: "peer-joined", ICEServers: servers})
	}
}

func send(p *Peer, m Message) {
	data, err := json.Marshal(m)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Write errors are ignored: that peer's own read loop will notice and clean up.
	p.conn.Write(ctx, websocket.MessageText, data)
}

func sendError(p *Peer, code string) {
	send(p, Message{Type: "error", Code: code})
}

// sweepOnce tells creators whose waiting room timed out, then closes their sockets.
func sweepOnce(h *Hub) {
	for _, p := range h.Sweep() {
		sendError(p, "expired")
		go p.conn.Close(websocket.StatusNormalClosure, "expired") // the close handshake can take seconds
	}
}
