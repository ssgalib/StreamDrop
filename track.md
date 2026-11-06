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
- [x] Step 10: automated checks pass; browser checklist run with Playwright (headless Chromium), all pass

## Milestone 1 leftovers (project-plan.md section 1)
- [x] Real server-stop test: file arrived after the Go server was stopped.
- [x] Expiry in a browser (TTL temporarily 30s, restored to 10 min): waiting tab showed "That token has expired."
- [x] `go mod tidy` (`coder/websocket` no longer marked indirect)
- [x] `peer-left` fix (Step 2.1)

# Milestone 2: File transfer
- [x] 2.1 peer-left fix; `disconnected`/`failed` count as lost peer during a transfer
- [x] 2.2 `peer.ts`: channel "file", binary type, low-water event, `channel()`, `maxMessageSize()`
- [x] 2.3 `web/src/transfer.ts` (sender, receiver, `parseMeta`)
- [x] 2.4 `web/src/sinks.ts` memory sink
- [x] 2.5 `meta` validation
- [x] 2.6 page: file picker, accept/decline prompt, progress bar, cancel
- [x] 2.7 `npm test`: 9 unit tests pass
- [x] Done-when, in headless Chromium via Playwright: empty, 1 KiB and 500 MiB files match sha256; decline then retry works; closing either tab mid-transfer shows an error on the other.

## Deviations / notes
- The file picker appears in the room once connected (not before Create Room), so one room can send several files.
- Test files are excluded from `tsc` (`node:test` types need `@types/node`); node runs them directly.
- Playwright script is in the session scratchpad, not the repo.
- Not tested: Firefox/Safari, files over 500 MiB (memory sink holds the whole file, Milestone 3 fixes that).
