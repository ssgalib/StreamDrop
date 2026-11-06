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
	mux := http.NewServeMux()

	// Relay (TURN) needs TURN_SECRET and TURN_HOST; Stored mode needs STORE_GB and STORE_KEY.
	// Both draw on one monthly byte budget (RELAY_BUDGET_GB, default 600).
	secret, host := os.Getenv("TURN_SECRET"), os.Getenv("TURN_HOST")
	relayOn := secret != "" && host != ""
	storeGB := atoiEnv("STORE_GB", 0)
	storeOn := storeGB > 0

	var budget *Budget
	if relayOn || storeOn {
		budget = newBudget(envOr("STATE_DIRECTORY", ".")+"/relay-usage.json", int64(atoiEnv("RELAY_BUDGET_GB", 600))<<30)
	}

	var ice func() []ICEServer
	if relayOn {
		go budget.Tail(context.Background(), envOr("TURN_LOG", "/var/log/turnserver/turnserver.log"))
		ice = func() []ICEServer {
			if !budget.Allow() {
				return nil // monthly budget used up: only direct and STUN paths until next month
			}
			return turnServers(secret, host, time.Now())
		}
		log.Printf("relay enabled")
	}

	var store *Store
	if storeOn {
		key := os.Getenv("STORE_KEY")
		if key == "" {
			log.Fatal("STORE_KEY is required when STORE_GB is set")
		}
		var err error
		store, err = newStore(envOr("STORE_DIR", envOr("STATE_DIRECTORY", ".")+"/files"), key,
			int64(storeGB)<<30, int64(atoiEnv("STORE_FLOOR_GB", 3))<<30, budget, time.Now)
		if err != nil {
			log.Fatal(err)
		}
		store.Register(mux)
		log.Printf("stored mode enabled, up to %d GB", storeGB)
	} else {
		registerStoreOff(mux)
	}

	go func() {
		for range time.Tick(30 * time.Second) {
			sweepOnce(h)
			if store != nil {
				store.Sweep()
			}
		}
	}()

	mux.HandleFunc("GET /ws", newHandler(h, ice))
	log.Printf("listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// atoiEnv reads a positive whole number, or a default when unset; anything else is a mistake worth stopping for.
func atoiEnv(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		log.Fatalf("%s must be a positive number", key)
	}
	return n
}
