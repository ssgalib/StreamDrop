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

# Milestone 5: Production setup (repo side done, VPS not touched)
- [x] 5.1 Server hardening: 10 connections per IP (429 beyond that, IP from `X-Forwarded-For`), first message within 15 s, 256 messages per connection (then policy-violation close), expired rooms get `expired` then the socket is closed (`sweepOnce`). Each limit has a Go test; `go test -race -count=3` passes.
- [x] Client: closing an expired room's socket no longer overwrites "Link expired" with "Cannot reach the server".
- [x] Docker/Caddy files written, then deleted: the VPS has no Docker and nginx already owns 80/443. Deploy is now a static Go binary + systemd + nginx (`deploy/`).
- [x] CSP (now set in `deploy/nginx-streamdrop.conf`) checked in Chromium: a full transfer and download under that policy produced no violations and the stylesheet applied. (Tested with a Node proxy adding the header and `ws://` instead of `wss://`.)
- [ ] 5.2 Prepare the VPS, [ ] 5.4 Deploy: NOT done, see below.
- Untested: `deploy/*` has not been run (needs sudo on the VPS); nginx config not syntax-checked (no nginx here).

## VPS findings (read-only `ssh vps`)
- Ubuntu 24.04, 2 vCPU, 3.8 GiB RAM, 11 GB free. User `galib` is in the `sudo` and `docker` groups, but sudo needs a password and Docker is not installed.
- **nginx is active and already serves other sites on ports 80/443** (habits.kurohane.xyz, pomodoro, typing, voxel-arena). The plan's Caddy container publishes 80/443 and would fail to start or collide with them.
- Domain: `streamdrop.kurohane.xyz`. Existing sites are reached through a **Cloudflare Tunnel** (cloudflared -> nginx on 127.0.0.1:80), so HTTPS is Cloudflare's and no certbot is needed. Real client IP arrives in `CF-Connecting-IP`; the nginx block copies it into `X-Forwarded-For` for the per-IP limit.
- Go server runs on 127.0.0.1:4310 (8080 is named in the tunnel config for dev.kurohane.xyz).

## Deploy (run by the user; needs sudo password)
1. One-time: add the `streamdrop.kurohane.xyz` ingress rule to `/etc/cloudflared/config.yml` (snippet is in the header of `deploy/deploy.sh`), restart cloudflared, run `cloudflared tunnel route dns`.
2. `deploy/deploy.sh` (builds, rsyncs to the VPS, runs `install.sh` under sudo).

## Milestone 5 live results (https://streamdrop.kurohane.xyz)
- [x] Deployed with `deploy/deploy.sh`; tunnel rule added to `/etc/cloudflared/config.yml` (backup at `config.yml.bak`) and DNS routed. Other sites (habits, pomodoro, typing, voxel) still return 200.
- [x] Page loads over HTTPS (Cloudflare certificate) with CSP, Referrer-Policy and nosniff headers.
- [x] WebSocket upgrade over HTTP/1.1: real origin 101, foreign origin 403.
- [x] Live transfer in two Chromium tabs on this machine: 1 KiB and 50 MB, sha256 match (50 MB in 3.3 s).
- [ ] **CSP errors:** Cloudflare injects its Web Analytics beacon (`static.cloudflareinsights.com/beacon.min.js`), which the CSP blocks. Harmless, but the console shows an error. Fix in the Cloudflare dashboard (Web Analytics / auto-injection off for this hostname) rather than loosening the CSP.
- [ ] Transfer between two devices on the same network (only tested two tabs on one machine)
- [ ] `nmap` from another machine (not available here)
- [ ] Restarting `streamdrop` mid-transfer leaves the transfer running (needs sudo; the design allows it because signaling is not used after connect)

# Milestone 7: Release (partly done; TURN/Milestone 6 skipped)
- [x] Playwright e2e (`npm run test:e2e`, dev dependency `@playwright/test`): starts both servers, sends a generated 5 MiB file and a zero-byte file between two Chromium browsers, compares sha256 (memory sink).
- [x] Load test (`server/loadtest`, run locally): 1000 paired rooms = 2000 connections, 0 failures, 144 ms to connect; server RSS 11.9 MiB idle -> 70 MiB under load (limit 4 GB); all connections released afterwards. Per-IP limit returns HTTP 429 on the 11th, room cap returns `server-busy`; the server kept running. Not run on the VPS (shared with other sites).
- [x] Security review: only log line is "listening" (no tokens/SDP); no innerHTML/eval; `.env` never committed; `go vet`, `govulncheck`, `npm audit` clean; the server has no message type that carries file bytes.
- [x] README with runbook (adapted to nginx + systemd + Cloudflare Tunnel, no Docker/TURN).
- [ ] Browser matrix: only Chromium on Linux. Playwright's Firefox gathers no ICE candidates here and WebKit needs libraries this machine lacks (`CROSS_BROWSER=1` is opt-in). Firefox, Safari, Edge, Windows, macOS, Android and iOS are untested.
- [ ] A fresh VPS set up from the README alone; a 20 GiB transfer across two real networks.
- Finding: with no STUN/TURN (`iceServers: []`), transfers work between browsers that can reach each other directly (same LAN) but likely fail across different networks. Milestone 6 (at least STUN) is needed for the main "send a file to a friend" case.

# After Milestone 7
- [x] Added STUN (`stun:stun.cloudflare.com:3478`) in `web/src/peer.ts`. The server answered a test binding request. TURN is still not set up. Needs `deploy/deploy.sh` to go live.
- Bandwidth: direct transfers never pass through the VPS (only tiny signaling messages). Only a future TURN relay would use VPS bandwidth. The VPS is a generic KVM guest; the provider's monthly cap is unknown (check the hosting panel). eth0 has sent 1.0 GiB in the 1.5 days since boot.

# Decisions
- STUN deployed and live (bundle checked).
- **Bandwidth budget: StreamDrop may use at most 600 GB/month of the VPS's 1 TB/month allowance** (the other 400 GB is for the other sites). Today it uses ~0 because direct transfers never touch the VPS. The cap only matters once a TURN relay exists. When adding TURN (Milestone 6):
  - Count each relayed byte twice (in + out) unless the provider is confirmed to count outgoing only: 600 GB then covers roughly 300 GB of relayed files.
  - coturn's `max-bps`/`user-quota`/`total-quota` limit speed and sessions, not monthly bytes, so a hard 600 GB stop needs our own accounting (e.g. the Go server stops issuing TURN credentials once a monthly relay counter reaches the budget). Confirm what coturn can report (its metrics) against the docs for the pinned version before building it.
  - Check the provider's panel monthly: it shows total VPS usage including the other sites.

# Milestone 6: TURN relay (built in the repo, NOT installed or tested end to end)
- [x] `server/turn.go`: short-lived HMAC credentials (3 h); unit test uses an OpenSSL-computed vector. Disabled unless `TURN_SECRET` and `TURN_HOST` are set.
- [x] Relay servers are sent only in `joined` / `peer-joined`, never in `created` (tested).
- [x] `server/budget.go`: counts `rb+sb` from coturn's session `usage:` log lines per UTC month, persists state, survives restarts and log rotation, ignores `peer usage` lines; stops issuing credentials at `RELAY_BUDGET_GB` (default 600). Tests: parsing, partial lines, restart, rotation, month rollover.
- [x] Client passes relay servers into `RTCPeerConnection`; `?relay=1` forces the relay path for testing.
- [x] `deploy/turnserver.conf.in` (denies private ranges, loopback, tailscale range and the VPS's own IP; 24 Mbit/s per session, 10 sessions), `deploy/install-turn.sh` (opt-in, uses the public IP so no DNS record), systemd drop-in, logrotate.
- [x] Ubuntu's coturn 4.6.1 has no Prometheus support, so the budget reads its log; the `usage:` format string was confirmed in the package binary.
- Existing tests all pass (Go `-race`, 9 unit, e2e).
- [ ] NOT done: install coturn on the VPS (needs sudo), forced-relay transfer, wrong-credential refusal, private-address refusal, speed limit, behaviour when credentials expire mid-transfer, provider firewall ports. Nothing relay-related runs in production until `install-turn.sh` is run.
- Overshoot: running sessions are only counted when they end; worst case is bounded by 10 sessions x 3 MB/s x 3 h, far above what real use will reach.

# Cross-network result
- [x] User reported a transfer between two devices on different networks works with STUN only (no relay). Decision: do not install coturn for now; `install-turn.sh` stays opt-in for later if real users report "Couldn't connect the two devices". (Which exact devices/networks were used was not recorded.)

# QR code
- [x] Invite link also shown as a QR code (`web/src/qr.ts`, dependency `qrcode-generator`, drawn as SVG elements). Hidden once the other person joins or the room expires.
- [x] Checked in Chromium: the rendered QR (desktop light and 360 px dark) decodes with an independent decoder (jsQR) to exactly the invite link; no sideways scroll; hidden after pairing. e2e, unit and build pass; `npm audit` clean.
- Not checked: scanning with a real phone camera; the live site under its CSP (SVG built with DOM attributes, which style-src does not block); needs `deploy/deploy.sh` to go live.

# plan_2.md, step 1: server `rejoin` (done)
- [x] `Hub.Rejoin(id, p)`: get-or-create keyed `"r:" + id`; shares the join checks (`room-full`, `expired`) via `joinLocked`; same `maxRooms` cap. The server keeps no memory of past rooms.
- [x] `Join` refuses tokens starting with `r:`, so rejoin rooms can't be entered with an invite path; `Rejoin` can't reach invite rooms because of the prefix.
- [x] `rejoin` message: first arrival gets `created` (no token echoed), second gets `joined` and the first `peer-joined`, with relay credentials as for `join` (shared `announcePaired`). Ids must be 26 base32 characters, else `invalid-token`.
- [x] Tests: both arrival orders, third peer `room-full`, 10 bad ids including `../`, invite token unreachable and vice versa, already-in-room, unpaired room expires via Sweep, server busy at the cap, 50 concurrent arrivals give exactly one creator and one joiner, WebSocket flow including offer relay. `go test -race -count=5` passes.
- Not changed yet: nothing in the browser uses `rejoin` (steps 2-3), so production behaviour is unchanged until the client lands.

# plan_2.md: Direct resume and Stored mode (built, tested locally, NOT deployed)

## Direct mode with resume (steps 1-3)
- [x] Server `rejoin` (commit fff39be).
- [x] `transfer.ts`: `start` offsets on sender and receiver, `receiver.flush()`, `newTransferId`, `fingerprint`, `parseMeta` with `id`/`fp`, `parseResume`, `parseResumeAt`.
- [x] `sinks.ts`: closed 64 MiB OPFS parts (`opfsPartsSink`, `openParts`, `partsOffset`, `discardParts`), sorted by number; `cleanOpfs` removes `resume-*` folders by newest part; `chooseSink` tries parts first (needs OPFS with `createWritable`, file fits twice in the quota), then the picker, then single-file OPFS, then memory.
- [x] `peer.ts`: events from a closed peer are ignored.
- [x] `main.ts`: `paused` state, one pause per drop, automatic `rejoin` with retries, `resume` / `resume-at` handshake, record in localStorage (validated on read), "Unfinished transfer" prompt with Resume/Discard, `beforeunload` guard for paused, Cancel while paused leaves the room.
- Bugs the tests found and fixed: a send on a dead channel was treated as a failed transfer (now a pause), and an in-flight send throwing right after a pause aborted it (now ignored while paused).
- Behaviour change: on desktop Chrome, files now go to Downloads via OPFS parts with no "Save as" dialog (so a tab close can be survived). The picker is still the fallback when the file doesn't fit the quota.

## Stored mode (steps 6-7, off unless `STORE_GB` and `STORE_KEY` are set)
- [x] `server/store.go`: create/put/finish/delete/meta/get chunk; passcode and write token compared in constant time; ids and chunk numbers validated before any path is built; 8 MiB chunk cap; reservation checked at upload; total cap; free-disk floor rechecked per chunk; unfinished uploads expire after 1 h, finished after 24 h; download cap of 3x size; state rebuilt from disk at start; per-request deadlines; nothing logged.
- [x] `budget.go`/`main.go`: the budget now runs for the relay or Stored mode, with `Budget.Add` and a shared `save()`. Uploads and downloads both count.
- [x] `store.ts`/`stored.ts`/`index.html`: AES-256-GCM per chunk in the browser, key only in the `#s/<id>.<key>` fragment, IV from the position, chunk index and total authenticated, retries resend the same encrypted buffer, name encrypted, download decrypts into the existing sinks, delete button, QR for the link, wrong key / tampering / expiry messages.
- [x] `deploy/nginx-streamdrop.conf`: `/store` with a 9 MiB body limit and no buffering; `vite.config.ts` proxies `/store`; `install-turn.sh` now appends to `/etc/streamdrop/env` instead of overwriting it.
- Stored settings (`/etc/streamdrop/env`): `STORE_GB`, `STORE_KEY`, optional `STORE_FLOOR_GB` (default 3), `RELAY_BUDGET_GB` (default 600).

## Tests (all passing)
- Go `-race -count=3`: hub rejoin (both orders, third peer, bad ids, separation from invite tokens, concurrency), Stored mode (wrong passcode/token, bad ids and chunk numbers incl. `../`, oversized chunks, total cap, disk floor, unfinished invisible, expiry, restart, download limit, budget stops reads and writes, concurrent uploads), `Budget.Add` restart and monthly rollover.
- Unit (27): resume offsets, fingerprint, id and message validation, part sort order with 120 parts, encrypt/decrypt round trip, tampered / swapped / reordered / truncated chunks fail, wrong key fails, name hidden and validated, link parsing.
- e2e (16, Chromium): direct transfer; resume after a dropped channel, receiver reload at 50%, sender reload at 50%, wrong file refused, server restart while paused, cancel while paused (partial file and record removed); Stored round trips (non-multiple of 8 MiB, zero bytes, exactly one chunk) with the sender closed, no plaintext or file name on disk, wrong passcode, delete, tampered chunk detected and nothing saved, wrong key.
- 2 GiB on OPFS parts: sha256 matches, 47 MiB/s in 44 s (baseline 36 MiB/s); 1 second of 41 below 5 MiB/s.

## Not done / not verified
- Nothing deployed: run `deploy/deploy.sh` for resume to go live. Stored mode also needs the env settings, a redeploy for the nginx rule, and a decision on Cloudflare's terms for large files.
- A real network cut (simulated with a closed data channel), a real browser crash, the real save picker, Firefox, Safari (the `createWritable` check should send Safari to the next option, untested), phones.
- Stored mode through the real tunnel (500 MiB), `df` after expiry on the VPS, and other sites' status after enabling it.
- Running Stored uploads are counted as bytes arrive, but a single finished-file budget overshoot is bounded only by chunks in flight.
- Whole-file hashing is not used: a middle-of-file edit that keeps size and timestamp would not be noticed on resume.

# New UI from Claude Design (integrated, tested, NOT deployed)
- [x] The designer's `index.html` and `style.css` (root, untracked) were moved into `web/index.html` and `web/src/style.css`; the old versions are in git history.
- Wiring fixed so the design works with the real script (the mockup was static):
  - added the app `<script type="module">` and removed the `<link>` (the CSS is imported by `main.ts`, so Vite emits the link on build)
  - added the missing `#resume-file` input inside `#unfinished-sender` (without it the script crashed at startup)
  - `#progress-text` renamed to `#pct`; `#dl-button` starts `hidden`
  - removed the sample text (file names, links, token, progress numbers) the script would otherwise leave on screen; token placeholder now "Paste your room token"
  - new `web/src/ui.ts`: `setStatus` sets the `data-state` that colours the status dot, `showError` toggles the banner's `hidden`, `flashCopied` keeps the Copy button's icon and swaps it to a tick
  - progress bar gets `is-frozen` while reconnecting; transfer card shows the file name; the invite card hides once the other person joins; Stored expiry reads "Available until …"
  - a failed Stored link now hides the empty download card (the error and "Start a new transfer" remain)
  - `hashchange` reloads the page, so pasting an invite link into a tab that already has the site open works
- **The CSS tokens are stand-ins** (shadcn-style neutral palette): the designer's header says the design system files were not reachable. Swap the three token blocks at the top of `web/src/style.css` for the real values; nothing below them needs editing.
- Verified: all 16 e2e, 27 unit and Go tests pass; no sideways scroll in 30 renders (phone dark and light, desktop light; 255-character file name, Stored pages, error, reconnecting); screenshots inspected; full transfer and download under the production CSP with zero violations and the stylesheet applied.
- Not verified: a screen reader; Firefox and Safari rendering (the CSS uses oklch, container queries, `field-sizing` and `content: … / ""`, so very old browsers will look plainer); the real design system.

# Redesign: connect once, then either device can send and receive (built, tested, NOT deployed)
Chosen with the user: pair by link, QR or code (no same-network discovery, for privacy); both devices get the same screen; send several files at once. Complaints addressed: unclear who sends and who receives, clutter, no progress or history.

## What changed
- **Protocol:** every file has its own id on the wire. Control messages carry it and data chunks start with the 26-character id, so several transfers share one DataChannel and both devices can send at once. Offers must carry `id` and `fp`; an optional `batch` ties files picked together so "Accept all" covers the batch.
- **`web/src/transfers.ts` (new):** the engine for every file, either direction, with no page code. One outgoing file streams at a time; incoming ones can arrive meanwhile. Handles offer, accept, decline, cancel, pause with exact offsets, resume, reconnect re-announcements, and validation of everything the other side sends. 20 unit tests wire two engines together in memory.
- **`web/src/connection.ts` (new):** signaling socket, WebRTC peer, a shared secret (`session`) exchanged over the encrypted channel and used to rejoin, and automatic retry. Nobody else can slip into a reconnecting pair.
- **Page:** home (one card: Connect a device, join with a code, collapsed "Leave a file for later") -> pairing (QR, link, code) -> one connected screen (session bar, drop zone, "N files are waiting for you" with Accept all / Decline all, activity list with direction icon, name, size, state, progress, speed, time left, per-file Accept / Decline / Cancel, history, Clear finished). Folders are refused with a message. After the other device leaves, one message and the history stays.
- Resume after a page reload now covers several files per session (receiving: Resume; sending: choose the same files, matched by size and fingerprint).

## Bugs found and fixed by the tests along the way
- A send on a closing channel was read as a failed file instead of a lost connection (isOpen now checks the channel's real state).
- A server "peer-left" arriving while the receiver was still saving its offset threw the session away, leaving nothing to reconnect to. About 1 run in 10 hung before the fix; 30 in a row pass after it.
- Discarding a partial file could fail silently if a part was mid-close (now retries and refuses late writes).

## Verification
- Go `-race`, 45 unit tests, 25 end-to-end tests in Chromium, `npm audit` clean.
- e2e covers: both directions, both at once, several files with Accept all, decline, cancel mid-way, drag and drop, Disconnect, used link, bad code; resume after a dropped channel, either device reloading, a different file refused, server restart while paused, Disconnect while paused removing the partial file; Stored mode.
- Screens rendered at 360 px (dark) and desktop (light) in every state, inspected by eye, no sideways scroll.

## Not verified
- Not deployed: run `deploy/deploy.sh`.
- Real phones, Firefox, Safari; a real network cut; the real save picker; a screen reader.
- Older pages already open in a browser speak the old protocol and won't interoperate with the new one until reloaded.
- Files that were only offered or waiting their turn are not kept across a reload, only ones that had started.
