# Prompt: plan the complete StreamDrop architecture

You are the lead architect for StreamDrop. Produce one complete, buildable architecture and delivery plan for the whole product: website, desktop app, Android app and server. **Plan only. Do not change code, push, deploy or touch the VPS.**

The repo is at `/home/galib/projects/StreamDrop` (private GitHub repo `ssgalib/StreamDrop`, branch `master`). Everything below was checked against the code and real test runs on 2026-11-06, unless marked otherwise. Where this prompt and the code disagree, trust the code and say so.

Read these first, in this order:

1. `docs/protocol.md`: the wire protocol, and the source of truth.
2. `track.md`: the honest log of what was built, tested and left unverified. Read the last four sections closely.
3. `plan_3.md`: the previous plan. Its research still stands, but this prompt lists where it was wrong.
4. `README.md`, then the code: `server/`, `web/src/`, `desktop/`, `android/`.

---

## 1. The product

StreamDrop sends files directly between two devices over WebRTC. Files are not stored on a server. A small Go server only introduces the devices.

**The goal:** pair two devices once, then send files between them whenever both are on, in either direction, with no link and no account. The website stays as the zero-install way to do a one-off transfer.

**What it must feel like:** simpler than a messaging app. One obvious action per screen. Both devices see the same thing. Nobody has to know which device is "the sender".

**Hard requirements:**

- Files up to 20 GiB, with memory use that does not grow with file size.
- Either device can send and receive at the same time, with many files at once.
- Transfers survive dropped connections and restarts, and continue from where they stopped.
- The server and Cloudflare must not be able to read files or impersonate a device on app-to-app connections.
- No accounts, no database, no tracking.
- Platforms: browser, Windows, macOS, Linux, Android. iOS is out of scope unless you argue otherwise.

---

## 2. Current state

### Built and committed locally

| Part | State |
|---|---|
| Go server | Rooms, `rejoin`, `listen`/`ring`, 45 s ping, `app://streamdrop` origin. Optional Stored mode and TURN credentials, both off. |
| Website | Pair by link, QR or code. Either-way transfers, many files, activity list, resume. Verified pairing through a key after `#` in the link. |
| Desktop (`desktop/`) | Electron with the UI bundled. Saved devices, listener, folders with structure, always accept, tray, autostart, notifications, resume after being killed. Linux only so far. |
| Android (`android/`) | **A throwaway spike, not an app.** `Auth.kt` (crypto and auth gate) is real and stays. `SpikeService.kt` is adb-driven: no UI, no resume, no reconnect. |

### Measured

| Test | Result |
|---|---|
| Pixel 7a, Android 17, home Wi-Fi, to the phone | 2 GiB intact, 18.3 MiB/s |
| Same, from the phone | 2 GiB intact, 12.0 MiB/s |
| Phone process memory during those runs | Peak 153 MiB |
| Real Files picker opens mid-transfer, then screen goes off, connection held in a foreground service | 512 MiB intact, no drop |
| Phone on LTE with Wi-Fi off, to a laptop on home broadband, STUN only | 8 MiB intact, 0.3 MiB/s |
| Both desktop apps SIGKILLed during a 300 MiB transfer | Both restarted, reconnected and finished alone, sha256 matches |
| New pages against a real build of the previous version | Works both ways with a typed code or an old link |

Automated tests at the last run: Go with `-race`; 78 web unit; 17 desktop file; 12 Electron e2e; 38 web e2e; 11 Kotlin vector tests; Android-to-browser tests in `web/e2e/android.spec.ts`.

### Not verified. Do not assume these work

- **Deploy state:** confirm what is live. The desktop app cannot work against production until this server version is deployed.
- **Windows and macOS:** never run. That covers `safeStorage`, `Zone.Identifier`, login items and packaging.
- **Keyrings:** the machine used has none, so sealing and unsealing keys has **never executed**. Only the refusal path ran.
- **Desktop:** the tray, real notifications and the real folder dialog (stubbed in tests). The `.deb` failed to build here (`fpm` exit 127, cause unconfirmed).
- **Network:** a Wi-Fi to mobile data switch mid-transfer, other carriers, other routers, and whether a ping every 45 s keeps a socket open through the Cloudflare Tunnel. The LTE result is one carrier, one router and one speed sample, with the bottleneck unknown.
- **Android:** battery drain, Doze, phones from makers that kill services aggressively, and limits on long `dataSync` runs on Android 17.
- **Scale:** a real 20 GiB transfer on any path.
- **Browsers:** Firefox and Safari. Also screen readers, on every platform.
- **Security:** the design has had **no outside review**. Do not call it audited.

### Where `plan_3.md` was wrong or has changed

- `listen`: both devices of a pair use the same id, so the server keeps the latest 4 sockets per id and rings all of them. Clients ignore rings for their own room. The 5 s ring limit is per socket.
- `created` carries `listeners:n`, not `listening:true`. The caller's own listener is included, so a client that listens compares with 1.
- A failed proof always closes the connection. It never falls back to "Temporary".
- `caps` describes this connection: `pair` or `saved` only if the device holds that key, plus `save` if it can keep a saved connection. `rel` is not a cap.
- The desktop keeps its resume record in a file through the main process, because `localStorage` loses recent writes on SIGKILL.
- Native clients must start the auth gate on the first message. libwebrtc can deliver buffered messages before the OPEN event.
- `safeStorage` must use the async API. The sync one is deprecated in Electron 45.
- TURN is not needed on this one carrier. That is not proof for others.

---

## 3. Architecture as built

```
Electron app            Android app (to build)        Browser
bundled web UI          Compose UI                    same web UI
same TS engine          Kotlin engine port            same TS engine
fs sink, safeStorage    Service, MediaStore, Keystore OPFS, ad hoc only
       |                        |                        |
       +--- WSS: create/join/rejoin/listen/ring/offer/answer/candidate
                                v
        Cloudflare Tunnel -> nginx -> Go server (rooms, listeners; memory only)

Files: device <-> device over one DTLS DataChannel. Direct when possible.
```

Three layers, one spec:

- **Signaling** (WebSocket `/ws`): how devices find each other.
- **Authentication** (`web/src/auth.ts`, `Auth.kt`): `hello`, then `auth-n` and `auth-p`, an HMAC over both DTLS fingerprints and both nonces. Nothing reaches the engine until it passes.
- **Transfer** (`web/src/transfers.ts`, `transfer.ts`): per-file ids, 64 KiB frames, a 16 MiB window, `ack`, `resume`, `resume-at`.

**Trust model.** The invite key `P` sits after `#`, so the server never sees it. Saving a device derives one 256-bit secret `K` per pair, from which come a `roomId` (the server may see it) and a proof key `KA` (it never does). `docs/vectors.json` is generated independently with Python's standard library, and every client must pass it.

**A saved transfer:** the app holds one idle socket with `listen`. The caller sends `rejoin{roomId}`, the server sends `ring`, and the other device opens a new socket and `rejoin`s. WebRTC connects, both prove `KA`, and the engine starts. After 2 idle minutes the connection closes and the pair stays.

Key files: `server/hub.go`, `server/signal.go`, `web/src/connection.ts`, `web/src/auth.ts`, `web/src/saved.ts`, `web/src/transfers.ts`, `web/src/app.ts` (app-only behaviour), `desktop/main.js`, `desktop/files.js`, `android/app/src/main/java/xyz/kurohane/streamdrop/Auth.kt`.

---

## 4. What the plan must cover

### Android app (the largest remaining piece)

Native Kotlin, Compose and libwebrtc (`io.github.webrtc-sdk:android:150.7871.04`, third-party, to be kept updated). Measurements support this choice; challenge it only with evidence.

- A foreground service owns the socket, peer and engine. Activities only draw state.
- Full engine port with the two-engine tests as a conformance suite: offers, batches, accept, decline, cancel, pause, resume, flow control, reconnect.
- Reconnect after network changes, first and foremost. Wi-Fi to mobile data must not kill a transfer.
- Reading through SAF `content://` URIs, including non-seekable sources and unknown sizes.
- Saving to `MediaStore.Downloads` under `Download/StreamDrop`, with `IS_PENDING`. Plan for pending items expiring.
- Resume after process death: an atomic JSON record, `fsync` every 64 MiB, truncate to the durable offset.
- Share sheet (`ACTION_SEND`, `ACTION_SEND_MULTIPLE`) to a saved device list.
- QR scanner, "Show my code", pairing, Keystore-wrapped `K`, no backups of `K`.
- Name and path checks from `docs/vectors.json` (`names`, `rels`).
- Notifications, including the case where `POST_NOTIFICATIONS` is refused.
- Reachability: opening the app picks up a waiting transfer. Decide whether an opt-in "Stay reachable" or FCM belongs in scope, using `plan_3.md` section 4.

### Desktop

Finish Windows and macOS, real keyring testing, tray behaviour across desktops, signing, packaging, and an update strategy. Automatic updates do not exist yet. Say how a security fix reaches users.

### Website

Decide its long-term role. Should it get saved connections? What should it say to invite people to the apps? Stored mode stays off until Cloudflare's terms for large files through a Tunnel are checked.

### Server and operations

Deployment order and compatibility across versions, Cloudflare keepalive, monitoring without logging tokens, abuse limits for `listen`, and when to install TURN. Budget: the VPS has 1 TB/month shared with other sites, and StreamDrop gets 600 GB. Each relayed byte counts twice.

### Multi-device

v1 allows one peer at a time. Say what changes for several peers, and whether a per-device keypair ever becomes worthwhile.

### Testing

One scenario suite across browser, desktop and Android, every ordered pair of platforms. Include network cuts, process kills, Doze, hostile input, an old build against a new one, and a 20 GiB run. Separate what can run on an emulator from what needs real hardware.

### Distribution

Windows Store or signing, macOS notarisation, Android APK versus Play, developer verification rollout, and protecting the signing keys. `plan_3.md` has the research; recheck dates and prices.

### Security

Threat model updated for all of the above, with what is not protected stated plainly. Metadata is visible to the server and Cloudflare. Browsers are not protected from a malicious server, because it serves their code. Plan the outside review of the authentication design before any public release.

---

## 5. UI/UX design system

Treat this as the design of record. The source is `web/index.html` and `web/src/style.css`.

**Colour tokens are stand-ins.** They use the shadcn/ui naming and neutral palette because the real design system files were never available. Every style reads only these tokens, so the real values can be swapped in the three token blocks at the top of `style.css`. Keep the token layer on every platform, and ask whether real brand values exist.

### Principles

1. **One thing to do per screen.** Home offers connecting. The connected screen offers sending.
2. **Symmetry.** Both devices show the same screen. There is no sender mode or receiver mode.
3. **Plain language.** No jargon: never "peer", "WebRTC", "ICE" or "session" on screen. Say what happened and what to do next.
4. **Honest states.** Show "Reconnecting…", never a fake success. Say "Temporary connection" when something is not verified.
5. **Quiet by default.** Optional features start collapsed or hidden. Status text appears only when there is something to say.
6. **History stays.** Rows remain after finishing, until the person clears them. A disconnect keeps history visible.
7. **Monochrome with meaning.** Neutral greys carry the layout. Colour is reserved for success, errors and focus.

### Colour tokens

Hex values are computed from the OKLCH source, for native use. `border` in dark mode is `oklch(1 0 0 / 14%)`: white at 14% opacity. Shadow is `0 1px 2px oklch(0 0 0 / 0.06)` in light mode and none in dark mode.

| Token | Light OKLCH | Light hex | Dark OKLCH | Dark hex |
|---|---|---|---|---|
| background | 1 0 0 | #FFFFFF | 0.145 0 0 | #0A0A0A |
| foreground | 0.145 0 0 | #0A0A0A | 0.985 0 0 | #FAFAFA |
| card | 1 0 0 | #FFFFFF | 0.205 0 0 | #171717 |
| card-foreground | 0.145 0 0 | #0A0A0A | 0.985 0 0 | #FAFAFA |
| primary | 0.205 0 0 | #171717 | 0.922 0 0 | #E5E5E5 |
| primary-hover | 0.31 0 0 | #303030 | 0.84 0 0 | #CACACA |
| primary-foreground | 0.985 0 0 | #FAFAFA | 0.205 0 0 | #171717 |
| secondary | 0.97 0 0 | #F5F5F5 | 0.269 0 0 | #262626 |
| secondary-foreground | 0.205 0 0 | #171717 | 0.985 0 0 | #FAFAFA |
| muted | 0.97 0 0 | #F5F5F5 | 0.269 0 0 | #262626 |
| muted-foreground | 0.45 0 0 | #555555 | 0.72 0 0 | #A4A4A4 |
| accent | 0.95 0 0 | #EEEEEE | 0.31 0 0 | #303030 |
| accent-foreground | 0.205 0 0 | #171717 | 0.985 0 0 | #FAFAFA |
| destructive | 0.5 0.2 27 | #BB0916 | 0.72 0.17 22 | #FD7273 |
| destructive-foreground | 0.985 0 0 | #FAFAFA | 0.145 0 0 | #0A0A0A |
| destructive-subtle | 0.97 0.02 20 | #FFF0EF | 0.26 0.05 22 | #391919 |
| success | 0.45 0.13 150 | #00682A | 0.78 0.15 150 | #67D283 |
| border | 0.922 0 0 | #E5E5E5 | white at 14% | n/a |
| input | 0.62 0 0 | #868686 | 0.58 0 0 | #7A7A7A |
| ring | 0.52 0.19 258 | #0462D3 | 0.72 0.14 258 | #6BA5FB |

Theme follows the system (`prefers-color-scheme`), and `data-theme` can force either.

### Type, spacing, shape

- **Fonts:** system stack only, no web fonts. Sans: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. Mono: `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`, used for the code.
- **Sizes:** sm 0.875rem, base 1rem, lg 1.125rem, xl 1.375rem. Secondary text is 0.9375rem. Line height 1.5, titles 1.3.
- **Weights:** 400 body, 500 buttons, 600 titles, file names and the peer line.
- **Numbers that change** (progress, speed) use tabular figures, so they do not jitter.
- **Spacing:** 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2rem (`space-1` to `space-8`, with no 7).
- **Radius:** sm 0.375rem, default 0.625rem, lg 0.875rem. Progress bars are fully rounded.
- **Touch target:** 2.75rem (44px) minimum. Small buttons are 2.25rem high.
- **Layout:** one column, max width 40rem, centred. Container query at 40rem: page padding grows from `space-2 space-4` to `space-6`, cards from `space-5` to `space-6`. Must work at 360px with no sideways scroll, including 255-character file names (`overflow-wrap: anywhere`).

### Components

| Component | Specification |
|---|---|
| Card | `card` background, 1px `border`, radius lg, `shadow`. Title lg/600, description 0.9375rem in `muted-foreground`. |
| Button | Primary: `primary` fill. Outline: border with `accent` on hover. Danger: destructive outline with `destructive-subtle` on hover. Radius default, 0.15 s colour transition. `btn-block` is full width. Disabled is 50% opacity. |
| Copy button | Label swaps to a green "Copied" with a tick for 2 s, keeping its icon position. |
| Alert | `destructive-subtle` background, 1px `destructive` border, weight 500, `role="alert"`, hidden when empty. |
| Status line | Coloured dot and text, `role="status"`. Dot states: wait, active, ok, paused, done. Hidden visually on the connected screen, but still announced. |
| Session bar | Peer dot and "Connected to …", with Disconnect on the right. Dot: solid `success` when open, hollow pulsing ring when reconnecting, `muted-foreground` when ended. |
| Dropzone | 2px dashed `input` border, radius lg, large padding, centred upload icon. The whole area is one label, so any click opens the picker. Hover or drag-over uses `accent` with a `foreground` border. |
| Bulk bar | `muted` panel: "N files are waiting for you" with Accept all and Decline all. Shows from 2 waiting files. `aria-live="polite"`. Also used for "Save this device?". |
| Activity row | Round 2.25rem direction icon, file name (600), detail line (sm, tabular), progress bar, actions. Sending uses a `primary` circle and receiving a `muted` circle, plus the words, so direction never relies on colour alone. Actions go below at narrow widths and to the right from 40rem. |
| Row colours | Done: detail in `success`. Failed: detail in `destructive`. Declined or cancelled: 75% opacity. Paused: bar at 55% opacity. |
| Progress | 0.75rem high, rounded, `primary` value on `muted`. Frozen state is a diagonal stripe, not an animation. |
| QR frame | QR drawn as SVG, always on a light frame so it scans in dark mode. |
| Note | `muted` panel, sm text, shown only while files are moving. |
| Saved device row | Name (600), Connect (primary), Rename, Remove, and an "Always accept files up to 2 GiB" checkbox below. |

Icons: seven line icons in a 24px grid, 2px stroke, round caps: copy, check, download, upload, refresh, trash, x. No images, and no external assets.

### Screens and states

1. **Home.** Brand, tagline ("Send files straight between two devices. Nothing is stored on a server."), Saved devices (apps only), a card with **Connect a device**, "Have a code?" with a field and Join, "Leave a file for later" (collapsed, only if the server enables it), and Settings (apps only).
2. **Pairing.** QR, invite link with Copy, "Or enter this code:". Cancel. When expired: "This link has expired" and **Create New Link**.
3. **Connected, the same on both devices.** Session bar, optional Temporary note, Save offer, dropzone, Send a folder (apps), bulk bar, Activity list with Clear finished, and the moving-files note. Empty state: "Files you send or receive show up here."
4. **Ended.** "The other device disconnected." with **Start a new connection**. History stays.
5. **Unfinished transfers** after a browser reload, with Resume or Discard. Apps resume alone.
6. **Stored download page**, when Stored mode is on.

Row detail text, by state:

| State | Sending | Receiving |
|---|---|---|
| offered | Waiting for the other device to accept | Wants to send you this file (Accept, Decline) |
| waiting | Accepted, waiting for its turn | Starting… |
| active | Sending · 42% · 1.2 GiB of 3 GiB · 18 MiB/s · 2 min left | Receiving · same |
| paused | Reconnecting… | Reconnecting… |
| done | Sent | Received |
| other | Declined, Cancelled, or the reason it failed | same |

### Voice

Short sentences. Name the action and the next step. Examples from the product: "This link has already been used." "Couldn't verify the other device, so the connection was closed." "Not connected right now. Wait for it to reconnect, then try again." "Update StreamDrop on the other device."

### Accessibility and motion

- Visible 2px `ring` focus with a 2px offset.
- Text colours chosen to stay readable in both themes. Recheck contrast if tokens change.
- Status and errors are announced. Offers are announced politely.
- Never rely on colour alone.
- Animation only under `prefers-reduced-motion: no-preference`.
- Peer text is always rendered as text, never as HTML.

### Platform mapping to specify

- **Desktop:** reuses the web UI directly. 520 x 760 window by default.
- **Android:** native Compose, so define a token and component mapping that keeps this system. Do not default to stock Material colours. Say what becomes native: the system picker and share sheet instead of a dropzone, a bottom action, notifications with Accept and Decline, a camera QR scanner, edge-to-edge insets, predictive back, and dynamic font size. Dropzone wording must change ("Drop files" means nothing on a phone).
- **Gaps to design:** first-run onboarding, the saved-device flow on phones, settings, transfer detail, permission refusal, offline and server-unreachable states, and an app-update prompt.

---

## 6. Constraints

- **Team:** one person plus coding agents. Prefer the smallest design that fully works. Reuse before adding.
- **Hosting:** Ubuntu 24.04 VPS, 2 vCPU, 3.8 GiB RAM. nginx on port 80 serves other sites. HTTPS comes from a Cloudflare Tunnel. Service `streamdrop` on `127.0.0.1:4310`.
- **Access:** deploy needs the owner's sudo password in a real terminal. Agents cannot deploy.
- **Dev machine:** CachyOS with Hyprland, no keyring. Android SDK, JDK 17, Go and Node 24 are installed. Disk is tight, `/tmp` is RAM-backed.
- **Test hardware:** Pixel 7a with USB debugging. No Mac or Windows machine is known to be available: ask.
- **Rules:** do not rewrite git history. Do not push or deploy unless asked. Never read or print the `.env` file.

### Traps already found

- Emulator virtual Wi-Fi loses beacons every few seconds: boot with `-feature -Wifi`.
- A throwaway Playwright profile has little quota, so large files reach a save dialog nobody can press.
- `pkill -f` with a pattern from your own command line kills your own shell.
- The `disconnected` state ends a browser's peer at once, then rejoins. Consider whether that is too eager on flaky networks.
- A 500-file batch shows up to 100 at a time, so "Decline all" only covers those listed so far.
- `org.json` loses key order, and `t` must be the first key.

---

## 7. Questions to resolve

Ask the owner only what you cannot settle from the repo. Give a recommended default for each, ranked by how much it changes the plan:

1. Must a phone receive while pocketed, with no tap?
2. Who is this for: the owner and friends, or the public?
3. Is a Mac available, and is $99 a year acceptable?
4. Will TURN be installed, given that one carrier worked without it?
5. Which country, and will the repo be public? This decides Windows signing.
6. Is Cloudflare seeing signaling metadata acceptable?
7. Should browsers get saved connections?
8. Is one peer at a time acceptable for the first release?
9. Do real design-system values exist to replace the stand-in tokens?

---

## 8. Deliverable

Write `plan_4.md` in the repo. Use plain, direct language: short sentences, and tables where they help. Mark every claim as **[code]**, **[measured]**, **[docs]** with a link, or **[unverified]**. Include:

1. The decisions, in one table, each with its main reason.
2. Whole-system architecture: components, boundaries, data flow, failure behaviour.
3. Protocol changes, if any, with the versioning impact on existing clients.
4. Per-platform architecture: modules, threading or process model, storage, background behaviour.
5. Security model and threats.
6. The UI/UX plan: screens, flows, state tables, and the Compose token and component mapping.
7. Test strategy and matrix.
8. Operations, deployment order and rollback.
9. Distribution and updates.
10. A milestone plan in dependency order, each with a concrete "done when" test and an effort estimate. Put the riskiest unknowns first.
11. What to cut first if time runs short, and what must never be cut.
12. Open questions and everything you could not verify.

Challenge anything here that you think is wrong, with reasons. Do not invent test results, and do not describe unverified behaviour as working.
