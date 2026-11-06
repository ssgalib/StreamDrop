# StreamDrop: Milestone 1 Implementation Plan

## Context

StreamDrop will be a self-hosted app that sends files directly from one browser to another. The repository is empty, so everything here is new. Milestone 1 proves the hardest part first: two browser tabs find each other through a small Go server, open a direct WebRTC connection, and exchange a typed message without that message passing through the server.

File transfer, coturn, Caddy, Docker and deployment are **not** part of this milestone.

**Checked on this machine (2026-11-06):** Go 1.27, Node 24, npm 12, Firefox. Chrome and Chromium were not installed at the time, so install Chrome before the manual checks. Latest packages: Vite 8, TypeScript 7, `github.com/coder/websocket` v1.8.15.

---

## 1. Concepts you need first

| Term | Meaning |
|---|---|
| **WebSocket** | A connection that stays open so the browser and server can both send messages at any time. |
| **Signaling** | The setup conversation two browsers need before they can connect directly. Our Go server only passes these messages along. |
| **SDP** | Text describing what a browser wants to do. One side sends an **offer**, the other replies with an **answer**. |
| **ICE candidate** | A network address where a browser might be reachable. Both sides send several and WebRTC tries them. |
| **RTCPeerConnection** | The browser object that manages the direct connection. |
| **RTCDataChannel** | A pipe inside that connection for text or bytes. This is what carries the user's message. |

### How the pieces talk

```
Tab A (creator)              Go server                Tab B (joiner)
   | -- create ------------->  |                          |
   | <- created {token} -----  |                          |
   |      (user copies the token into Tab B)              |
   |                           | <-- join {token} ------- |
   |                           | --- joined ------------> |
   | <- peer-joined ---------  |                          |
   | -- offer ---------------> | --- offer -------------> |
   |                           | <-- answer ------------- |
   | <- answer --------------  |                          |
   | <-- candidate messages flow both ways via server --> |
   |                                                      |
   | ======== DataChannel: direct, no server ============ |
```

Everything above the `====` line is signaling. The server never sees what travels on the DataChannel.

---

## 2. What you will build

```
StreamDrop/
├── .gitignore
├── plan.md
├── server/
│   ├── go.mod, go.sum
│   ├── main.go          starts the HTTP server and expiry timer
│   ├── hub.go           rooms, tokens, expiry (no networking)
│   ├── hub_test.go
│   ├── signal.go        message type, validation, WebSocket handler
│   └── signal_test.go
└── web/
    ├── package.json, tsconfig.json
    ├── vite.config.ts   forwards /ws to the Go server
    ├── index.html       the UI
    └── src/
        ├── main.ts      buttons, WebSocket, status display
        └── peer.ts      all WebRTC code
```

### Decisions already made

| Decision | Choice | Why |
|---|---|---|
| WebSocket library | `github.com/coder/websocket` | Go's standard library has no WebSocket server. This one is small, allows concurrent writes and checks `Origin` by default. |
| Token | `crypto/rand.Text()` | One standard-library call gives at least 128 bits of secure randomness. |
| Room ID | The token is the room's key | One value to share, and no second ID to keep in sync. |
| Token lifetime | 10 minutes, for joining only | A connected pair is not cut off when the token expires. |
| Room capacity | Exactly 2 peers | Either peer leaving deletes the room, so a token can't be reused. |
| How the token is sent | Inside a WebSocket message, not the URL | URLs end up in access logs. |
| Who can type | Both tabs | DataChannels work both ways, so restricting this would only add code. |
| Frontend tests | None in this milestone | The brief asks for Go unit tests. The browser flow is checked by hand in Step 10. |

### Message protocol (JSON over WebSocket)

| `type` | Direction | Other fields | Meaning |
|---|---|---|---|
| `create` | client → server | | Make a room |
| `created` | server → client | `token`, `expiresAt` | Room is ready |
| `join` | client → server | `token` | Join a room |
| `joined` | server → joiner | | You are in |
| `peer-joined` | server → creator | | Other tab arrived, start the offer |
| `offer` | creator → joiner | `sdp` | Relayed |
| `answer` | joiner → creator | `sdp` | Relayed |
| `candidate` | both ways | `candidate` | Relayed |
| `peer-left` | server → client | | Other tab disconnected |
| `error` | server → client | `code` | See the codes below |

Error codes: `bad-message`, `invalid-token`, `expired`, `room-full`, `already-in-room`, `not-paired`, `server-busy`.

There is deliberately **no chat message type**. The server rejects anything not in this table, so chat text can't be routed through it by accident.

---

## 3. Build steps

Do these in order. Each step ends with a check, so don't move on until it passes.

### Step 1: Project setup

```bash
cd ~/projects/StreamDrop
git init
printf 'node_modules/\ndist/\n' > .gitignore

mkdir server && cd server
go mod init streamdrop
go get github.com/coder/websocket
cd ..

npm create vite@latest web -- --template vanilla-ts
cd web && npm install
```

Delete the sample files Vite created: `src/counter.ts`, `src/style.css`, `src/typescript.svg`, and anything in `public/`. Empty out `src/main.ts`.

**Check:** `go version` and `npm run build` (inside `web/`) both work.

### Step 2: Rooms and tokens (`server/hub.go`)

This file contains **no networking**, which is what makes it easy to test.

```go
const (
    tokenTTL = 10 * time.Minute
    maxRooms = 1000
)

var (
    ErrInvalidToken  = errors.New("invalid-token")
    ErrExpired       = errors.New("expired")
    ErrRoomFull      = errors.New("room-full")
    ErrAlreadyInRoom = errors.New("already-in-room")
    ErrServerBusy    = errors.New("server-busy")
)

type Peer struct {
    conn      *websocket.Conn // nil in unit tests
    room      *Room           // guarded by Hub.mu
    isCreator bool
}

type Room struct {
    token           string
    expiresAt       time.Time
    creator, joiner *Peer
}

type Hub struct {
    mu    sync.Mutex
    rooms map[string]*Room
    now   func() time.Time // tests replace this to fake the clock
}
```

Write these methods. Each one locks `h.mu` first (`h.mu.Lock(); defer h.mu.Unlock()`), and **none of them sends network messages**.

| Method | What it does |
|---|---|
| `NewHub() *Hub` | Creates the map and sets `now: time.Now`. |
| `Create(p) (*Room, error)` | Returns `ErrAlreadyInRoom` if `p.room != nil`, and `ErrServerBusy` if `len(rooms) >= maxRooms`. Otherwise makes a room with `token: rand.Text()` and `expiresAt: h.now().Add(tokenTTL)`. Sets `p.room` and `p.isCreator = true`. |
| `Join(token, p) (*Room, error)` | Checks in this order: already in a room → `ErrAlreadyInRoom`; token not in map → `ErrInvalidToken`; `joiner != nil` → `ErrRoomFull`; `!h.now().Before(expiresAt)` → `ErrExpired`. Otherwise sets `room.joiner` and `p.room`. |
| `Other(p) *Peer` | Returns the other peer in `p`'s room, or `nil` if there isn't one. |
| `Leave(p) *Peer` | Deletes the room, clears `room` on both peers, and returns the other peer (or `nil`) so the caller can notify it. |
| `Sweep() []*Peer` | Deletes rooms where `joiner == nil` and the token has expired. Returns those creators. Never touches paired rooms. |

Import `crypto/rand`, never `math/rand`. `math/rand` is predictable, which would make tokens guessable.

**Check:** write `server/hub_test.go` with a fake clock, then run `go test ./...`.

```go
func newTestHub() (*Hub, *time.Time) {
    t := time.Unix(1000, 0)
    h := NewHub()
    h.now = func() time.Time { return t }
    return h, &t // tests move time forward with: *clock = clock.Add(tokenTTL)
}
```

Tests to write:

- [ ] 1,000 tokens are all different and each is at least 26 characters
- [ ] A valid token joins successfully
- [ ] An unknown token returns `ErrInvalidToken`
- [ ] A token at exactly its expiry time returns `ErrExpired`
- [ ] A third peer gets `ErrRoomFull`
- [ ] A peer already in a room can't create or join another
- [ ] `Sweep` removes an expired waiting room and returns its creator
- [ ] `Sweep` keeps a paired room, even after the token expires
- [ ] After `Leave`, the same token returns `ErrInvalidToken`
- [ ] `Create` returns `ErrServerBusy` once `maxRooms` is reached
- [ ] 50 goroutines join one room at once and exactly one succeeds

### Step 3: Message validation (`server/signal.go`, part 1)

```go
type Message struct {
    Type      string          `json:"type"`
    Token     string          `json:"token,omitempty"`
    ExpiresAt time.Time       `json:"expiresAt,omitzero"`
    SDP       string          `json:"sdp,omitempty"`
    Candidate json.RawMessage `json:"candidate,omitempty"` // passed through unread
    Code      string          `json:"code,omitempty"`
}
```

Write `validateSignal(m Message, isCreator bool) error`, a plain function that returns `nil` only when:

- `offer` comes from the creator and has a non-empty `sdp`
- `answer` comes from the joiner and has a non-empty `sdp`
- `candidate` has a non-empty `candidate`

Any other type is an error.

**Check:** a table-driven test in `signal_test.go`, with one row for each rule above plus an unknown type such as `chat`.

### Step 4: WebSocket handler (`server/signal.go`, part 2)

Treat everything a browser sends as untrusted. Each connection runs this loop in its own goroutine:

```go
func newHandler(h *Hub) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // Accept rejects other sites' pages, because Origin must match Host.
        conn, err := websocket.Accept(w, r, nil)
        if err != nil {
            return
        }
        defer conn.CloseNow()

        p := &Peer{conn: conn}
        defer func() {
            if other := h.Leave(p); other != nil {
                send(other, Message{Type: "peer-left"})
            }
        }()

        for {
            _, data, err := conn.Read(r.Context()) // 32 KiB limit by default
            if err != nil {
                return
            }
            var m Message
            if json.Unmarshal(data, &m) != nil {
                sendError(p, "bad-message")
                continue
            }
            handle(h, p, m)
        }
    }
}
```

`handle` is a `switch m.Type`:

- **`create`**: call `h.Create(p)`, then send `created` with the token and expiry.
- **`join`**: call `h.Join(m.Token, p)`, send `joined` to `p`, **then** send `peer-joined` to `room.creator`. This order matters because the joiner must be ready before an offer can arrive.
- **`offer`, `answer`, `candidate`**: run `validateSignal`, look up `h.Other(p)`, and send `not-paired` if it is `nil`. Otherwise forward a **new** `Message` containing only `Type`, `SDP` and `Candidate`, so a client can't slip in extra fields.
- **Anything else**: send `bad-message`.

When `Create` or `Join` fails, use `err.Error()` as the error code.

`send(p, m)` marshals the message and calls `p.conn.Write` with a 5-second `context.WithTimeout`, so a stuck client can't hang the handler. Ignore write errors, because that peer's own read loop will notice and clean up.

**Two rules:**

1. Never hold `h.mu` while writing to a socket.
2. Never log tokens or SDP. They are secrets and private network details.

**Check:** add these to `signal_test.go`, using `httptest.NewServer(newHandler(NewHub()))` and `websocket.Dial`:

- [ ] Client A creates a room, client B joins, and A receives `peer-joined`
- [ ] An offer from A reaches B with the SDP unchanged
- [ ] Sending an offer before anyone joins returns `not-paired`
- [ ] Malformed JSON returns `bad-message`
- [ ] A `chat` message returns `bad-message` and is not delivered to the other peer
- [ ] When B disconnects, A receives `peer-left`
- [ ] A 40 KiB message closes the connection
- [ ] Dialing with `Origin: http://evil.example` fails

### Step 5: Start the server (`server/main.go`)

```go
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
```

**Check:** in `server/`, run `go vet ./... && go test -race ./...`. Everything passes. Then `go run .` prints `listening on 127.0.0.1:8080`.

### Step 6: Frontend config (`web/vite.config.ts`)

```ts
import { defineConfig } from "vite";

export default defineConfig({
  server: { proxy: { "/ws": { target: "ws://127.0.0.1:8080", ws: true } } },
});
```

Don't set `changeOrigin`. The default keeps the `Host` header as `localhost:5173`, which matches the page's `Origin`, so the server's origin check passes without any extra config.

**Check:** `npm run dev` starts and `http://localhost:5173` loads.

### Step 7: The page (`web/index.html`)

Keep Vite's `<script type="module" src="/src/main.ts"></script>` tag and put this in `<body>`:

```html
<main>
  <h1>StreamDrop</h1>

  <section id="start">
    <button id="create" type="button">Create Room</button>
    <form id="join-form">
      <label>Room token <input id="token-input" required autocomplete="off"></label>
      <button>Join Room</button>
    </form>
  </section>

  <section id="room" hidden>
    <p id="share" hidden>Share this token: <code id="token"></code></p>
    <form id="chat">
      <label>Message <input id="message" maxlength="1000" autocomplete="off" required disabled></label>
      <button id="send" disabled>Send</button>
    </form>
    <ul id="log"></ul>
  </section>

  <p id="status" role="status">Not connected</p>
  <p id="error" role="alert"></p>
</main>
```

Add a few lines of CSS in a `<style>` tag if you like. Appearance isn't a goal for this milestone.

**Check:** the page shows the two buttons and the status line.

### Step 8: WebRTC code (`web/src/peer.ts`)

This is the hardest file, so here it is in full. Read the comments carefully.

```ts
export type Signal =
  | { type: "offer" | "answer"; sdp: string }
  | { type: "candidate"; candidate: RTCIceCandidateInit };

type Events = {
  signal(s: Signal): void;
  state(text: string): void;
  open(): void;
  closed(): void;
  message(text: string): void;
};

export function createPeer(initiator: boolean, on: Events) {
  // No STUN or TURN servers are needed on localhost. coturn comes in a later milestone.
  const pc = new RTCPeerConnection({ iceServers: [] });
  const pending: RTCIceCandidateInit[] = [];
  let channel: RTCDataChannel | undefined;

  function useChannel(dc: RTCDataChannel) {
    channel = dc;
    dc.onopen = on.open;
    dc.onclose = on.closed;
    dc.onmessage = (e) => on.message(e.data);
  }

  async function setRemote(desc: RTCSessionDescriptionInit) {
    await pc.setRemoteDescription(desc);
    // Candidates can arrive before the description is set, and adding them early throws.
    for (const c of pending.splice(0)) await pc.addIceCandidate(c);
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) on.signal({ type: "candidate", candidate: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => on.state(pc.connectionState);

  if (initiator) {
    // Must exist before createOffer, or the offer won't include a data channel.
    // Channels are reliable unless maxRetransmits or maxPacketLifeTime is set.
    useChannel(pc.createDataChannel("chat", { ordered: true }));
  } else {
    pc.ondatachannel = (e) => useChannel(e.channel);
  }

  return {
    async start() {
      await pc.setLocalDescription(await pc.createOffer());
      on.signal({ type: "offer", sdp: pc.localDescription!.sdp });
    },
    async handle(s: Signal) {
      if (s.type === "offer") {
        await setRemote({ type: "offer", sdp: s.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        on.signal({ type: "answer", sdp: pc.localDescription!.sdp });
      } else if (s.type === "answer") {
        await setRemote({ type: "answer", sdp: s.sdp });
      } else if (pc.remoteDescription) {
        await pc.addIceCandidate(s.candidate);
      } else {
        pending.push(s.candidate);
      }
    },
    send: (text: string) => channel?.send(text),
    close: () => pc.close(),
  };
}
```

**Check:** `npm run build` has no type errors.

### Step 9: Connect it all (`web/src/main.ts`)

Write these parts in order:

1. **Look up elements** with `document.querySelector`.
2. **Add two helpers:** `setStatus(text)`, and `showError(text)` which writes to `#error`.
3. **Open the WebSocket** when either button is used:
   ```ts
   const scheme = location.protocol === "https:" ? "wss" : "ws";
   const ws = new WebSocket(`${scheme}://${location.host}/ws`);
   ```
   Send the first message in `ws.onopen`: `{type: "create"}`, or `{type: "join", token: input.value.trim()}`. Hide `#start` and show `#room` only after `created` or `joined` arrives, so a bad token leaves the join form usable.
4. **Handle server messages** in `ws.onmessage`:

   | Received | Do this |
   |---|---|
   | `created` | Show `#room`, `#share` and the token. Status: "Waiting for peer". |
   | `joined` | Show `#room`. `peer = createPeer(false, events)`. Status: "Connecting". |
   | `peer-joined` | `peer = createPeer(true, events)`, then `await peer.start()`. Status: "Connecting". |
   | `offer`, `answer`, `candidate` | `await peer.handle(msg)` inside `try/catch`, passing failures to `showError`. |
   | `peer-left` | `peer.close()`, disable the message input, status "Peer left. Reload to start again." |
   | `error` | `showError` with a readable message for each code. |

5. **Define the `events` object** passed to `createPeer`:
   - `signal`: `ws.send(JSON.stringify(s))`
   - `state`: show the connection state, and if it is `failed`, show an error
   - `open`: enable the input and Send button, status "Connected"
   - `closed`: disable them again
   - `message`: add a "Peer: ..." line to `#log`
6. **Handle `ws.onerror` and `ws.onclose`.** Show "Cannot reach the server" if no peer connection exists. If the DataChannel is open, **don't** close the peer. Just note that signaling is down. Step 10's server-stop test relies on this.
7. **Handle the chat form's submit:** call `event.preventDefault()`, then `peer.send(text)`, add a "You: ..." line to `#log`, and clear the input.

**Security rule:** always add messages with `textContent`, never `innerHTML`. Text from the other peer is untrusted, and `innerHTML` would let it run scripts in your page.

**Check:** `npm run build` passes.

### Step 10: Full verification

Automated, from the project root:

```bash
(cd server && go vet ./... && go test -race ./...)
(cd web && npm run build)
```

Manual, in Chrome with two terminals running `cd server && go run .` and `cd web && npm run dev`:

- [ ] **Connect:** Tab 1 → Create Room. Copy the token. Tab 2 → paste it → Join Room. Both tabs show "Connected".
- [ ] **Message:** type in Tab 1 and it appears in Tab 2. Try the reverse too.
- [ ] **Message stays off the WebSocket:** in DevTools → Network → `ws` → Messages, frames show setup messages only and never your text.
- [ ] **Message stays off the server:** stop the Go server with Ctrl+C, then send another message. It still arrives, which proves the path is direct.
- [ ] **Bad token:** a made-up token shows an error and the form still works.
- [ ] **Third tab:** using the same token shows "room full".
- [ ] **Peer leaves:** closing one tab shows "Peer left" in the other.
- [ ] **Expiry:** temporarily set `tokenTTL` to 30 seconds, wait about a minute, and confirm the waiting tab shows the expired error. Restore 10 minutes afterwards.
- [ ] **Server down:** with the Go server stopped, Create Room shows "Cannot reach the server".
- [ ] **HTML is not run:** send `<img src=x onerror=alert(1)>`. It appears as plain text.

---

## 4. Completion criteria

| Requirement | Proven by |
|---|---|
| Two tabs join the same room | Step 4 tests, "Connect" check |
| DataChannel opens | "Connect" check, status reads "Connected" |
| Message appears in the other tab | "Message" check |
| Server never handles message contents | No chat type in the protocol, `chat` rejection test, both "stays off" checks |
| Tokens aren't guessable | `crypto/rand`, uniqueness test, unknown-token test |
| Builds and tests pass | The automated commands in Step 10 |

**Stop here.** Don't start Milestone 2 until every box above is ticked.

---

## 5. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| WebSocket fails with 403 | `Origin` doesn't match `Host` | Confirm `changeOrigin` isn't set in the Vite proxy. |
| WebSocket fails immediately | Go server isn't running | Start `go run .` in `server/`. |
| `addIceCandidate` throws | Candidate added before the remote description | Confirm the `pending` queue in `peer.ts` is intact. |
| Stuck on "Connecting", state goes to `failed` | Chrome hides local addresses behind mDNS names | Open `chrome://flags/#enable-webrtc-hide-local-ips-with-mdns`, set it to Disabled and relaunch, for local testing. |
| Offer contains no data channel | `createDataChannel` ran after `createOffer` | Keep the order used in `peer.ts`. |
| `go test -race` complains about cgo | No C compiler available | Install `gcc`. |
| Race detector reports a problem | A `Peer` or `Room` field was touched outside `h.mu` | Move that access into a `Hub` method. |

---

## 6. Left out on purpose

| Item | When it's needed |
|---|---|
| File transfer | Milestone 2 |
| STUN/TURN servers, Caddy, Docker | Deployment milestones |
| Go serving the built frontend | When Caddy or Docker is added |
| Per-IP rate limits, idle connection timeouts, per-connection message caps | **Before any public deployment.** Until then the server stays bound to `127.0.0.1`. |
| Reconnecting after a dropped connection | Only if real use shows a need |
| Shareable invite links | Nice to have, and the token should go in the URL `#fragment` so it never reaches the server |
