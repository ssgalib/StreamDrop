package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

type Message struct {
	Type      string          `json:"type"`
	Token     string          `json:"token,omitempty"`
	ExpiresAt time.Time       `json:"expiresAt,omitzero"`
	SDP       string          `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"` // passed through unread
	Code      string          `json:"code,omitempty"`
}

var errBadMessage = errors.New("bad-message")

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

func newHandler(h *Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Accept rejects other sites' pages, because Origin must match Host.
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()

		p := &Peer{conn: conn}
		defer func() {
			if other := h.Leave(p); other != nil {
				send(other, Message{Type: "peer-left"})
			}
		}()

		for {
			_, data, err := conn.Read(r.Context()) // 32 KiB limit by default
			if err != nil {
				return
			}
			var m Message
			if json.Unmarshal(data, &m) != nil {
				sendError(p, "bad-message")
				continue
			}
			handle(h, p, m)
		}
	}
}

func handle(h *Hub, p *Peer, m Message) {
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
		// Joiner must hear "joined" first so it is ready before an offer arrives.
		send(p, Message{Type: "joined"})
		if o := h.Other(p); o != nil {
			send(o, Message{Type: "peer-joined"})
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
