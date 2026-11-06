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

# Milestone 3: Large files
- [x] 3.1 `sinks.ts`: `pickerSink`, `opfsSink`, `memorySink`; picker called first in the Accept click handler; `AbortError` keeps the prompt
- [x] 3.2 `chooseSink` (picker, then OPFS if size*2 fits the quota, then memory up to 512 MiB); failures are sent to the sender as `reject` with a reason
- [x] 3.3 OPFS files older than 24 h are deleted on page load
- [x] 3.4 `QuotaExceededError` shows "Not enough disk space", sends `cancel`, aborts the sink
- [x] 3.5 Measured: 2 GiB over localhost in 56 s, about 36 MiB/s. Not tuned (plan says only if needed).
- [x] "Finalizing…" status shown while the sink closes; `saved` is only sent afterwards
- Bug fixed on the way: chunks still in flight after a cancel or failure re-fired "Unexpected data" and hid the real error. Idle receivers now drop them.

Verified in headless Chromium with Playwright (persistent profile, OPFS path):
- 2 GiB random file: sha256 matches
- cancel at 50% from sender and from receiver: peer told, no OPFS entries left
- receiver tab closed mid-transfer: sender shows an error
- file over 512 MiB with no OPFS: sender told why
- picker path (stubbed `showSaveFilePicker`, since a real one needs a native dialog): file matches; `AbortError` keeps the prompt

Not verified:
- Real `showSaveFilePicker` and a 20 GiB file (this machine has 9.8 GB free)
- Firefox / Safari
- Memory flatness in a task manager, slow disk, USB drive
- Incognito/private windows: Chrome reports a 10 GiB quota but failed at about 1.4 GB. The failure is handled ("Not enough disk space", peer told, nothing left behind), but `estimate()` can't be trusted there.

# Milestone 4: Usable product
- [x] 4.1 Invite link `http://host/#token` with Copy; opening it joins automatically and removes the hash from the address bar; manual token field kept
- [x] 4.2 Progress: percent, bytes done/total, speed (5 s rolling), time left; repainted at most twice a second; native `<progress>` with a label
- [x] 4.3 Cancel on both sides (already in Milestone 2)
- [x] 4.4 `beforeunload` guard during a transfer; screen wake lock requested while transferring (refusal ignored); "Keep both tabs open" note
- [x] 4.5 Send another file in the same room
- [x] 4.6 Readable errors (see below); expired waiting room hides the dead link and shows "Create New Link"
- [x] 4.7 `web/src/style.css`: phone-width layout, focus ring, light/dark; Accept and Copy get focus when they appear

Verified in headless Chromium (Playwright):
- Keyboard only: Tab, Enter on Create, Copy, Accept; file sha256 matches
- Three files one after another in one room
- Progress line, e.g. "0% · 1.7 MiB of 300.0 MiB · 1.9 MiB/s · 3 min left"; no more than ~2 repaints per second
- Closing the receiver tab mid-transfer prompts `beforeunload`; idle tab does not
- Hash gone from the address bar after joining; neither the Go server's nor Vite's output contains either test token
- 360 px viewport: no sideways scroll on start page, room, or incoming-file prompt (long file name)
- Errors read correctly: made-up link, used link ("already been used"), file too large here, other person disconnected, waiting-room expiry + Create New Link, joiner on an expired link ("expired")

Not verified:
- "Couldn't connect the two devices" (needs a real ICE failure)
- Wake lock actually held (headless); a person unfamiliar with the app using only the page; screen-reader behaviour; contrast measured by eye only
- A joiner on a swept (deleted) link gets "isn't valid" rather than "expired"; both read as plain messages
