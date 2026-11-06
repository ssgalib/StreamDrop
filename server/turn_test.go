package main

import (
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTurnServersCredential(t *testing.T) {
	got := turnServers("testsecret", "203.0.113.5", time.Unix(1700000000, 0))
	if len(got) != 1 {
		t.Fatalf("got %d servers", len(got))
	}
	s := got[0]
	// Expected value computed independently: printf '1700010800:streamdrop' | openssl dgst -sha1 -hmac testsecret -binary | base64
	if s.Username != "1700010800:streamdrop" || s.Credential != "n+R2L9VqjKoTQFNUg5MOlco3Lbw=" {
		t.Fatalf("unexpected credential %+v", s)
	}
	if s.URLs[0] != "turn:203.0.113.5:3478?transport=udp" {
		t.Fatalf("unexpected url %v", s.URLs)
	}
}

func TestTurnServersDisabled(t *testing.T) {
	if turnServers("", "host", time.Now()) != nil || turnServers("secret", "", time.Now()) != nil {
		t.Fatal("missing secret or host should disable relay")
	}
}

func TestIceServersOnlyAfterPairing(t *testing.T) {
	ice := func() []ICEServer { return []ICEServer{{URLs: []string{"turn:x"}}} }
	srv := httptest.NewServer(newHandler(NewHub(), ice))
	defer srv.Close()
	a, b := dial(t, srv.URL), dial(t, srv.URL)
	a.send(`{"type":"create"}`)
	created := a.expect("created")
	if len(created.ICEServers) != 0 {
		t.Fatal("created must not carry relay servers")
	}
	b.send(`{"type":"join","token":"` + created.Token + `"}`)
	if m := b.expect("joined"); len(m.ICEServers) != 1 {
		t.Fatalf("joined: %+v", m.ICEServers)
	}
	if m := a.expect("peer-joined"); len(m.ICEServers) != 1 {
		t.Fatalf("peer-joined: %+v", m.ICEServers)
	}
}

func logLine(rb, sb int) string {
	return fmt.Sprintf("0: (1): INFO: session 000000000000000001: usage: realm=<r>, username=<u>, rp=7, rb=%d, sp=9, sb=%d", rb, sb)
}

func TestBudgetCountsSessionUsage(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "turn.log")
	peerLine := "0: (1): INFO: session 000000000000000001: peer usage: realm=<r>, username=<u>, rp=1, rb=99999, sp=1, sb=99999\n"
	os.WriteFile(logPath, []byte("noise\n"+peerLine+"0: (1): INFO: session 000000000000000001: usage: realm=<r>, username=<u>, rp=7, rb=1000, sp=9, sb=2000\n"), 0o600)

	b := newBudget(filepath.Join(dir, "state.json"), 5000)
	b.scan(logPath)
	if b.Used() != 3000 {
		t.Fatalf("used %d, want 3000 (peer usage lines are ignored)", b.Used())
	}
	if !b.Allow() {
		t.Fatal("under budget should allow")
	}

	// A partial last line is not counted until it is complete; reading again does not double count.
	f, _ := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("0: (1): INFO: session 000000000000000002: usage: realm=<r>, username=<u>, rp=1, rb=1500, sp=1, sb=1")
	b.scan(logPath)
	if b.Used() != 3000 {
		t.Fatalf("partial line counted: %d", b.Used())
	}
	f.WriteString("500\n")
	f.Close()
	b.scan(logPath)
	b.scan(logPath)
	if b.Used() != 6000 {
		t.Fatalf("used %d, want 6000", b.Used())
	}
	if b.Allow() {
		t.Fatal("over budget should refuse")
	}

	// State survives a restart and does not recount the log.
	b2 := newBudget(filepath.Join(dir, "state.json"), 5000)
	b2.scan(logPath)
	if b2.Used() != 6000 {
		t.Fatalf("after restart used %d, want 6000", b2.Used())
	}

	// A truncated (rotated) log is read from the start.
	os.WriteFile(logPath, []byte("0: (1): INFO: session 000000000000000003: usage: realm=<r>, username=<u>, rp=1, rb=10, sp=1, sb=20\n"), 0o600)
	b2.scan(logPath)
	if b2.Used() != 6030 {
		t.Fatalf("after rotation used %d, want 6030", b2.Used())
	}
}

func TestBudgetResetsEachMonth(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "turn.log")
	os.WriteFile(logPath, []byte(logLine(5, 5)+"\n"), 0o600)
	b := newBudget(filepath.Join(dir, "state.json"), 10)
	clock := time.Date(2026, 11, 30, 12, 0, 0, 0, time.UTC)
	b.now = func() time.Time { return clock }
	b.scan(logPath)
	if b.Allow() {
		t.Fatal("budget should be used up in November")
	}
	clock = time.Date(2026, 12, 1, 0, 0, 1, 0, time.UTC)
	if !b.Allow() || b.Used() != 0 {
		t.Fatalf("December should start fresh, used %d", b.Used())
	}
}
