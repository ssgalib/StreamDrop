package main

import (
	"flag"
	"log"
	"net/http"
	"time"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "listen address")
	flag.Parse()

	h := NewHub()
	go func() {
		for range time.Tick(30 * time.Second) {
			for _, p := range h.Sweep() {
				sendError(p, "expired")
			}
		}
	}()

	http.HandleFunc("GET /ws", newHandler(h))
	log.Printf("listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
