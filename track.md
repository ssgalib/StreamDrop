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
- [~] Step 10: automated checks pass (`go vet`, `go test -race`, `npm run build`); manual Firefox checklist NOT done

## Remaining
- Run the manual Firefox checklist from plan.md Step 10 (two tabs, DataChannel, stop-server test, expiry, XSS).
- Quick server + Vite proxy smoke test was blocked, so the `/ws` proxy is unverified.
