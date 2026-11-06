# Milestone 1 progress

- [x] Step 1: Project setup (git, Go module, Vite app, sample files removed)
- [x] Step 2: `server/hub.go` + `hub_test.go`
- [x] Step 3: `validateSignal` + table test
- [x] Step 4: WebSocket handler + integration tests
- [x] Step 5: `server/main.go`
- [x] Step 6: `web/vite.config.ts`
- [x] Step 7: `web/index.html`
- [x] Step 8: `web/src/peer.ts`
- [x] Step 9: `web/src/main.ts`
- [x] Step 10: automated checks pass; browser checklist run with Playwright (headless Chromium), all pass except two not run (below)

## Not run
- Expiry check (set `tokenTTL` to 30s): covered by the Go fake-clock tests only, not in a browser.
- Real "stop the Go server" test: emulated by cutting signaling in the page (the DataChannel kept working), because killing your server was not allowed. Worth one manual try.
