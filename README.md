# StreamDrop

Send a file directly from one browser to another. A small Go server only introduces the two browsers
(WebSocket signaling); the file travels over a WebRTC DataChannel and, in this default mode, is never
stored on the server. An optional second mode, **Stored**, keeps an encrypted copy on the server for
24 hours so the sender can leave (see "Stored mode" below). It is off unless you switch it on.

Live: https://streamdrop.kurohane.xyz (it can lag behind this repo)

## Status

An early personal project, not a finished product. The security design has had no outside review.

| Part | State |
|---|---|
| Website and Go server | Working. Tested in Chromium on Linux. |
| Desktop app (`desktop/`) | Working on Linux. No releases yet. Windows and macOS have never been run. |
| Android (`android/`) | A test client only, with no interface. There is no Android app to install yet. |

`track.md` is the full log of what was built, tested and left unverified. `docs/protocol.md` is the wire protocol.

## How it works

1. On one device click **Connect a device**. An invite link and a QR code appear.
2. On the other device open the link (or scan the code, or paste the code into "Have a code?").
3. Both devices now show the **same screen**: a drop zone and one activity list. **Either device can send
   and either can receive**, at the same time if you like.
4. Pick or drop one file or many. The other device sees each one as a row ("Wants to send you this file")
   and presses **Accept** (or **Accept all**). Rows show the direction, the file, progress, speed, time left,
   and stay as history until you clear them.

The invite works for joining for 10 minutes and for one other device. A connected pair stays together for as
long as the pages are open; **Disconnect** ends it.

If the connection drops mid-transfer, both pages keep what they have and reconnect on their own, and the
transfer continues from where the receiver stopped (see "Interruptions" below).

## Limits

- In direct mode both devices must keep the page open until the transfer ends. To hand a file over when
  the other device isn't there, use Stored mode ("Leave a file for later").
- Folders can't be sent: zip them first. Up to 500 files can be offered at once; one outgoing file streams
  at a time and the rest wait their turn, while an incoming file can arrive meanwhile.
- Connections try a direct path first, using a public STUN server (`stun.cloudflare.com`, set in
  `web/src/peer.ts`; it sees each browser's public IP, never the file). If no direct path works, an
  optional TURN relay on the VPS carries the file (see "Relay" below). Without the relay, browsers behind
  strict NATs (some mobile carriers, corporate Wi-Fi) can fail with "Couldn't connect the two devices".
- Where the received file goes depends on the browser. The first row that applies is used:
  | Browser support | Method | Size limit | Survives a tab close |
  |---|---|---|---|
  | Origin Private File System, file fits twice in the quota | 64 MiB parts, then a download | half the browser's storage quota | yes, except the open part |
  | `showSaveFilePicker` (Chrome, Edge on desktop) | written straight to the chosen file | disk space; 20 GiB cap | no |
  | neither | held in memory | 512 MiB | no |

  On desktop Chrome the first row usually applies, so files go to Downloads without a "Save as" dialog.
- Mobile browsers may suspend background tabs and stop a transfer.

### Interruptions

| What happens | Result |
|---|---|
| Connection drops, both tabs stay open | Resumes by itself, nothing lost |
| Server restarts or is deployed | Resumes by itself once it is back |
| Nothing is moving and the connection drops (a phone freezes the tab while you pick a file in the Files app) | Both devices reconnect by themselves and wait up to 5 minutes for each other |
| The phone kills the tab and you reopen it within 10 minutes | The page rejoins the pair by itself (the shared secret is kept in the browser) |
| One device presses **Disconnect** | The other is told at once and does not wait |
| The device receiving reloads or closes the tab (parts sink) | After a reload, click **Resume receiving**; loses at most the open 64 MiB part |
| The device sending reloads or closes the tab | After a reload, choose the same files again; nothing is lost on the receiving side |
| A different file chosen on resume | Refused ("Not the same file: name"); a fingerprint of the size, date and first and last MiB is compared |
| Receiver used the save picker or memory | Survives a drop with both tabs open, but not a reload |
| The other device never comes back | **Disconnect** discards the partial files; unfinished partial files are removed after 24 hours |

Files that were only offered or waiting their turn are not kept across a page reload; only files that had started are.

Tested: Chromium on Linux (Playwright; a 2 GiB transfer on the parts sink at 47 MiB/s; every row of the
interruptions table except a real network cut, which is simulated by closing the data channel).

The Android test client was also run against Chromium on a Pixel 7a (Android 17): 2 GiB each way over home
Wi-Fi at 12-18 MiB/s, a transfer that survived the file picker opening and the screen going off, and 8 MiB over
one mobile network with no relay.

Not tested: Firefox, Safari, Edge, Windows, macOS, iOS, phone browsers in automated tests, other phones and
carriers, a real 20 GiB transfer, screen readers, the real save picker.

### Who can read a file

An invite link and QR code carry a key after `#`, which the server never sees. Once connected, both devices prove
they hold it, over the fingerprints of the encrypted connection they really have. Someone in the middle, including
this server or Cloudflare, fails that proof and the connection is closed ("Couldn't verify the other device").
A **typed code** carries no key, so it works but isn't verified. In a browser this has a limit: the server also
delivers the page's code, so a malicious server could change that code. The desktop app bundles its code, so it
doesn't have that limit. See `docs/protocol.md`.

The server and Cloudflare can still see metadata: IP addresses, when devices are online, and which ones meet.
**This design is custom and has had no outside security review. Don't rely on it for anything high-risk.**

## Desktop app

`desktop/` is an Electron app (Linux tested; Windows and macOS configured but never run). It bundles the same page,
so the server can't change the code that handles your files. On top of the website it adds:

- **Saved devices.** After connecting by link or QR, tap **Save** on both apps. From then on, either one can press
  **Connect** with no link. The other app answers by itself if it is running, or as soon as it starts (up to 10 minutes).
  A saved connection closes after 2 idle minutes and reconnects when needed.
- Files go straight to a folder (default `Downloads/StreamDrop`), never overwrite anything, and a transfer survives
  either app being killed: both finish by themselves after a restart.
- **Send a folder** with its structure, no zip. Stays in the tray; optional start with the computer; notifications.
- **Always accept** per saved device, off by default, up to 2 GiB, into a subfolder named after that device.

Saving needs a real keyring. On Linux with none (no GNOME Keyring or KWallet), Electron's fallback is a hardcoded
password, so the app refuses to save and only one-off connections work. Removing a device takes effect at once;
for a lost device, remove it on every other device. There are no accounts and no automatic updates yet.

The app talks to the live server, which must run this version first: older servers refuse its origin and `listen`.

```bash
cd desktop && npm install
npm start               # builds the page and runs the app
npm test                # file handling and hostile names
npm run test:e2e        # real apps against a real Go server (windows stay hidden)
npm run dist            # AppImage and .deb into desktop/dist
```

## Android test client

`android/` proves the protocol works from native Android. It is driven by adb, with no interface, reconnect or
resume, and `SpikeService.kt` will be replaced. `Auth.kt` holds the real crypto and passes `docs/vectors.json`.

```bash
cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug   # needs JDK 17 and the Android SDK
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8080 tcp:8080                                       # on a phone; an emulator uses ws://10.0.2.2:8080/ws
cd ../web && ANDROID_SPIKE=ws://127.0.0.1:8080/ws npm run test:e2e -- android
```

On an emulator, boot with `-feature -Wifi`, because its virtual Wi-Fi drops the network every so often.
`ANDROID_PHONE=1` adds two tests that change the phone's state: they open the file picker, turn the screen off and
switch Wi-Fi off for a moment.

## Local development

Needs Go and Node.

```bash
cd server && go run .          # signaling on 127.0.0.1:8080
cd web && npm install && npm run dev   # http://localhost:5173, proxies /ws to the server
```

Checks:

```bash
cd server && go vet ./... && go test -race ./...
cd web && npm run build && npm test      # type-check + unit tests
cd web && npm run test:e2e               # either-way, resume and Stored tests (starts Vite and its own Go servers; port 8080 must be free)
CROSS_BROWSER=1 npm run test:e2e         # also Firefox/WebKit pairs (needs a working Playwright Firefox/WebKit)
OLD_DIST=<build of an old commit> npm run test:e2e -- oldpage   # new pages against an old page; see e2e/oldpage.spec.ts
```

Load test (run it against a local server, not production; it fakes client IPs with `X-Forwarded-For`):

```bash
cd server && go build -o /tmp/streamdrop . && (ulimit -n 20000; /tmp/streamdrop -addr 127.0.0.1:18080 &)
(ulimit -n 20000; go run ./loadtest -url ws://127.0.0.1:18080/ws -rooms 1000)
```

## Deployment

These steps describe the author's own server. To run your own, replace `streamdrop.kurohane.xyz` in `deploy/` and
the host `vps` in `deploy/deploy.sh`, and the default server address in `desktop/main.js`.

Production is: Cloudflare Tunnel -> nginx (static files + `/ws` proxy) -> Go binary under systemd.
Cloudflare provides HTTPS. There is no database and no `.env` is needed.

One-time on the VPS (needs sudo):

1. Add this rule above the final `http_status:404` rule in `/etc/cloudflared/config.yml`:
   ```yaml
   - hostname: streamdrop.kurohane.xyz
     service: http://127.0.0.1:80
   ```
   Restart `cloudflared` and run `cloudflared tunnel route dns <tunnel-id> streamdrop.kurohane.xyz`.
2. Turn off Cloudflare Web Analytics for this hostname, or the browser console shows a blocked script
   (the Content-Security-Policy refuses it).
3. SSH access as host `vps` with `rsync` available on both ends.

Deploy or update (builds locally, copies, runs `deploy/install.sh` under sudo):

```bash
deploy/deploy.sh
```

This installs `/opt/streamdrop/streamdrop` (systemd unit `streamdrop`, listens on `127.0.0.1:4310`),
the static site in `/var/www/streamdrop`, and the nginx server block `streamdrop.kurohane.xyz`.

## Relay (TURN), optional

Off by default. Direct transfers never touch the VPS, so they use no bandwidth. The relay carries
files only when a direct path is impossible, and every relayed byte counts twice against the VPS
allowance (in and out). The VPS plan allows 1 TB/month; StreamDrop is budgeted **600 GB/month**.

Enable it once, on the VPS (opens ports, so read `deploy/install-turn.sh` first):

```bash
rsync -a deploy/ vps:streamdrop-deploy/ && ssh -t vps 'sudo bash ~/streamdrop-deploy/install-turn.sh'
```

It installs coturn using the VPS's public IP (no DNS record needed), writes `/etc/streamdrop/env`
(`TURN_SECRET`, `TURN_HOST`, `RELAY_BUDGET_GB`), and restarts both services. Also open UDP 3478,
TCP 3478 and UDP 49160-49400 in any provider-level firewall.

How the budget works: coturn logs the bytes of every finished relay session; the Go server reads that
log, keeps a monthly total (UTC calendar month) in `/var/lib/streamdrop/relay-usage.json`, and stops
issuing relay credentials once the total reaches `RELAY_BUDGET_GB`. Browsers then use direct and STUN
paths only until next month. Sessions still running are counted when they end, so a long transfer can
overshoot a little; coturn's per-session speed limit (24 Mbit/s), 10-session cap and the 3-hour
credential life bound that. The provider's own panel is the source of truth, because it includes your
other sites; check it monthly.

Test the relay by opening the site with `?relay=1` on both sides (this forbids direct paths), and check
`sudo cat /var/lib/streamdrop/relay-usage.json` grows afterwards. Do not leave `?relay=1` in shared links.

## Stored mode, optional

Off by default. When on, the start page gets a collapsed **Leave a file for later** panel. The file is encrypted in the
sender's browser (AES-256-GCM, 8 MiB chunks, one fresh key per file), uploaded in chunks, and kept on the
VPS for 24 hours. The link `https://host/#s/<id>.<key>` carries the key after `#`, so the server holds
only ciphertext and an encrypted name. The server can't scan or inspect files, and a downloader's browser
decrypts each chunk into the same storage it uses for direct transfers.

| Setting (in `/etc/streamdrop/env`) | Meaning |
|---|---|
| `STORE_GB` | Turns Stored mode on; total space for stored files (5 suggested) |
| `STORE_KEY` | Passcode needed to upload; share it only with people you trust |
| `STORE_FLOOR_GB` | Free disk to always leave for your other sites (default 3) |
| `RELAY_BUDGET_GB` | Monthly byte budget shared with the relay (default 600) |

Limits: 2 GiB per file, 24 hours (1 hour for an unfinished upload), about 3 downloads per file, and the
budget above. Each stored byte is counted once when uploaded and once per download, so a file downloaded
once costs twice its size.

To switch it on, add `STORE_GB=5` and `STORE_KEY=<something long, e.g. from openssl rand -hex 16>` to
`/etc/streamdrop/env`, run `sudo systemctl restart streamdrop`, and redeploy once so nginx gets the
`/store` rule. **Before enabling it, check Cloudflare's terms:** serving large files through a Tunnel on
a free plan may break them, and this project could not find an official answer.

Files live in `/var/lib/streamdrop/files/<id>/`. To remove a reported file immediately:
`sudo rm -rf /var/lib/streamdrop/files/<id>`; the id is the part of the link after `#s/` and before the `.`.
Because files are encrypted you cannot see what they contain; the passcode is the control on who uploads.

## Operating it

```bash
sudo journalctl -u streamdrop -f        # the server logs only "listening"; tokens and SDP are never logged
sudo systemctl restart streamdrop       # running transfers are unaffected; only new rooms are cut for a moment
sudo journalctl -u coturn -f            # only if the relay is enabled
systemctl status streamdrop
sudo tail -f /var/log/nginx/access.log  # request lines only; the invite token is in the URL fragment
```

Limits in the server (`server/signal.go`, `server/hub.go`): 10 connections per IP, first message within
15 s, 256 messages per connection, 32 KiB per message, 1000 rooms, 2000 listening sockets of up to 32 ids.
Every socket is pinged every 45 s and closed if it doesn't answer within 15 s. The per-IP limit trusts
`X-Forwarded-For`, which nginx sets from Cloudflare's `CF-Connecting-IP`. The Go server must therefore
stay bound to `127.0.0.1`.

Nothing needs backing up: the app has no database, and stored files are temporary by design.

## Layout

```
server/            Go server (hub.go rooms and rejoin, signal.go handler and limits, store.go Stored mode, budget.go, loadtest/)
web/src/           main.ts the page, connection.ts signaling + WebRTC + rejoin, auth.ts proving who the other device is,
                   transfers.ts the engine (every file, either direction), transfer.ts chunking, flow control and framing, sinks.ts storage, peer.ts WebRTC,
                   qr.ts QR code, store.ts and stored.ts Stored mode,
                   saved.ts saved connections and the listener, app.ts what only the desktop app does
web/e2e/           Playwright tests: either-way transfers, resume (reloads, drops, server restart), Stored
deploy/            nginx config, systemd unit, deploy and install scripts, optional coturn setup (install-turn.sh)
android/           Kotlin test client: Auth.kt the protocol's crypto and gate, SpikeService.kt throwaway, driven by adb
desktop/           Electron app: main.js the shell, files.js everything touching disk, preload.js what the page may call
docs/              protocol.md the wire protocol, vectors.json test vectors for any client
plan.md, project-plan.md, plan_2.md, plan_3.md, track.md   plans and progress
```
