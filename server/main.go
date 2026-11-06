package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "listen address")
	flag.Parse()

	h := NewHub()
	go func() {
		for range time.Tick(30 * time.Second) {
			sweepOnce(h)
		}
	}()

	// Relay (TURN) is off unless TURN_SECRET and TURN_HOST are set.
	var ice func() []ICEServer
	if secret, host := os.Getenv("TURN_SECRET"), os.Getenv("TURN_HOST"); secret != "" && host != "" {
		limitGB, err := strconv.Atoi(envOr("RELAY_BUDGET_GB", "600"))
		if err != nil || limitGB <= 0 {
			log.Fatal("RELAY_BUDGET_GB must be a positive number")
		}
		budget := newBudget(envOr("STATE_DIRECTORY", ".")+"/relay-usage.json", int64(limitGB)<<30)
		go budget.Tail(context.Background(), envOr("TURN_LOG", "/var/log/turnserver/turnserver.log"))
		ice = func() []ICEServer {
			if !budget.Allow() {
				return nil // monthly relay budget used up: only direct and STUN paths until next month
			}
			return turnServers(secret, host, time.Now())
		}
		log.Printf("relay enabled, budget %d GB per month", limitGB)
	}

	http.HandleFunc("GET /ws", newHandler(h, ice))
	log.Printf("listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
