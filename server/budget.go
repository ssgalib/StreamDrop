package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"strconv"
	"sync"
	"time"
)

// coturn logs this when a relay session ends. rb = bytes it received, sb = bytes it sent,
// so rb+sb counts every relayed byte twice, which is the worst case for the provider's meter.
// "peer usage" lines are per-peer subtotals and are not matched.
var usageLine = regexp.MustCompile(` session \d+: usage: realm=<[^>]*>, username=<[^>]*>, rp=\d+, rb=(\d+), sp=\d+, sb=(\d+)`)

type budgetState struct {
	Month  string `json:"month"`
	Used   int64  `json:"used"`
	Offset int64  `json:"offset"` // how far into the coturn log we have read
}

// Budget counts relayed bytes per calendar month (UTC) and says whether new relay credentials may be issued.
// shortcut: only sessions that have ended are counted, so a running session can overshoot until it
// ends (bounded by turnTTL, max-bps and total-quota in the coturn config); lower those if that matters.
type Budget struct {
	mu    sync.Mutex
	limit int64
	path  string
	now   func() time.Time
	st    budgetState
}

func newBudget(path string, limit int64) *Budget {
	b := &Budget{limit: limit, path: path, now: time.Now}
	if data, err := os.ReadFile(path); err == nil {
		json.Unmarshal(data, &b.st)
	}
	return b
}

// roll starts a new month at zero. Caller holds b.mu.
func (b *Budget) roll() {
	if m := b.now().UTC().Format("2006-01"); b.st.Month != m {
		b.st.Month, b.st.Used = m, 0
	}
}

func (b *Budget) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.roll()
	return b.st.Used < b.limit
}

func (b *Budget) Used() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.roll()
	return b.st.Used
}

// scan reads complete new lines from the coturn log, adds their bytes, and saves the position.
func (b *Budget) scan(logPath string) {
	f, err := os.Open(logPath)
	if err != nil {
		return
	}
	defer f.Close()
	b.mu.Lock()
	off := b.st.Offset
	b.mu.Unlock()
	if fi, err := f.Stat(); err == nil && fi.Size() < off {
		off = 0 // the log was rotated or truncated
	}
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return
	}
	var added int64
	r := bufio.NewReader(f)
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			break // a partial last line is read again next time
		}
		off += int64(len(line))
		if m := usageLine.FindStringSubmatch(line); m != nil {
			rb, _ := strconv.ParseInt(m[1], 10, 64)
			sb, _ := strconv.ParseInt(m[2], 10, 64)
			added += rb + sb
		}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.roll()
	b.st.Used += added
	b.st.Offset = off
	if data, err := json.Marshal(b.st); err == nil {
		os.WriteFile(b.path+".tmp", data, 0o600)
		os.Rename(b.path+".tmp", b.path)
	}
}

func (b *Budget) Tail(ctx context.Context, logPath string) {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		b.scan(logPath)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
