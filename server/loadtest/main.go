// Command loadtest opens many paired rooms against a StreamDrop server and checks the limits.
// Run the server locally (it trusts X-Forwarded-For, which this client uses to fake distinct IPs).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

type msg struct {
	Type  string `json:"type"`
	Token string `json:"token,omitempty"`
	SDP   string `json:"sdp,omitempty"`
	Code  string `json:"code,omitempty"`
}

var url = flag.String("url", "ws://127.0.0.1:8080/ws", "server WebSocket URL")

func dial(ctx context.Context, ip string) (*websocket.Conn, *http.Response, error) {
	return websocket.Dial(ctx, *url, &websocket.DialOptions{HTTPHeader: http.Header{"X-Forwarded-For": {ip}}})
}

func send(ctx context.Context, c *websocket.Conn, m msg) error {
	b, _ := json.Marshal(m)
	return c.Write(ctx, websocket.MessageText, b)
}

func recv(ctx context.Context, c *websocket.Conn) (msg, error) {
	var m msg
	_, b, err := c.Read(ctx)
	if err == nil {
		err = json.Unmarshal(b, &m)
	}
	return m, err
}

// pair connects a creator and joiner and relays one offer; both connections stay open.
func pair(ctx context.Context, ip string) ([]*websocket.Conn, error) {
	a, _, err := dial(ctx, ip)
	if err != nil {
		return nil, err
	}
	b, _, err := dial(ctx, ip)
	if err != nil {
		return nil, err
	}
	conns := []*websocket.Conn{a, b}
	if err := send(ctx, a, msg{Type: "create"}); err != nil {
		return conns, err
	}
	created, err := recv(ctx, a)
	if err != nil || created.Type != "created" {
		return conns, fmt.Errorf("create: %v %+v", err, created)
	}
	send(ctx, b, msg{Type: "join", Token: created.Token})
	if m, err := recv(ctx, b); err != nil || m.Type != "joined" {
		return conns, fmt.Errorf("join: %v %+v", err, m)
	}
	if m, err := recv(ctx, a); err != nil || m.Type != "peer-joined" {
		return conns, fmt.Errorf("peer-joined: %v %+v", err, m)
	}
	send(ctx, a, msg{Type: "offer", SDP: "v=0 load"})
	if m, err := recv(ctx, b); err != nil || m.Type != "offer" || m.SDP != "v=0 load" {
		return conns, fmt.Errorf("offer relay: %v %+v", err, m)
	}
	return conns, nil
}

func main() {
	rooms := flag.Int("rooms", 1000, "paired rooms to open")
	hold := flag.Duration("hold", 10*time.Second, "how long to keep everything open after READY")
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	var mu sync.Mutex
	var all []*websocket.Conn
	var ok, failed atomic.Int32
	sem := make(chan struct{}, 50)
	var wg sync.WaitGroup
	start := time.Now()
	for i := range *rooms {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			conns, err := pair(ctx, fmt.Sprintf("10.%d.%d.%d", i>>16&255, i>>8&255, i&255))
			mu.Lock()
			all = append(all, conns...)
			mu.Unlock()
			if err != nil {
				failed.Add(1)
				fmt.Fprintln(os.Stderr, "pair failed:", err)
				return
			}
			ok.Add(1)
		}()
	}
	wg.Wait()
	fmt.Printf("rooms ok=%d failed=%d connections=%d in %s\n", ok.Load(), failed.Load(), len(all), time.Since(start).Round(time.Millisecond))

	// Limit 1: an 11th connection from one IP is refused with 429.
	var same []*websocket.Conn
	var status int
	for range 11 {
		c, resp, err := dial(ctx, "192.0.2.1")
		if err != nil && resp != nil {
			status = resp.StatusCode
		} else if err == nil {
			same = append(same, c)
		}
	}
	fmt.Printf("per-IP limit: %d accepted, 11th got HTTP %d (want 10 and 429)\n", len(same), status)
	for _, c := range same {
		c.CloseNow()
	}

	// Limit 2: once 1000 rooms exist, another create returns server-busy instead of crashing.
	c, _, err := dial(ctx, "192.0.2.2")
	if err == nil {
		send(ctx, c, msg{Type: "create"})
		m, _ := recv(ctx, c)
		fmt.Printf("room cap: create beyond limit -> %s %s (want error server-busy)\n", m.Type, m.Code)
		c.CloseNow()
	}

	fmt.Println("READY")
	time.Sleep(*hold)
	for _, c := range all {
		c.CloseNow()
	}
}
