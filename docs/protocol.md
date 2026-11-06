# StreamDrop wire protocol, version 2

For anyone writing a client. `docs/vectors.json` holds test vectors, made by `docs/make-vectors.py` with Python's
standard library so they check a client's crypto independently; the TypeScript tests load them, and a Kotlin port
must too. The words MUST and MAY are used as in RFCs. **This design has had no outside security review.**

## Encodings and rules

- `b32`: RFC 4648 base32, uppercase, no padding. 16 bytes give 26 characters, the shape `validID` accepts.
- `b64u`: base64url, no padding.
- HKDF and HMAC use SHA-256. Strings are UTF-8.
- JSON control messages MUST be compact, with `t` as the **first** key. Old pages depend on this.
- Unknown `t` values and unknown fields MUST be ignored. An unknown id in a binary frame is dropped.
- All input from the peer is untrusted and MUST be validated before it is shown or used.

## Signaling (WebSocket at `/ws`, JSON, `type` field)

Existing, unchanged [code]:

| Client sends | Server replies | Notes |
|---|---|---|
| `create` | `created{token, expiresAt}` | Invite room, 10 minutes |
| `join{token}` | `joined{iceServers}`, and `peer-joined{iceServers}` to the creator | |
| `rejoin{token}` | First arrival `created{expiresAt}`, second as above | `token` is 26 base32 characters |
| `offer{sdp}` | Forwarded | Room creator only |
| `answer{sdp}` | Forwarded | Joiner only |
| `candidate{candidate}` | Forwarded | Either |
| | `peer-left`, `error{code}` | Codes: `bad-message`, `invalid-token`, `expired`, `room-full`, `already-in-room`, `not-paired`, `server-busy` |

The room creator makes the WebRTC offer. On `rejoin`, whoever arrives first is the creator.

New:

| Message | Meaning |
|---|---|
| `listen{ids:[...]}` | Client to server. Up to 32 room ids, valid only on a socket that is not in a room. Replaces that socket's earlier list. **Both devices of a pair listen on the same id**, so the server keeps the latest 4 sockets per id and rings all of them (a dead socket can linger until its ping fails). If a room is already waiting for an id, the server rings at once. |
| `ring{token}` | Server to listener: someone is waiting in this room. Reply by opening a **new** socket with `rejoin{token}`. Ignore it if busy, or already connected to or calling that device: the server can't tell a device's sockets apart, so a caller is usually rung for its own room. At most one ring per id per listening socket every 5 s. |
| `created{..., listeners:n}` | Added to the reply to `rejoin`: how many sockets listen on that id, the caller's own included. So a caller that listens too compares with 1, to show "Connecting" rather than "Open StreamDrop on the other device". |

Server changes, and nothing else:
- `OriginPatterns` for `app://streamdrop`.
- `conn.Ping` every 45 s on every socket, closing on failure (fixes finding 4).
- A map from room id to listening peer, capped at 2000 sockets, held in memory only.
- `rooms` and limits are untouched. A socket that sends `create`, `join` or `rejoin` should not also be used for `listen`. `listen` sockets count toward the 10 per IP, but a device now needs 1 idle socket instead of 1 per saved device.

An old server answers `listen` with `bad-message`; apps show "The server needs updating".

## Invite

`https://<host>/#<TOKEN>.<P>`
- `TOKEN` comes from `created`.
- `P` = `b32(16 random bytes)`, made by the inviter's client. It sits after `#`, so it is **never sent to the server**.
- The client splits on `.` and sends only `TOKEN` in `join`.
- A typed 26-character code has no `P`. That connection works but can't be saved.
- A stale old page would send the whole string and fail with `invalid-token`, which is a clear failure, though it would expose `P` for that one dead invite.

## Connection start (DataChannel `file`, ordered, reliable)

As soon as the channel opens, a v2 client sends:

`{"t":"hello","v":2,"min":1,"caps":["pair"]}`

- `v` is the version it speaks; `min` is the oldest it accepts.
- `caps` lists what this device can do on **this** connection: `pair` only if it holds the invite key, `saved` only if it holds the pair's key. Authentication runs when both list the same one.
- `save` means it can keep a saved connection. Save is only offered when both devices list it, so never to a browser.
- The channel is ordered, so any other first message from the peer also means a v1 peer, at once.
- No `hello` within 3 s means a v1 peer. That is allowed only for ad hoc connections, and the existing `session` step applies.
- A proof is **required** on a saved connection, by a device that opened a link carrying `P` (the inviter must hold it too), and on every reconnect after a verified connection. There a missing `hello`, a missing cap or a failed proof ends the attempt. Otherwise a side could be downgraded by someone in the middle.
- An inviter whose peer has no `pair` cap can't tell a typed code from an attack, so that connection is allowed but is unverified ("Temporary connection") and can't be saved.
- While waiting for a required proof the wait is 15 s, not 3 s.
- If the peer's `v` is below my `min`: send `{"t":"bye","reason":"upgrade","min":N}` and show "Update StreamDrop on the other device". The same applies the other way round.
- `bye` keeps its meaning. `reason` is one of `user`, `idle`, `upgrade`, `auth`. Old pages ignore the extra field.

## Authentication (the same steps for pairing and for saved connections)

Before starting, read from the local and remote SDP:
- `FO` is the offerer's and `FA` the answerer's `a=fingerprint:sha-256` value, as 32 raw bytes.
- Each device knows from its signaling role which it is. Anything but exactly one sha-256 fingerprint per side fails.

Steps:
1. Both send `{"t":"auth-n","mode":"pair"|"saved","n":"<b64u of 32 random bytes>"}`.
2. Let `T = "streamdrop-v2\0" || mode || "\0" || FO || FA || NO || NA` (`NO` and `NA` are the two nonces).
3. Both send `{"t":"auth-p","p":"<b64u of HMAC(key, role || T)>"}`, where `role` is `"offer"` or `"answer"`.
4. Each side checks the other's proof in constant time, using the other's role.
5. On success the connection reports `open` to the engine. On failure: `bye{reason:"auth"}`, close, and wait at least 30 s before retrying that device. A failed proof never falls back to a temporary connection.

The key is `HKDF(ikm=P, info="sd-pair-proof")` in pair mode, and `KA` ("Saved connection") in saved mode.

`P`, `r`, `K` and the like are always the raw bytes, not their text form. HKDF with no salt given uses an empty salt.

**Nothing but `hello`, `auth-*` and `bye` is processed before success.** This is one gate (`createGate` in `web/src/auth.ts`), placed before `ev.open`. Other messages are held, up to 256, and delivered in order after success: the peer may finish first and start sending.

Why it works: the WebRTC stack already checks that the peer holds the certificate matching the SDP fingerprint. Someone in the middle must present their own fingerprint, so the two sides compute different `T` values, and without the key the proof can't be forged. The nonces stop replay and `role` stops a proof being reflected back.

## Pairing

1. Device A sends `create`, shows the QR code and link, and B opens them. Both run "Authentication" in `pair` mode.
2. Both show "Save this device?" with the other's name. Names are sent as `{"t":"name","name":"..."}` after authentication, up to 64 characters, and treated as untrusted text.
3. When a side taps Save it sends `{"t":"pair-key","r":"<b64u of 32 random bytes>"}`.
4. When both `r` values are known:
   `K = HKDF(ikm = P || rO || rA, salt = FO || FA, info = "sd-pair-key")`, where `rO` and `rA` are the offerer's and answerer's, and `FO`, `FA` are those of the connection where this ran.
5. Each sends `{"t":"pair-ok","c":"<b64u of HMAC(KA, \"confirm\" || role)>"}`, and stores the pair only after checking the other's.

`r` travels inside DTLS, so someone who later finds the old link can't derive `K`. If there was no `P`, no Save is offered and the connection is labelled "Temporary connection". A browser can take part in an ad hoc transfer with any app; v1 only offers Save in the apps.

## Saved connection

Stored per pair: `K` (secret), `roomId`, peer name (renameable, local only), date added, last seen, always-accept flag.

```
roomId = b32( HKDF(ikm=K, info="sd-room")[0..16] )
KA     = HKDF(ikm=K, info="sd-auth")
```

- `roomId` is used with `rejoin` and `listen`, and doubles as the `session` value, so no `session` message is sent.
- After every DataChannel open, including a rejoin after a drop, run "Authentication" in `saved` mode.
- `{"t":"unpair"}`, sent only after authentication, tells the other side to delete the pair. It is a courtesy. Deletion on either side is enough, because the proof can then never succeed.
- `{"t":"bye","reason":"idle"}` closes after 2 minutes with nothing unfinished. The pair stays.

## Transfer (v1 protocol, unchanged unless marked)

Control messages:

| Message | Sent by | Meaning |
|---|---|---|
| `meta{id,name,size,type,fp,batch?,rel?}` | Sender | Offer. `rel` is **new** and optional. |
| `accept{id}` / `reject{id,reason?}` | Receiver | |
| `ack{id,bytes}` | Receiver | Stored so far, about every 1 MiB |
| `done{id}` | Sender | All bytes sent |
| `saved{id}` | Receiver | Stored and complete. **New:** also the answer to `resume` for a finished file. |
| `cancel{id}` | Either | |
| `resume{id,fp}` / `resume-at{id,bytes}` | Sender / receiver | After a reconnect |
| `session{id}` | Offerer, ad hoc only | Shared rejoin secret |

Data frame: 26 ASCII bytes of transfer id, then up to 64 KiB of payload. A sender must also respect the channel's maximum message size.

Rules and limits:

| | |
|---|---|
| Transfer id, batch id | 26 base32 characters |
| `fp` | 64 hex characters. **Opaque:** the receiver compares for equality only; the sender decides how to compute it, and it must stay stable for that file. |
| `name` | 1-255 characters, no path |
| `size` | 0 to 20 GiB |
| `batch` | `{id,i,n}`, `n` up to 500 |
| `rel` | Relative folder path. See "Untrusted names" below for the required checks. Old receivers ignore it and get flat files. |
| Window | At most 16 MiB sent but not acked. The receiver treats more than 2x that as a protocol error. |
| Send buffer | Stop above 4 MiB, continue below 1 MiB. libwebrtc refuses sends once its buffer fills, so implementers must not rely on queuing. |
| Outgoing | One file streams at a time; incoming files can arrive meanwhile |
| Resume | The receiver's `resume-at` is the truth. It may be lower than the last `ack`, because only durable bytes count after a crash. |

A receiver accepts up to 500 unanswered offers. A v2 sender keeps at most 100 unanswered, so that it works with old pages.

## Versioning

- Additive changes (new fields, new messages, new caps) keep `v`.
- A breaking change raises `v`, and raises `min` when the old one is dropped.
- A feature is used only if the peer listed its cap.
- Old pages and apps then fail with a message, not a hang.

## Untrusted names

Every `name` and `rel` is hostile. A client that writes them to a file system MUST reject or clean:
- `..`, absolute paths, drive letters, and backslashes used as separators;
- `:` (NTFS alternate streams), NUL and control characters;
- Windows reserved names (`CON`, `NUL`, `COM1` and so on), and trailing dots and spaces;
- Unicode direction overrides.

Then it MUST confirm the final path is inside the target folder.
