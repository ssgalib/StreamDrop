# StreamDrop

Send a file directly from one browser to another. A small Go server only introduces the two browsers
(WebSocket signaling); the file travels over a WebRTC DataChannel and is never stored on the server.

Live: https://streamdrop.kurohane.xyz

## How it works

1. The sender opens the site and clicks **Create Room**. An invite link `https://host/#token` appears, with a QR code of the same link.
2. The receiver opens the link (or scans the QR code with a phone camera) (the token after `#` never reaches the server) and both pages connect.
3. The sender picks a file, the receiver clicks **Accept**, and the bytes flow browser to browser.

The token works for joining for 10 minutes and for one receiver. Each room holds exactly two people.

## Limits

- Both people must keep the page open until the transfer ends. Nothing is stored for later.
- Connections try a direct path first, using a public STUN server (`stun.cloudflare.com`, set in
  `web/src/peer.ts`; it sees each browser's public IP, never the file). If no direct path works, an
  optional TURN relay on the VPS carries the file (see "Relay" below). Without the relay, browsers behind
  strict NATs (some mobile carriers, corporate Wi-Fi) can fail with "Couldn't connect the two devices".
- Where the received file goes depends on the browser:
  | Browser support | Method | Size limit |
  |---|---|---|
  | `showSaveFilePicker` (Chrome, Edge on desktop) | written straight to the chosen file | disk space; 20 GiB cap |
  | Origin Private File System | temp storage, then a download | about half the browser's storage quota |
  | neither | held in memory | 512 MiB |
- A dropped connection means starting the file again. There is no resume.
- Mobile browsers may suspend background tabs and stop a transfer.

Tested: Chromium on Linux (Playwright, plus a 2 GiB transfer to disk). Not tested: Firefox, Safari,
Edge, Windows, macOS, Android, iOS.

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
cd web && npm run test:e2e               # two browser pages transfer a file (starts both servers)
CROSS_BROWSER=1 npm run test:e2e         # also Firefox/WebKit pairs (needs a working Playwright Firefox/WebKit)
```

Load test (run it against a local server, not production; it fakes client IPs with `X-Forwarded-For`):

```bash
cd server && go build -o /tmp/streamdrop . && (ulimit -n 20000; /tmp/streamdrop -addr 127.0.0.1:18080 &)
(ulimit -n 20000; go run ./loadtest -url ws://127.0.0.1:18080/ws -rooms 1000)
```

## Deployment

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

## Operating it

```bash
sudo journalctl -u streamdrop -f        # the server logs only "listening"; tokens and SDP are never logged
sudo systemctl restart streamdrop       # running transfers are unaffected; only new rooms are cut for a moment
sudo journalctl -u coturn -f            # only if the relay is enabled
systemctl status streamdrop
sudo tail -f /var/log/nginx/access.log  # request lines only; the invite token is in the URL fragment
```

Limits in the server (`server/signal.go`, `server/hub.go`): 10 connections per IP, first message within
15 s, 256 messages per connection, 32 KiB per message, 1000 rooms. The per-IP limit trusts
`X-Forwarded-For`, which nginx sets from Cloudflare's `CF-Connecting-IP`. The Go server must therefore
stay bound to `127.0.0.1`.

Nothing needs backing up: the app has no database or stored files.

## Layout

```
server/            Go signaling server (hub.go rooms, signal.go handler and limits, loadtest/)
web/src/           main.ts page logic, peer.ts WebRTC, transfer.ts chunking and flow control, sinks.ts storage
web/e2e/           Playwright test
deploy/            nginx config, systemd unit, deploy and install scripts, optional coturn setup (install-turn.sh)
plan.md, project-plan.md, track.md   plans and progress
```
