# StreamDrop: Full Project Plan

## 1. Goal and current state

StreamDrop sends files directly from one browser to another, up to 20 GiB on browsers that can write to disk as data arrives. A small self-hosted server introduces the two browsers. File contents are never saved on the VPS.

**Stack:** Go + WebSocket signaling, TypeScript + Vite, WebRTC DataChannels, coturn, Caddy, Docker Compose.
**VPS:** 2 vCPU, 4 GB RAM, 25 GB NVMe.
**Rules:** no database, no React or other UI framework, small codebase.

Milestone 1 is finished and its detailed steps are in `plan.md`. This plan covers everything from there to a public release.

| # | Milestone | Result | Status |
|---|---|---|---|
| 1 | WebRTC connection | Two tabs exchange a message directly | Done, 2 manual checks left |
| 2 | File transfer | A file arrives intact, held in memory | To do |
| 3 | Large files | Up to 20 GiB written straight to disk | To do |
| 4 | Usable product | Invite link, progress, cancel, clear errors | To do |
| 5 | Production setup | Hardened server on the VPS behind HTTPS | To do |
| 6 | TURN fallback | Transfers work across strict networks | To do |
| 7 | Release | Browser testing, load testing, runbook | To do |

Finish each milestone's checks before starting the next one.

### What Milestone 1 left behind

Confirmed today: `go vet`, `go test -race` and `npm run build` all pass. These items are still open:

- [ ] **Run a real server-stop test.** `track.md` says this was only emulated. Open a connection, press Ctrl+C on the Go server, then send a message.
- [ ] **Run the expiry check in a browser.** It is currently covered by fake-clock tests only.
- [ ] **Run `go mod tidy` in `server/`.** `go.mod` wrongly marks `coder/websocket` as `// indirect`.
- [ ] **Fix the `peer-left` bug (Step 2.1).** Today a brief signaling drop on one side would kill a healthy transfer on the other.

---

## 2. Final architecture

```
                 ┌───────────── VPS ─────────────┐
 Browser A ─────►│ Caddy :443 ──► Go signaling   │◄───── Browser B
   │  page + /ws │  (HTTPS)      (rooms in RAM)  │  page + /ws
   │             │                               │
   │             │ coturn :3478 (fallback only)  │
   │             └──────▲─────────────▲──────────┘
   │                    └ relayed path┘
   └═════════════ direct WebRTC path (preferred) ═══════► Browser B
```

| Part | Job | Sees file contents? |
|---|---|---|
| Caddy | Serves the page, provides HTTPS, forwards `/ws` | No |
| Go signaling | Pairs browsers, relays SDP and ICE | No |
| coturn | Relays traffic when a direct path fails | Encrypted bytes only, held briefly in memory |
| Browsers | Read, send, receive and save the file | Yes |

WebRTC encrypts all DataChannel traffic between the browsers, so coturn can't read what it relays.

### Decisions for the whole project

| Decision | Choice | Why |
|---|---|---|
| Direction | Room creator sends, joiner receives | Matches the product and removes "both sent at once" cases. |
| Files per transfer | One file. Send another afterwards in the same room. | Folders and queues aren't needed yet, and users can zip first. |
| Chat box | Removed in Milestone 2 | It was a connection test. The channel now carries files. |
| Data format | JSON text for control, binary for file bytes | Control messages stay readable, and bytes avoid encoding overhead. |
| Chunk size | 64 KiB, capped by `pc.sctp.maxMessageSize` | Safe across browsers. |
| Flow control | Sender buffer limit **and** receiver acknowledgements | Without both, a fast sender can exhaust memory on either side. |
| Integrity check | Exact byte count | WebRTC already protects data in transit, and browsers have no streaming SHA-256 built in. |
| Interrupted transfers | Fail cleanly and start again | Resume adds a lot of code. Revisit it only if real use demands it. |
| Signaling after connect | Socket stays open, but losing it doesn't affect the transfer | Smallest fix, and server restarts don't interrupt transfers. |
| TURN credentials | Short-lived HMAC credentials, sent only once two peers are paired | No fixed password in the browser, and nothing is handed to unpaired visitors. |
| Frontend unit tests | `node --test` | Node 24 runs TypeScript directly, so no new dependency. |

---

## 3. Milestone 2: File transfer

**Goal:** the sender picks a file, the receiver accepts it, and an identical copy downloads. The file is held in memory for now.

### New concepts

| Term | Meaning |
|---|---|
| **Chunk** | A small piece of the file. We never load a whole large file at once. |
| **`bufferedAmount`** | Bytes the browser has queued but not sent. If it grows too large, the browser may close the channel. |
| **Backpressure** | Slowing the sender when something further along can't keep up. |
| **Sink** | The place received bytes go: memory now, disk in Milestone 3. |

### DataChannel protocol

| Message | Direction | Meaning |
|---|---|---|
| `{t:"meta", name, size, type}` | sender → receiver | "I want to send this" |
| `{t:"accept"}` | receiver → sender | Start sending |
| `{t:"reject", reason}` | receiver → sender | Declined, or the file is too large |
| binary chunk | sender → receiver | File bytes, in order |
| `{t:"ack", bytes}` | receiver → sender | Total bytes safely stored so far |
| `{t:"done"}` | sender → receiver | All bytes have been sent |
| `{t:"saved"}` | receiver → sender | File is complete |
| `{t:"cancel"}` | both ways | Stop and clean up |

The channel is ordered and reliable, so chunks need no numbering.

The sender shows "Complete" only after `saved` arrives. If it closed earlier, data still in the buffer could be lost.

### Step 2.1: Fix `peer-left`

The server sends `peer-left` when a peer's **WebSocket** drops, which doesn't mean the direct connection has failed. In `web/src/main.ts`:

```ts
case "peer-left":
  if (channelOpen) break; // the DataChannel reports its own failure
  peer?.close();
  setStatus("Peer left. Reload to start again.");
  break;
```

Then make the `closed` event show "Peer disconnected". Also treat `disconnected` and `failed` connection states as a lost peer during a transfer, because a crashed tab may never close its channel cleanly.

### Step 2.2: Update `web/src/peer.ts`

- Rename the channel from `"chat"` to `"file"`.
- In `useChannel`, set `dc.binaryType = "arraybuffer"` and `dc.bufferedAmountLowThreshold = LOW_WATER`.
- Change the `message` event to accept `string | ArrayBuffer`.
- Return the channel to the caller once it exists, and expose `maxMessageSize: () => pc.sctp?.maxMessageSize`.

### Step 2.3: Create `web/src/transfer.ts`

This file contains only transfer logic and no page code, so it can be tested without a browser. Don't import anything from `peer.ts` except with `import type`.

```ts
export const CHUNK = 64 * 1024;
export const HIGH_WATER = 4 * 1024 * 1024;
export const LOW_WATER = 1024 * 1024;
export const WINDOW = 16 * 1024 * 1024;   // max bytes sent but not yet stored
export const ACK_EVERY = 1024 * 1024;

type Channel = { bufferedAmount: number; send(data: string | ArrayBuffer): void };

export function createSender(
  file: Blob,
  ch: Channel,
  chunkSize: number,
  progress: (bytes: number) => void,
) {
  let acked = 0;
  let cancelled = false;
  let wake = () => {};

  return {
    wake: () => wake(),
    ack(bytes: number) { acked = bytes; wake(); },
    cancel() { cancelled = true; wake(); },
    async run() {
      let sent = 0;
      while (sent < file.size && !cancelled) {
        if (sent - acked >= WINDOW || ch.bufferedAmount > HIGH_WATER) {
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        // slice() reads only this piece, so a 20 GiB file never sits in memory.
        ch.send(await file.slice(sent, sent + chunkSize).arrayBuffer());
        sent = Math.min(sent + chunkSize, file.size);
        progress(sent);
      }
      if (!cancelled) ch.send(JSON.stringify({ t: "done" }));
    },
  };
}

export type Sink = {
  write(data: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};

export function createReceiver(
  size: number,
  sink: Sink,
  ch: Channel,
  progress: (bytes: number) => void,
  fail: (err: unknown) => void,
) {
  let arrived = 0, stored = 0, lastAck = 0;
  let queue = Promise.resolve(); // keeps writes in order

  return {
    chunk(data: ArrayBuffer) {
      arrived += data.byteLength;
      // A correct sender can't trigger either check, so this one is misbehaving.
      if (arrived > size || arrived - stored > 2 * WINDOW) {
        fail(new Error("Sender broke the protocol"));
        return;
      }
      queue = queue.then(async () => {
        await sink.write(data);
        stored += data.byteLength;
        progress(stored);
        if (stored - lastAck >= ACK_EVERY) {
          lastAck = stored;
          ch.send(JSON.stringify({ t: "ack", bytes: stored }));
        }
      }).catch(fail);
    },
    async done() {
      await queue;
      if (stored !== size) throw new Error("File is incomplete");
      await sink.close();
      ch.send(JSON.stringify({ t: "saved" }));
    },
  };
}
```

Wire these events in `main.ts`:

- `dc.onbufferedamountlow` → `sender.wake()`
- `ack` → `sender.ack(msg.bytes)`
- `cancel` → `sender.cancel()`, or `sink.abort()` on the receiving side

### Step 2.4: Add the memory sink

```ts
export function memorySink(name: string, type: string): Sink {
  const parts: ArrayBuffer[] = [];
  return {
    write: async (data) => { parts.push(data); },
    close: async () => downloadBlob(new Blob(parts, { type }), name),
    abort: async () => { parts.length = 0; },
  };
}
```

`downloadBlob` creates an `<a download>` link using `URL.createObjectURL`, clicks it, then revokes the URL after a delay.

### Step 2.5: Treat `meta` as untrusted

The other person controls every field. Before showing the accept prompt, confirm that:

- `name` is a non-empty string of at most 255 characters
- `size` is a non-negative safe integer no larger than `20 * 1024 ** 3`
- `type` is a string

Anything else ends the transfer. Show the name with `textContent` only. Replace a `type` the browser can't use with `application/octet-stream`. Binary data arriving before `accept` is a protocol error.

### Step 2.6: Change the page

Remove the chat form and log. Add:

- A file picker for the sender, shown before Create Room
- A prompt for the receiver: file name, size, Accept and Decline
- A `<progress>` bar with a text percentage

### Step 2.7: Tests

Create `web/src/transfer.test.ts` and add `"test": "node --test src/*.test.ts"` to `package.json`. Use a fake `Channel` and a fake `Sink`.

- [ ] A file whose size isn't a multiple of the chunk size arrives identical
- [ ] A zero-byte file finishes correctly
- [ ] The sender pauses at `WINDOW` and continues after `ack`
- [ ] The sender pauses at `HIGH_WATER` and continues after `wake`
- [ ] `cancel` stops the send loop, and `done` isn't sent
- [ ] More bytes than `size` calls `fail`
- [ ] `done()` with missing bytes throws
- [ ] A failing `sink.write` calls `fail`
- [ ] Each invalid `meta` field is rejected

### Done when

- [ ] Automated tests pass
- [ ] Empty, 1 KiB and 500 MiB files all match on both sides: `sha256sum original downloaded`
- [ ] Decline leaves the sender informed and able to retry
- [ ] Closing either tab mid-transfer shows an error on the other

---

## 4. Milestone 3: Large files

**Goal:** a 20 GiB file reaches disk with steady, low memory use.

Where the receiver's bytes go depends on the browser:

| Priority | Method | Available on | Limit |
|---|---|---|---|
| 1 | `showSaveFilePicker` | Chromium desktop browsers | 20 GiB |
| 2 | Origin Private File System (OPFS) | Most modern browsers | `navigator.storage.estimate()`, and needs about twice the file size when exporting |
| 3 | Memory sink | Everywhere | 512 MiB |

Check for features with code like `"showSaveFilePicker" in window`, never by browser name.

### Step 3.1: Create `web/src/sinks.ts`

Move `memorySink` here, then add:

```ts
export async function pickerSink(name: string): Promise<Sink> {
  const handle = await window.showSaveFilePicker({ suggestedName: name });
  const out = await handle.createWritable();
  return {
    write: (data) => out.write(data),
    close: () => out.close(),
    abort: () => out.abort(),
  };
}

export async function opfsSink(name: string, type: string): Promise<Sink> {
  const root = await navigator.storage.getDirectory();
  const tempName = crypto.randomUUID(); // never use the peer's file name as a path
  const handle = await root.getFileHandle(tempName, { create: true });
  const out = await handle.createWritable();
  return {
    write: (data) => out.write(data),
    async close() {
      await out.close();
      const file = await handle.getFile();
      downloadBlob(new Blob([file], { type }), name);
    },
    async abort() {
      await out.abort();
      await root.removeEntry(tempName);
    },
  };
}
```

You may need `@types/wicg-file-system-access` as a dev dependency for `showSaveFilePicker` types.

Three browser rules to follow:

1. `showSaveFilePicker` must be called directly from a click, so call it from the Accept button's handler, before any other `await`.
2. If the user cancels the picker, it throws `AbortError`. Treat that as staying on the prompt, not as a failure.
3. Chromium writes to a temporary `.crswap` file, and closing a huge file can take a while. Show "Finalizing..." until `close()` finishes. Don't send `saved` before then.

### Step 3.2: Choose a sink

```ts
async function chooseSink(meta: Meta): Promise<Sink> {
  if ("showSaveFilePicker" in window) return pickerSink(meta.name);
  const { quota = 0, usage = 0 } = await navigator.storage.estimate();
  if (meta.size * 2 < quota - usage) return opfsSink(meta.name, meta.type);
  if (meta.size <= MEMORY_LIMIT) return memorySink(meta.name, meta.type);
  throw new Error("This browser can't store a file this large. Try Chrome or Edge on a computer.");
}
```

On failure, send `reject` with the reason so the sender knows why.

### Step 3.3: Clean up OPFS

OPFS space isn't freed automatically, and we can't tell when a browser download finishes. On page load, delete OPFS files whose `lastModified` is over 24 hours old. Age is what protects a transfer running in another tab.

### Step 3.4: Handle storage failures

Catch `QuotaExceededError` and disk-full errors from `write`. Show "Not enough disk space", send `cancel`, and call `sink.abort()`. Abort must also run after cancel, peer loss, and any protocol failure, so no partial files stay behind.

### Step 3.5: Measure and tune

Log average MB/s for a 2 GiB localhost transfer. If reading is the bottleneck, read 1 MiB at a time and send it as 64 KiB pieces. Change this only if measurements call for it.

### Done when

- [ ] Chrome: 20 GiB transfer finishes and `sha256sum` matches
- [ ] Firefox: largest file allowed by its quota matches
- [ ] Memory stays flat through the transfer, with no steady growth in the browser's task manager
- [ ] Filling the disk mid-transfer gives a clear error and leaves no partial file
- [ ] Cancelling at 50% from each side removes the partial file
- [ ] The receiver's slow disk doesn't crash either tab. Test by throttling the fake sink, then a USB drive if you have one.

**Test disk space:** the receiving disk needs at least 25 GiB free. This machine had only 9.8 GB free when this plan was written, so use another machine or clear space. `truncate -s 20G` makes a test file that uses no disk space on the sender, but it is all zeros, so it can't reveal reordered chunks. Run the 2 GiB test with `head -c 2G /dev/urandom > test.bin` as well.

---

## 5. Milestone 4: Usable product

**Goal:** someone who has never seen the app can send a file without help.

### Flow

```
Sender:   choose file → link appears → share → waits → sees progress → Complete
Receiver: opens link → sees name and size → Accept → chooses location → Complete
```

### Steps

**4.1 Invite link.** Show `https://<host>/#<token>`, with a Copy button using `navigator.clipboard.writeText`. On load, if `location.hash` has a token, remove it with `history.replaceState` and join automatically. The part after `#` is never sent to the server, so tokens stay out of access logs. Keep the manual token field as a fallback.

**4.2 Progress.** Show percent, bytes done and total, speed, and time remaining. Update at most twice a second and use a rolling 5-second average so the numbers stay readable. Set `role="progressbar"` semantics through the native `<progress>` element, and don't announce every update to screen readers.

**4.3 Cancel.** Add a Cancel button on both sides. It sends `cancel`, then stops the sender or aborts the sink.

**4.4 Keep the session alive.**

```ts
window.addEventListener("beforeunload", (e) => { if (transferring) e.preventDefault(); });
const lock = await navigator.wakeLock?.request("screen").catch(() => null);
```

Release the lock when the transfer ends. Tell users to keep both tabs open, because mobile browsers often suspend background tabs.

**4.5 Send another file.** After `saved`, the sender can choose a new file without creating a new room. Reset all transfer state, and keep the peer connection.

**4.6 Readable errors.** Every failure needs a plain message and a next step:

| Situation | Message |
|---|---|
| Link expired | "This link has expired. Ask the sender for a new one." |
| Room full | "This link has already been used." |
| Connection failed | "Couldn't connect the two devices." |
| Peer lost | "The other person disconnected. The transfer stopped." |
| File too large here | "This browser can't save a file this large. Try Chrome or Edge on a computer." |
| Waiting room expired | Remove the old link, then show "Link expired" and a Create New Link button |

**4.7 Design and accessibility.** Add one small CSS file. Use real labels, visible keyboard focus, sufficient contrast, and a layout that works at phone width. The existing `role="status"` and `role="alert"` elements should keep carrying state changes.

### Done when

- [ ] A person unfamiliar with the app sends a file using only the page
- [ ] The whole flow works by keyboard alone
- [ ] The page works at 360 px width with no sideways scrolling
- [ ] Each error in the table was triggered and read correctly
- [ ] Two files can be sent one after the other in the same room
- [ ] The token isn't in server logs or the address bar after joining

---

## 6. Milestone 5: Production setup

**Goal:** the app runs on the VPS with HTTPS and basic abuse protection. Connections work on the same network now, and across networks after Milestone 6.

### Step 5.1: Harden the Go server

These were deferred in `plan.md` and must exist before going public.

| Protection | Rule | Where |
|---|---|---|
| Connections per IP | At most 10 at once | Counter map in the handler, decremented with `defer` |
| First message | Must arrive within 15 seconds | Timeout context on the first `conn.Read` |
| Messages per connection | At most 256 | Counter in the read loop, then close with `StatusPolicyViolation` |
| Expired rooms | Close the socket after sending `expired` | `main.go` sweep loop |
| Message size | 32 KiB | Already the library default |
| Room count | 1000 | Already in `hub.go` |

```go
func clientIP(r *http.Request) string {
    // Safe only because signaling is reachable solely through Caddy, which replaces this header.
    if ip := r.Header.Get("X-Forwarded-For"); ip != "" {
        return ip
    }
    host, _, _ := net.SplitHostPort(r.RemoteAddr)
    return host
}
```

Add tests for each new limit. For example, an 11th connection from one IP is refused, a silent connection closes, and a 257th message closes the connection.

### Step 5.2: Prepare the VPS

1. Create a non-root user, enable SSH key login, and disable password login.
2. Turn on automatic security updates.
3. Install Docker and the Compose plugin.
4. Point a DNS `A` record for `drop.example.com` at the VPS. Replace this example name everywhere below.
5. Open only the ports needed:

```bash
ufw default deny incoming
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw enable
```

Docker can bypass `ufw` for published ports, so check from another machine with `nmap` that port 8080 is closed.

### Step 5.3: Add Docker files

`server/Dockerfile`:

```dockerfile
FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /streamdrop .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /streamdrop /streamdrop
ENTRYPOINT ["/streamdrop", "-addr", "0.0.0.0:8080"]
```

`web/Dockerfile` builds the page and places it inside Caddy:

```dockerfile
FROM node:24 AS build
WORKDIR /src
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM caddy:2
COPY --from=build /src/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
```

Add a `.dockerignore` with `node_modules` and `dist`.

`web/Caddyfile`:

```caddyfile
{$DOMAIN} {
	handle /ws {
		reverse_proxy signaling:8080
	}
	handle {
		root * /srv
		file_server
	}
	header {
		Content-Security-Policy "default-src 'self'; connect-src 'self' wss://{$DOMAIN}; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
		Referrer-Policy no-referrer
		X-Content-Type-Options nosniff
	}
}
```

`compose.yaml`:

```yaml
x-logging: &logging
  driver: json-file
  options: { max-size: "10m", max-file: "3" }

services:
  signaling:
    build: ./server
    restart: unless-stopped
    logging: *logging

  caddy:
    build: ./web
    restart: unless-stopped
    environment:
      DOMAIN: ${DOMAIN}
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - caddy_data:/data
      - caddy_config:/config
    logging: *logging

volumes:
  caddy_data:
  caddy_config:
```

The signaling service has no `ports` entry, so only Caddy can reach it. `caddy_data` holds HTTPS certificates. No volume ever holds file data.

### Step 5.4: Deploy

```bash
git clone <your repo> streamdrop && cd streamdrop
echo 'DOMAIN=drop.example.com' > .env
docker compose up -d --build
docker compose logs -f
```

Add `.env` to `.gitignore`.

### Done when

- [ ] `https://drop.example.com` loads with a valid certificate
- [ ] A transfer works between two devices on the same network
- [ ] A page on another origin can't open the WebSocket
- [ ] `nmap` shows only the expected ports
- [ ] Restarting the signaling container leaves a running transfer unaffected
- [ ] The browser console shows no Content-Security-Policy errors
- [ ] `docker compose down && docker compose up -d` works, and the certificate is reused

---

## 7. Milestone 6: TURN fallback

**Goal:** transfers work between networks where a direct path is impossible.

### New concepts

| Term | Meaning |
|---|---|
| **NAT** | A router that shares one public address, hiding devices behind it. |
| **STUN** | Tells a browser its public address so a direct path can be attempted. Uses almost no bandwidth. |
| **TURN** | Relays traffic through your VPS when no direct path works. Uses a lot of bandwidth. |

WebRTC tries direct paths first and uses TURN only if they fail.

### Bandwidth

Every relayed byte is counted twice, once in and once out. **One relayed 20 GiB transfer uses about 40 GiB of VPS traffic.** Check your provider's monthly allowance and overage price before setting the limits below.

### Step 6.1: Configure coturn

Create `coturn/turnserver.conf`:

```conf
listening-port=3478
min-port=49160
max-port=49400
realm=drop.example.com
external-ip=<VPS_PUBLIC_IP>

use-auth-secret
# static-auth-secret is passed on the command line from .env

no-cli
fingerprint
no-tls
no-dtls
log-file=stdout

# Per-session limit: 6.25 MB/s, about 50 Mbit/s
max-bps=6250000
user-quota=4
total-quota=40

# Stop the relay being used to reach private networks or cloud metadata
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
```

Add to `compose.yaml`:

```yaml
  coturn:
    image: coturn/coturn:<pinned-version>
    restart: unless-stopped
    network_mode: host # Docker handles large port ranges poorly
    command: ["-c", "/etc/coturn/turnserver.conf", "--static-auth-secret=${TURN_SECRET}"]
    volumes:
      - ./coturn/turnserver.conf:/etc/coturn/turnserver.conf:ro
    logging: *logging
```

Pass settings to signaling:

```yaml
  signaling:
    environment:
      TURN_SECRET: ${TURN_SECRET}
      TURN_HOST: ${DOMAIN}
```

Generate the secret with `openssl rand -hex 32` and store it in `.env`. Open the firewall:

```bash
ufw allow 3478
ufw allow 49160:49400/udp
```

### Step 6.2: Issue credentials from Go

Create `server/turn.go`:

```go
const turnTTL = 12 * time.Hour

type ICEServer struct {
    URLs       []string `json:"urls"`
    Username   string   `json:"username,omitempty"`
    Credential string   `json:"credential,omitempty"`
}

func turnServers(secret, host string, now time.Time) []ICEServer {
    if secret == "" {
        return nil // local development needs no relay
    }
    username := strconv.FormatInt(now.Add(turnTTL).Unix(), 10) + ":streamdrop"
    mac := hmac.New(sha1.New, []byte(secret)) // SHA-1 is what coturn's auth-secret mode requires
    mac.Write([]byte(username))
    return []ICEServer{{
        URLs: []string{
            "stun:" + host + ":3478",
            "turn:" + host + ":3478?transport=udp",
            "turn:" + host + ":3478?transport=tcp",
        },
        Username:   username,
        Credential: base64.StdEncoding.EncodeToString(mac.Sum(nil)),
    }}
}
```

Then:

1. Add `ICEServers []ICEServer \`json:"iceServers,omitempty"\`` to `Message`.
2. Pass config into `newHandler`, and update the existing test calls.
3. Include `iceServers` in both `joined` and `peer-joined`. Don't send them in `created`, so unpaired visitors get nothing.
4. Change `createPeer` to take `iceServers` and pass it to `RTCPeerConnection`.
5. Allow `turnTTL` to outlast the slowest expected transfer. A 20 GiB file at 50 Mbit/s takes about an hour, and slower links take longer.

**Tests:** a known secret, username and time produce the expected credential; an empty secret returns `nil`; `created` contains no servers; `joined` and `peer-joined` do.

### Step 6.3: Test the relay

Temporarily set `iceTransportPolicy: "relay"` in `peer.ts` so only TURN can be used. Check `chrome://webrtc-internals` for candidate pairs of type `relay`. **Remove the setting afterwards.**

### Done when

- [ ] Forced-relay transfer succeeds and the hash matches
- [ ] A transfer between home Wi-Fi and phone hotspot succeeds
- [ ] Without forced relay, same-network transfers stay direct and don't use the VPS
- [ ] The relay refuses connections with wrong credentials
- [ ] Peers can't reach private addresses through the relay
- [ ] VPS disk usage doesn't change during a relayed transfer
- [ ] The per-session speed limit is observed
- [ ] A relayed transfer keeps running past a shortened `turnTTL`. If it stops, keep the TTL longer than the longest transfer.

### Optional: TURN over TLS

Very strict networks may block port 3478. coturn can also listen for TLS on port 5349 or 443, using the certificate Caddy obtains. Add this only if real users hit the problem, because it requires sharing certificates and reloading coturn after each renewal. It adds firewall compatibility, not privacy, since relayed data is already encrypted.

---

## 8. Milestone 7: Release

### Browser matrix

Test as both sender and receiver. Mark the largest size that worked.

| Browser | Windows | macOS | Linux | Android | iOS |
|---|---|---|---|---|---|
| Chrome | | | | | |
| Edge | | | n/a | | n/a |
| Firefox | | | | | |
| Safari | n/a | | n/a | n/a | |

Also test Chrome sending to Firefox and Firefox sending to Chrome, because mixed pairs reveal message-size problems.

### Automated browser test

Add one Playwright test as a dev dependency in `web/`: two pages connect, one sends a generated file, and the test compares hashes. Use it for the memory sink, since Playwright can't operate the native save dialog. Run it with `npm run test:e2e`.

### Load test

Write a small Go test client that opens many paired WebSocket connections. On the VPS, confirm:

- [ ] 1,000 rooms stay well under the 4 GB memory limit
- [ ] Limits return errors rather than crashing the server
- [ ] Forced-relay transfers at `total-quota` keep CPU and bandwidth within your budget
- [ ] Adjust `max-bps` and `total-quota` from the results

### Security review

- [ ] Tokens, SDP and candidates never appear in logs
- [ ] All data from a peer is validated and shown with `textContent`
- [ ] Secrets exist only in `.env`, and that file isn't in git
- [ ] `coturn` can't reach private addresses
- [ ] `go vet`, `govulncheck ./...` and `npm audit` are clean
- [ ] No file content can reach disk on the VPS

### Runbook

Add `README.md` with:

- What StreamDrop does and its browser limits
- Local development commands
- Deployment steps and required `.env` values
- How to update: `git pull && docker compose up -d --build`
- How to clean up: `docker image prune -f`
- How to rotate `TURN_SECRET`
- How to read logs and check relay bandwidth

There is nothing to back up beyond `.env`, because the app has no database.

### Done when

- [ ] Browser matrix is complete and limits are documented
- [ ] Load test and security review pass
- [ ] A fresh VPS can be set up by following only the README
- [ ] A 20 GiB transfer works across two different networks in production

---

## 9. Final file layout

```
StreamDrop/
├── README.md, compose.yaml, .env (not in git)
├── plan.md, project-plan.md, track.md
├── coturn/turnserver.conf
├── server/
│   ├── Dockerfile, go.mod, go.sum
│   ├── main.go
│   ├── hub.go, hub_test.go
│   ├── signal.go, signal_test.go
│   └── turn.go, turn_test.go
└── web/
    ├── Dockerfile, Caddyfile, index.html, vite.config.ts
    └── src/
        ├── main.ts, peer.ts
        ├── transfer.ts, transfer.test.ts
        └── sinks.ts
```

## 10. Known limits

| Limit | Reason |
|---|---|
| Both devices must stay online with the page open | Nothing is stored on the server |
| 20 GiB needs a browser with disk streaming | Others are bound by storage quota or memory |
| Mobile transfers may stop in the background | Operating systems suspend inactive tabs |
| A dropped connection means starting again | Resume is left out |
| Relayed transfers are capped by VPS bandwidth | Every relayed byte is counted twice |

## 11. Left out on purpose

Accounts, transfer history, multiple recipients, folders, compression, resume, server-side storage, analytics, and an extra layer of file encryption. None are needed for the core job, and WebRTC already encrypts the transfer.

## 12. Check these when you reach them

These come from memory or couldn't be confirmed today, so test them instead of trusting this plan:

- **coturn session lifetime:** it may end a relay session when its credential expires. The test in Milestone 6 settles this.
- **coturn and Caddy versions:** the release lookup failed, so pin current image versions when you write the files.
- **coturn options:** confirm each setting against the documentation for the version you pin.
- **OPFS writing:** `createWritable` support differs by browser, Safari especially. If it is missing, `chooseSink` must fall through to the memory sink.
- **Memory for the OPFS export:** confirm that exporting a large OPFS file doesn't load it into memory.
- **Docker:** it isn't installed on this development machine, so the Docker files haven't been built here.
