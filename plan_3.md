# plan_3.md: Desktop app, Android app and saved connections

Status: plan only, nothing built. Written 2026-11-06 from the current source (commit 9967382).

How far to trust each claim:

- **[code]** I read it in this repo.
- **[docs]** I found it in public documentation or reports today (links at the end).
- **[memory]** My own recollection, not checked today. Confirm before relying on it.
- **[measure]** Nobody knows until it is tested on real hardware.

`graphify-out/` predates the redesign: it has no `connection.ts` or `transfers.ts` and still lists the old `onControl()`. I used it for background only. Run `/graphify` again if you want it to match the code.

The brief arrived garbled in places. I filled the gaps from the source, and assumed:
- "both apps are running and on" means the same network or the internet;
- the deliverable list ends "ranked by how much each would change the plan";
- the desktop item means an "always accept" option per device.

---

## 0. The decisions, in short

| Question | Decision | Main reason |
|---|---|---|
| Desktop | **Electron**, with the UI bundled in the app | The same Chromium WebRTC your tests already cover, on all three systems. `connection.ts`, `transfers.ts` and `transfer.ts` are reused. Tauri's Linux webview cannot be relied on for WebRTC. |
| Android | **Native Kotlin + Compose + libwebrtc** | The connection must live in a service, not a page, and files must stream through `content://` URIs. The engine to port is only about 900 lines of TypeScript. |
| Saved connection | **One 256-bit secret per pair, bound to the DTLS fingerprints.** No device keypair. | Rendezvous needs a shared secret anyway, and with one the keypair adds almost nothing for two devices (section 3.1). |
| Verifying at pairing | **A key in the QR/link fragment, never sent to the server.** No short code to compare. | Stronger and needs no effort from the user. A safe short code needs a commit-and-reveal step. |
| Room id | **Derived one-way from the secret** | The room id is sent to the server, so it must never be the secret itself. |
| Reachability | Desktop: tray app with autostart. Phone: **open the app and the waiting transfer starts**. An always-listening phone is opt-in and comes later. | Sending from a phone needs no phone listener at all. |
| FCM push | **No for now** | It adds Google, a service key and new server work. Revisit only if question 1 in section 7 says so. |
| Folders | **Send as many files with a relative path, no zip** | A zip needs up to 20 GiB of temp disk and breaks resume. |
| Ships first | Spec, server and web changes, a 2-day Android spike, then desktop | Desktop reuses the most code and gives every later device something to connect to. |

**About 56 working days for the core, about 73 with a 30% margin.** The first release (desktop) lands around day 23. These are my estimates, not measurements.

### What the code showed that the brief did not

1. **The server can read files today if it turns malicious.** [code] `peer.ts` trusts whatever DTLS fingerprint arrives in the SDP, and the SDP goes through the server, so a bad relay can sit in the middle. The Cloudflare Tunnel ends TLS, so Cloudflare could do the same. The session secret does not help, because `rejoin` sends it to the server in the clear. "The server never sees file contents" currently means "an honest server doesn't look". The design below fixes this for app-to-app pairs.
2. **Native apps pass the Origin check only if they send no Origin.** [code] `websocket.Accept(w, r, nil)` allows a missing Origin but rejects a mismatched one. OkHttp on Android passes. A bundled Electron page (`app://`) is refused until `OriginPatterns` is set.
3. **The client has the server's address hard-wired.** [code] `connection.ts` builds it from `location.host`, which is wrong inside an app.
4. **The server never pings.** [code] A phone that changes network leaves a dead socket in its room. A new arrival then "joins" the ghost and waits for an offer that never comes. The client has no timeout for this. It is rare today and would be routine with long-lived listeners.
5. **`rejoin` rooms end after 10 minutes, and a socket can hold only one room.** [code] `Peer.room` is a single field. Waiting in rooms would cost one socket per saved device, a fresh TLS connection every 10 minutes, and it eats into the limit of 10 per IP. Section 2.2 avoids this with `listen`/`ring`.
6. **Bug: batches over 100 files fail.** [code] `MAX_PENDING = 100` rejects offers beyond 100 with "too many offers", unless the person pressed Accept all before they arrived. `MAX_FILES = 500` and the README promise 500. Folders would hit this at once.
7. **Bug: a finished file can be reported as failed.** [code] If `saved` is lost in a drop, the receiver's `onResume` sees state `done` and sends `reject`. The sender then reports "no longer has this file's progress", although the file arrived.
8. **Key order matters on the wire.** [code] `connection.ts` only recognises `session` and `bye` if the text starts with `{"t":"`. A Kotlin serializer that writes keys in another order would be silently ignored.
9. **Three things are already friendly to a new client.** [code] `transfers.ts` drops unknown `t` values, `parseMeta` drops unknown fields, and the receiver only compares `fp` for equality. So `hello` and `rel` reach old pages harmlessly, and `fp` can be opaque, which matters because SAF may not report a modified time.
10. **No relay runs in production.** [code/track.md] coturn was left uninstalled on purpose. Phones on carrier NAT may fail to connect at all (section 7, question 4).
11. **The deploy state is unclear.** `track.md` says "NOT deployed", but the live page's `last-modified` is 11:11 UTC today, which matches commit a95a959. The phone fix (9967382) came 13 minutes later and may not be live.

---

## 1. Recommended architecture

```
   Electron app (Win/Mac/Linux)          Android app (Kotlin)            Browser
  +---------------------------+   +------------------------------+  +--------------+
  | bundled web UI            |   | Compose UI                   |  | same web UI  |
  | connection / transfers /  |   | port of the same engine      |  | same engine  |
  | transfer  (same TS)       |   | libwebrtc in a Service       |  |              |
  | fs sink, paired-device    |   | MediaStore/SAF, Keystore     |  | OPFS sinks   |
  | store (safeStorage)       |   | share sheet, QR scanner      |  | ad hoc only  |
  +------------+--------------+   +---------------+--------------+  +------+-------+
               |                                  |                        |
               |  WSS: listen / ring / rejoin / offer / answer / candidate |
               +------------------+---------------+------------------------+
                                  v
          Cloudflare Tunnel -> nginx -> Go server (rooms + a map of who is listening)
                                  sees: room ids, IPs, SDP, timing. Stores nothing on disk.

   Files take a different path: device <-> device over a DTLS DataChannel.
   Direct when possible, through TURN only if it is installed and needed.
   Every saved connection proves the secret over that channel, bound to its DTLS fingerprints.
```

**Three layers, one spec.**
- **Signaling** (WebSocket): how two devices find each other. The server changes by about 100 lines of Go.
- **Authentication** (new, on the DataChannel): proves who is on the other end. Nothing reaches the engine until it passes.
- **Transfer** (existing): unchanged apart from one optional field and the two bug fixes.

**A saved transfer, end to end.**
1. The desktop tray app holds one idle socket and has sent `listen` with the room id of every saved device.
2. The phone shares a file to StreamDrop, and the person picks "Desktop".
3. The phone sends `rejoin{roomId}`. The server creates the room and sends `ring{roomId}` to the desktop.
4. The desktop opens a normal `rejoin` socket for that id. WebRTC connects as it does today.
5. Both sides prove the pair secret, bound to this connection's fingerprints.
6. The engine starts. The offer appears on the desktop, or is accepted automatically if the person enabled that.
7. After 2 idle minutes the connection closes. Holding it open costs battery on the phone.

If the other device is off, the first device waits in the room for up to the existing 10 minutes. When the phone app opens it sends `listen`, the server rings it at once, and the transfer starts. So "desktop to a sleeping phone" costs one tap on the phone.

**One peer at a time in v1.** A device in a session ignores rings from other saved devices, and the caller sees "didn't answer". `createConnection` and `createTransfers` are factories [code], so several peers later is mostly UI work.

### Stack comparison

Desktop:

| | Electron | Tauri 2 webview | Tauri or Wails + native WebRTC (Rust, or pion in Go) | Installable PWA |
|---|---|---|---|---|
| Code reuse | All the TS and the UI | All, if WebRTC exists | UI only; the engine is rewritten | All |
| WebRTC reliability | Chromium, same as your tests | **Three engines. Linux WebKitGTK has often had no `RTCPeerConnection`** [docs, mostly 2021-23] | Good, but a second stack to debug | Chromium |
| Large files | `fs` through the preload | Bridge to Rust | Native | OPFS limits remain |
| Background, tray | Yes | Yes | Yes | **No** |
| Download size | About 100 MB [memory] | About 10 MB [memory] | 15-30 MB [memory] | 0 |
| Effort (one person) | About 13 days | Unknown; three webviews to test | 25+ days | 1 day |

Size is the only thing Electron loses on, and for a tool you install once it matters least. Arch's WebKitGTK 2.54 here does contain `RTCPeerConnection` strings and depends on gst-plugins-bad, but that says nothing about other distros, or about it working.

Android:

| | Native Kotlin + libwebrtc | Capacitor / WebView | PWA |
|---|---|---|---|
| Code reuse | Protocol only; about 900 lines to port, UI rebuilt | Most of it | All |
| WebRTC reliability | Good if the binary is good ([measure], spike first) | Fine in the foreground | Fine in the foreground |
| 20 GiB streaming | Direct, constant memory | **The JS bridge is the bottleneck**; SAF has no streaming path into JS | OPFS only, quota-limited |
| Background | Foreground service owns the connection | A WebView in a service is unsupported and fragile | **Freezes: the problem you already hit** |
| Binary size | 10-15 MB per ABI [memory] | About 5 MB | 0 |
| Effort | About 22 days | About 12 days, then a wall at the two hardest requirements | 1 day |

Capacitor is cheaper only until background and large files, and those are the reason to build an app at all. A PWA (manifest plus share target) is a possible 1-day extra, not a product.

**libwebrtc risk.** Google has not shipped an official current Maven build, as far as I could find [docs]. Community builds exist: `io.github.webrtc-sdk:android` and GetStream's `webrtc-android`. Versions in search results conflicted, so check Maven Central, pin one version and its hash, and treat it as a third-party binary you must keep updated for security fixes.

---

## 2. Wire protocol and pairing spec (v2)

This section becomes `docs/protocol.md`, with `docs/vectors.json` holding test vectors that both the TS and Kotlin tests load. The words MUST and MAY are used as in RFCs.

### 2.1 Encodings and rules

- `b32`: RFC 4648 base32, uppercase, no padding. 16 bytes give 26 characters, the shape `validID` accepts.
- `b64u`: base64url, no padding.
- HKDF and HMAC use SHA-256. Strings are UTF-8.
- JSON control messages MUST be compact, with `t` as the **first** key. Old pages depend on this.
- Unknown `t` values and unknown fields MUST be ignored. An unknown id in a binary frame is dropped.
- All input from the peer is untrusted and MUST be validated before it is shown or used.

### 2.2 Signaling (WebSocket at `/ws`, JSON, `type` field)

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
| `listen{ids:[...]}` | Client to server. Up to 32 room ids, valid only on a socket that is not in a room. The latest registration for an id replaces the old one. If a room is already waiting for an id, the server rings at once. |
| `ring{token}` | Server to listener: someone is waiting in this room. Reply by opening a **new** socket with `rejoin{token}`. Ignore it if busy or already connected to that device. At most one ring per id every 5 s. |
| `created{..., listening:true}` | Added to the reply to `rejoin` when a listener exists, so the caller can show "Connecting" rather than "Open StreamDrop on the other device". |

Server changes, and nothing else:
- `OriginPatterns` for `app://streamdrop`.
- `conn.Ping` every 45 s on every socket, closing on failure (fixes finding 4).
- A map from room id to listening peer, capped at 2000 sockets, held in memory only.
- `rooms` and limits are untouched. `listen` sockets count toward the 10 per IP, but a device now needs 1 idle socket instead of 1 per saved device.

An old server answers `listen` with `bad-message`; apps show "The server needs updating".

### 2.3 Invite

`https://<host>/#<TOKEN>.<P>`
- `TOKEN` comes from `created`.
- `P` = `b32(16 random bytes)`, made by the inviter's client. It sits after `#`, so it is **never sent to the server**.
- The client splits on `.` and sends only `TOKEN` in `join`.
- A typed 26-character code has no `P`. That connection works but can't be saved.
- A stale old page would send the whole string and fail with `invalid-token`, which is a clear failure, though it would expose `P` for that one dead invite.

### 2.4 Connection start (DataChannel `file`, ordered, reliable)

As soon as the channel opens, a v2 client sends:

`{"t":"hello","v":2,"min":1,"caps":["pair","saved","rel"]}`

- `v` is the version it speaks; `min` is the oldest it accepts.
- No `hello` within 3 s means a v1 peer. That is allowed only for ad hoc connections, and the existing `session` step applies.
- For a saved connection, a missing `hello` or a failed proof ends the attempt.
- If the peer's `v` is below my `min`: send `{"t":"bye","reason":"upgrade","min":N}` and show "Update StreamDrop on the other device". The same applies the other way round.
- `bye` keeps its meaning. `reason` is one of `user`, `idle`, `upgrade`, `auth`. Old pages ignore the extra field.

### 2.5 Authentication (the same steps for pairing and for saved connections)

Before starting, read from the local and remote SDP:
- `FO` is the offerer's and `FA` the answerer's `a=fingerprint:sha-256` value, as 32 raw bytes.
- Each device knows from its signaling role which it is. Anything but exactly one sha-256 fingerprint per side fails.

Steps:
1. Both send `{"t":"auth-n","mode":"pair"|"saved","n":"<b64u of 32 random bytes>"}`.
2. Let `T = "streamdrop-v2\0" || mode || "\0" || FO || FA || NO || NA` (`NO` and `NA` are the two nonces).
3. Both send `{"t":"auth-p","p":"<b64u of HMAC(key, role || T)>"}`, where `role` is `"offer"` or `"answer"`.
4. Each side checks the other's proof in constant time, using the other's role.
5. On success the connection reports `open` to the engine. On failure: `bye{reason:"auth"}`, close, and wait at least 30 s before retrying that device.

The key is `HKDF(ikm=P, info="sd-pair-proof")` in pair mode, and `KA` (section 2.7) in saved mode.

**Nothing but `hello`, `auth-*` and `bye` is processed before success.** This is one gate in `connection.ts`, placed before `ev.open`.

Why it works: the WebRTC stack already checks that the peer holds the certificate matching the SDP fingerprint. Someone in the middle must present their own fingerprint, so the two sides compute different `T` values, and without the key the proof can't be forged. The nonces stop replay and `role` stops a proof being reflected back.

### 2.6 Pairing

1. Device A sends `create`, shows the QR code and link, and B opens them. Both run section 2.5 in `pair` mode.
2. Both show "Save this device?" with the other's name. Names are sent as `{"t":"name","name":"..."}` after authentication, up to 64 characters, and treated as untrusted text.
3. When a side taps Save it sends `{"t":"pair-key","r":"<b64u of 32 random bytes>"}`.
4. When both `r` values are known:
   `K = HKDF(ikm = P || rO || rA, salt = FO || FA, info = "sd-pair-key")`.
5. Each sends `{"t":"pair-ok","c":"<b64u of HMAC(KA, \"confirm\" || role)>"}`, and stores the pair only after checking the other's.

`r` travels inside DTLS, so someone who later finds the old link can't derive `K`. If the proof failed, or there was no `P`, no Save is offered and the connection is labelled "Temporary connection". A browser can take part in an ad hoc transfer with any app; v1 only offers Save in the apps.

### 2.7 Saved connection

Stored per pair: `K` (secret), `roomId`, peer name (renameable, local only), date added, last seen, always-accept flag.

```
roomId = b32( HKDF(ikm=K, info="sd-room")[0..16] )
KA     = HKDF(ikm=K, info="sd-auth")
```

- `roomId` is used with `rejoin` and `listen`, and doubles as the `session` value, so no `session` message is sent.
- After every DataChannel open, including a rejoin after a drop, run section 2.5 in `saved` mode.
- `{"t":"unpair"}`, sent only after authentication, tells the other side to delete the pair. It is a courtesy. Deletion on either side is enough, because the proof can then never succeed.
- `{"t":"bye","reason":"idle"}` closes after 2 minutes with nothing unfinished. The pair stays.

### 2.8 Transfer (v1 protocol, unchanged unless marked)

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
| `rel` | Relative folder path. See section 5.3 for the required checks. Old receivers ignore it and get flat files. |
| Window | At most 16 MiB sent but not acked. The receiver treats more than 2x that as a protocol error. |
| Send buffer | Stop above 4 MiB, continue below 1 MiB. libwebrtc refuses sends once its buffer fills, so implementers must not rely on queuing. |
| Outgoing | One file streams at a time; incoming files can arrive meanwhile |
| Resume | The receiver's `resume-at` is the truth. It may be lower than the last `ack`, because only durable bytes count after a crash. |

`MAX_PENDING` goes up to 500 so it agrees with `MAX_FILES`. A v2 sender also keeps at most 100 offers unanswered, so that it works with old pages.

### 2.9 Versioning

- Additive changes (new fields, new messages, new caps) keep `v`.
- A breaking change raises `v`, and raises `min` when the old one is dropped.
- A feature is used only if the peer listed its cap.
- Old pages and apps then fail with a message, not a hang.

---

## 3. Saved-connection security model

### 3.1 Challenge: is a device keypair needed?

You expected a keypair per device and exchanged public keys. I recommend against it, for now.

| | Secret per pair (recommended) | Keypair per device |
|---|---|---|
| Rendezvous id | Derived from it directly | Still needs a pair secret (static ECDH), so both exist |
| Mutual authentication | HMAC over the fingerprints | Signature over the fingerprints |
| Stop someone who learned the room id | Yes | Yes |
| Past traffic if a key leaks later | Safe: DTLS keys are ephemeral | Same |
| A stolen device | Thief can act as that device until each peer revokes it | Same |
| Revoke | Delete the pair | Delete the pinned key |
| Works in plain WebCrypto, Keystore, Node | Yes | Yes, but curve support differs by platform |
| One identity across many devices | No | **Yes** |

A keypair is worth having only if devices must recognise one identity across many peers: "my laptop" appears on a new phone without pairing again, or a key signs an introduction. Nothing in the brief asks for that. It would be a v3 addition behind a new cap.

Two more ideas rejected:
- **Pinning the DTLS certificate as identity** needs no handshake at all, but a stable fingerprint is visible in the SDP, so the server could track each device. Certificates also expire, and browser ones can't be imported.
- **Reusing the `rejoin` secret as it is** fails because the server sees it. Your instinct to build on `rejoin` is right for the rendezvous; it just must not be the proof.

### 3.2 Short code or fingerprint comparison?

Neither as the main method. A 6-digit code computed from the fingerprints is unsafe on its own: someone in the middle can generate certificates until the code matches, about a million tries. Fixing that needs a commit-and-reveal exchange, plus a screen the user will skip. The key in the QR code proves more with no effort.

- **QR code:** safe against the server and Cloudflare. The camera path doesn't touch them.
- **Link in a chat app:** only as safe as that chat. Someone who reads it and joins first still needs the inviter to tap Save, and the real recipient gets "already used".
- **Typed code:** can't be saved.

### 3.3 Threats

| Attacker | Goal | Result |
|---|---|---|
| Learns the room id | Impersonate a device | **Fails:** no `KA`. Can block the room (`room-full`) or trigger rings, so it is an annoyance only. |
| Malicious server or Cloudflare, app-to-app pair | Read or alter files | **Fails** once paired through the QR or link. |
| Same, during pairing | Insert itself | **Fails:** `P` never reaches it. |
| Same, in any browser | Read files | **Not protected.** It serves the page's JavaScript. Browsers trust the server by nature. Apps don't, as their UI is bundled. |
| Someone who kept an old invite link | Derive `K` | **Fails:** needs `r`, sent inside DTLS. |
| Replays a recorded session | Authenticate | **Fails:** fresh nonces, different fingerprints. |
| Steals `K` from a backup | Act as the device | Blocked by excluding it from backups and using OS storage. |
| Steals an unlocked paired phone | Send files to peers | **Works until revoked.** It can't read or pull anything, because the protocol has no remote browsing. Keep it that way. |
| Paired device goes bad | Send malware | Always-accept is off by default, nothing opens by itself, and files carry a download mark. |
| Malicious file name or `rel` | Write outside the folder | Blocked by the checks in section 5.3. **Native apps are at risk here for the first time:** the web version never used peer names as paths. |

### 3.4 What is and is not protected

Protected:
- File contents and names against the server, Cloudflare and network observers, for app-to-app pairs.
- Device identity on every connection.
- Past transfers, if `K` leaks later.

**Not protected:**
- **Metadata.** The server and Cloudflare can see IP addresses, when each device is online, and which room ids meet. One `listen` socket also shows which ids belong to the same device.
- **Addresses.** Each peer sees the other's IP, STUN sees your IP, and SDP from native clients carries real LAN addresses (browsers hide them).
- **Availability.** The server can refuse service.
- **Browsers,** against a malicious server (see above).
- **A compromised or unlocked device.**
- **Ad hoc rejoin** still uses the existing `session` secret, which the server sees.

**Does a derived room id leak anything?** Nothing about `K`: it is a one-way derivation. It is a stable pseudonym, though. Rotating it daily would add clock handling and hide little, as the IP address already links a device. So it is not worth doing.

### 3.5 Revoking, renaming, lost phone

- **Rename:** local only; the other side's label for you doesn't change.
- **Revoke:** delete the pair. It takes effect at once on that device, and `unpair` tidies the other side if it is reachable.
- **Lost phone:** on each other device, delete the phone from the list. No server step exists, or is needed. There is no "revoke everywhere" button, because there are no accounts. Until you do this, the thief can only send files, and only if the phone is unlocked.
- **New phone or reinstall:** pair again. `K` is deliberately not backed up. To rotate a key, pair again.

### 3.6 Secure storage

Only `K` is secret. `roomId` is stored as ordinary app data, so the listener can start before a keyring is unlocked; `K` is only needed once someone rings.

| System | Storage | Watch out for |
|---|---|---|
| Windows | Electron `safeStorage` (DPAPI [memory]) | Tied to the user account |
| macOS | `safeStorage` (Keychain) | May prompt or block [docs]; test with a signed build |
| Linux | `safeStorage` (libsecret or kwallet) | **Returns `basic_text` when no secret store exists, which is a hardcoded password** [docs]. Check `getSelectedStorageBackend()` and refuse to save, leaving ad hoc transfers working. |
| Android | Random AES-GCM key in the Android Keystore wraps `K`; file in app storage | `allowBackup=false` and backup exclusions. No user-authentication requirement, or a locked phone can't answer. Available after first unlock, so nothing listens before that. |

Check how `safeStorage` behaves at autostart on Linux, when the keyring may still be locked [measure].

---

## 4. Reachability

| Option | Result | Battery / VPS cost | Decision |
|---|---|---|---|
| Desktop tray + autostart, one socket | Reachable whenever it is on | Tiny | **Yes** |
| Phone: app open or recently used | Picks up waiting transfers on open | None | **Yes, default** |
| Phone: foreground service, always on | Reachable while the service runs | Radio wakes every 45 s; [measure] | **Later, opt-in** |
| Phone: periodic background job | 15+ minute gaps, delayed further by Doze; misses the 10-minute room | Low | No |
| FCM high-priority wake | Reachable with no service running | Low on battery; new server work | **No for now** |

**VPS cost.** Idle sockets are cheap. If each ping and pong costs about 200 bytes, 100 devices use roughly 1.2 GB a month, and 10 devices about 0.1 GB, against a 1 TB allowance. File bytes only reach the VPS through TURN, which is not installed.

**Keepalive.** Reports put Cloudflare's idle WebSocket limit at about 100 s [docs, community reports only], hence the 45 s ping, sent by the server. Whether WebSocket ping frames count as activity through the Tunnel is unknown: **measure it in M0.** Apps must reconnect anyway. nginx's 1 h read timeout is fine once pings exist.

**Android limits that shape this:**
- **`dataSync` is limited to 6 hours in 24** for apps targeting Android 15+, and the timer resets when the user opens the app [docs]. Fine for transfers: 20 GiB at 5 MB/s is about 70 minutes. Not usable for an always-on listener.
- **`specialUse`** is the right type for a listener, but Play reviews it [docs]. A sideloaded build avoids that review.
- **Boot:** Android 15 blocks some service types from starting at boot. I recall `dataSync` is one [memory]. So v1 does not restart at boot; the person opens the app once.
- **Doze:** I recall a foreground service keeps network access in Doze [memory], but the CPU can still sleep. Test with `dumpsys deviceidle force-idle`.
- **Battery optimisation:** the "ignore optimisations" permission is restricted on Play [memory], and some vendors kill services regardless. Show a how-to instead of promising reliability.
- **Notifications:** Android 13+ needs `POST_NOTIFICATIONS`. If refused, the transfer still works but an incoming offer can't alert you, so the app must say so. On Android 14+ the service notification can be swiped away [memory].

**FCM: is it worth it?** Not yet. It is the only cheap route to a truly pocketed phone, but it needs:
- a Firebase project and a service key on your VPS;
- Google Play Services on the phone;
- about 4 days of work;
- Google learning when wakes happen.

Tokens can stay on the devices and pass through the server unstored, so it need not break the no-data rule. If you want it later, it plugs into `ring`.

**Phone listener gate:** build "Stay reachable" only if a 24-hour test uses under about 3% battery on your phone. The 3% is my suggestion, not a standard.

---

## 5. Platform details

### 5.1 Android

**Process model.** A `TransferService` owns the WebSocket, `PeerConnection` and engine. Activities only draw state. The service runs as a foreground `dataSync` service while a session is open, and starts before any picker opens.

**The Files-app freeze.** Your finding was about a browser freezing its tab. A foreground service should not be frozen when the picker takes over, so the bug should disappear, but this is **unverified on a real phone** and is on the spike list. The auto-rejoin logic is ported anyway, as networks still drop.

**Choosing files.** `ACTION_OPEN_DOCUMENT` with multiple selection, plus `takePersistableUriPermission` so a file can be reopened after a restart. Reading files needs no storage permission. Read with `openFileDescriptor("r")` and seek. Cloud providers may not be seekable, or may report no size: fall back to a stream and a linear skip, and refuse unknown sizes with a clear message.

**Saving files.** Default: `MediaStore.Downloads`, in `Download/StreamDrop`, with `IS_PENDING=1` while receiving. `minSdk` 29. No copy at the end, so no doubled disk use.
- Pending items expire, typically after 7 days [docs]. Tell the person, and resume only within that time.
- A chosen folder (SAF tree) is optional; some providers can't write randomly, so disable resume for them.
- Check free space before accepting.

**20 GiB without memory growth.** 64 KiB reads into a reused direct buffer. The WebRTC callback's buffer must be copied before returning, onto one writer thread with a queue bounded by the window. Hold a partial wake lock and Wi-Fi lock only during a transfer.

**Resume after the process is killed.** A small JSON file (no database) records id, direction, URI, name, size, `fp`, peer, durable offset; written atomically.
- Receiver: `fsync` every 64 MiB and then record the offset, matching the web's "lose at most one part" promise. On restart, truncate to that offset and send it in `resume-at`.
- Sender: reopen the persisted URI.
- On restart, the app rejoins the pair by itself. `resume`/`resume-at` already does the rest.

**Share sheet.** Handle `ACTION_SEND` and `ACTION_SEND_MULTIPLE` for `*/*`, then show the saved device list.
- **Limit:** shared URIs are temporary grants and can't be made persistable. Pass them to the service with the read flag and `ClipData` so the grant outlives the activity (plausible, not confirmed [docs]; test it).
- If the process dies, the grant is gone. Show "Share this file again" and match by `fp`, as the web already does.

**Pairing on Android.** An in-app QR scanner and "Show my code". Android App Links are a later extra.

### 5.2 Desktop

**Shell.**
- Bundled UI on a privileged `app://streamdrop` protocol, never loaded from the website, which is what keeps the server out of the trust path.
- `contextIsolation`, `sandbox`, a small preload, strict CSP.
- `backgroundThrottling: false` on a hidden window so the engine keeps running.
- Measure idle memory. If it is unpleasant, move `listen` to the main process and create the window on `ring`.

**Web code changes, all small:** a signaling URL setting, an injected `chooseSink`, a bridge for saved devices. `peer.ts` also reads `location.search`, which is harmless.

**Tray and autostart.** Single-instance lock, close-to-tray, `setLoginItemSettings` on Windows and macOS, an XDG autostart file on Linux [memory]. Some GNOME setups show no tray icon without an extension: the app must stay usable from its window. Block sleep only during a transfer.

**Receiving.** A new `fsSink` behind the existing `Sink` interface:
- Writes to `<name>.streamdrop-part` plus a sidecar, in a chosen folder (default `Downloads/StreamDrop`).
- `fsync` every 64 MiB, `resumable: true`.
- Rename on completion; never overwrite, add " (1)" instead.
- Chunks go over IPC. 64 KiB at the 47 MiB/s you measured is about 750 calls a second, which should be fine; [measure].

**Sending.** `webUtils.getPathForFile` keeps the path [memory], so after a restart the app reopens files by itself, where the web version asks you to choose them again. `createSender` needs only `size` and `slice`, so a small file-backed object fits.

**Folders: no zip.** Walk the folder and offer each file with `rel` in batches of up to 500. Reasons: zipping 20 GiB needs temp disk and time before the first byte, and a failure means starting again, whereas per-file sending keeps resume, progress and decline working. Refuse symlinks that leave the folder. The web app keeps refusing folders when sending, but can receive them flat.

**Notifications.** System notification per offer or batch; clicking opens the window. Don't put the file name in if the person prefers privacy (setting, later).

### 5.3 Untrusted input and always-accept (both apps)

Every `name` and `rel` is hostile. The apps MUST reject or clean:
- `..`, absolute paths, drive letters, and backslashes used as separators;
- `:` (NTFS alternate streams), NUL and control characters;
- Windows reserved names (`CON`, `NUL`, `COM1` and so on), and trailing dots and spaces;
- Unicode direction overrides.

Then confirm the final path is inside the target folder. Test vectors cover all of these.

| Connection type | Prompt | Always accept | Auto-connect |
|---|---|---|---|
| Ad hoc | Always | Not available | No |
| Saved (default) | Always | Off | Yes |
| Saved, always accept on | No | Per device, with a size cap | Yes |

Always-accept writes to a subfolder named after the device, never opens anything, and shows a notification. Received files get the system's download mark: Zone.Identifier on Windows, quarantine on macOS.

---

## 6. Phased plan

| # | Milestone | Days | Done when |
|---|---|---|---|
| **M0** | **Foundation** | **8** | |
| | Confirm what is deployed, ship current master | 0.5 | Live site matches master |
| | Fix `MAX_PENDING` and `saved` on resume | 0.5 | Unit tests |
| | `docs/protocol.md` and vectors | 2 | Reviewed |
| | Server: Origin, ping, `listen`/`ring` | 2 | Go tests with `-race`; ghost-room test; Cloudflare idle test passes on the live host |
| | Web: signaling URL, `hello`, auth gate, invite key | 3 | Old-and-new page test; a tampered fingerprint fails |
| **M1** | **Android spike: the risk gate** | **2** | Throwaway app pairs with a browser and moves 2 GiB both ways on your phone: speed, memory, Files-app test, Wi-Fi to mobile data switch |
| **M2** | **Desktop, Linux and Windows** | **13** | |
| | Shell, bundled UI, CSP | 2 | |
| | `fsSink`, file source, resume by path | 3 | Existing e2e scenarios pass in Electron |
| | Saved devices, `safeStorage`, listener | 3 | Two desktops transfer after a restart with no QR |
| | Tray, autostart, notifications | 2 | |
| | Folders, name checks, always-accept | 2 | Hostile-name vectors pass |
| | Packaging and updates | 1 | **First release** |
| **M3** | **Android** | **22** | |
| | Signaling, peer, engine port against the vectors | 6 | Conformance tests |
| | SAF source, MediaStore sink | 4 | |
| | Service, process-death resume | 4 | Kill during a 2 GiB transfer, sha256 matches |
| | Compose UI | 4 | |
| | QR, pairing, Keystore | 2 | |
| | Share sheet, notifications | 2 | **Second release** |
| **M4** | **Interop harness and device matrix** | **6** | Matrix below is green |
| **M5** | **Distribution** (Store MSIX, APK updates, macOS) | **5** | |
| | **Core total** | **56** | About 73 with margin |
| **M6** | **Optional, in this order** | | |
| | "Stay reachable" on Android | 3 | Passes the battery gate |
| | Saved connections in the browser | 3 | |
| | Play Store release | 3, plus at least 14 days' wait | |
| | FCM wake | 4 | |

**If M1 fails** (unstable library, poor speed): try the other community build for a day. If that fails too, pause Android and ship desktop; do not fall back to Capacitor, because it can't meet the large-file and background goals.

**Cut in this order if time runs short:** macOS, always-accept, folders (zip by hand, as today), automatic desktop updates (notify only), the chosen-folder option on Android, in-app QR scanner (paste a link instead).

**Never cut:** the auth gate, name checks, or the resume tests.

### Distribution

| Target | Recommendation | Cost | Notes |
|---|---|---|---|
| Windows | **Microsoft Store MSIX**, plus an unsigned download for those who accept the warning | Free [docs] | The Store signs MSIX for free and individual registration is free. Artifact Signing ($9.99 a month) seems limited to individuals in the US and Canada [docs]. SignPath is free for qualifying open-source projects [docs]. An OV certificate now needs a hardware token or cloud HSM [docs]. |
| macOS | Developer ID, notarised, `electron-updater` | $99 a year [memory] | Build on GitHub's macOS runners. Unsigned is a poor experience, so sign or don't ship. |
| Linux | AppImage (auto-update) and `.deb` | Free | Test tray and keyring on GNOME and KDE. |
| Android | **Signed APK on GitHub Releases**, in-app update check | Free today | See below. Guard the signing key: losing it means reinstalling on every device, and with that, pairing again. |
| Downloads | GitHub Releases, not the VPS | Free | Protects your bandwidth. |

**Sideloading is changing.** Developer verification began on 30 September 2026 in Brazil, Indonesia, Singapore and Thailand, and is planned worldwide in 2027 [docs]. Unverified apps can still be installed through ADB or an "advanced flow" with warnings and a wait; updates are the weak point [docs]. **So register as a verified developer before the global rollout**, even if you stay off Play. Reports conflict on details and the rules have already changed once, so check Google's page closer to the time.

**Play.** A personal account made after 13 November 2023 needs 12 testers opted in for 14 continuous days before production [docs]. Add the `specialUse` review for "Stay reachable". Worth it only if strangers are the audience. The fee is $25, once [memory].

### Testing

**One scenario file, three drivers.** Scenarios live in a shared JSON file: pair, offer N files, decline one, drop the network at 50%, check sha256. Each driver exposes the same few actions:
- Browser: existing Playwright helpers.
- Electron: Playwright's Electron support [memory].
- Android: a debug-only control endpoint reached through `adb forward`, absent from release builds, plus `adb pull` for hashes.

**Test layers.**
1. Unit: `vectors.json` in `node --test` and JUnit, including the two-engine tests ported to Kotlin as a conformance suite. This catches most mistakes, and runs in seconds.
2. Interop, automated on Linux, with your phone by USB.
3. Real networks, by hand, before each release.

**Matrix:** every ordered pair of browser, desktop and Android, both directions at once.

| Scenario | How |
|---|---|
| 0 bytes, odd sizes, Unicode and 255-character names | Fixtures |
| 500-file batch, folder with `rel`, hostile names | Fixtures |
| Decline, cancel, accept all | Driver |
| Network drop mid-file | Phone: `svc wifi disable`. Desktop: netns or firewall rule, a better test than the current closed channel. |
| Process killed | `am kill` / `kill -9` |
| Doze | `dumpsys deviceidle force-idle` |
| Server restart, stale socket | Existing `startServer`/`stopServer` |
| Wrong key, tampered fingerprint, revoked pair | Modified client |
| Old web build against new apps | Pinned `dist` |
| Wi-Fi to mobile data, carrier NAT, Files-app pick | By hand on a real phone |
| 20 GiB once per release | By hand, overnight |

Emulator networking may not work well for WebRTC, so plan on the real phone [measure]. No device was attached when I checked; the SDK (API 34-36), `adb` and JDK 17 are installed. One phone model proves little given vendor battery policies: borrow a Samsung and a Xiaomi once before release.

---

## 7. Open questions, ranked by how much each changes the plan

1. **Must a phone receive while pocketed, with no tap?**
   My default: no, open the app. If yes, "Stay reachable" and possibly FCM move into the core (+3 to +7 days) and battery becomes a main risk.
2. **Who is this for: you and friends, or the public?**
   My default: you and a few others, so APK downloads. Public means Play, the 14-day test, the `specialUse` review, a privacy policy, and support.
3. **Do you own a Mac, and will you pay $99 a year?**
   My default: macOS last, cuttable. With no Mac to test on, I would cut it.
4. **Install the TURN relay?**
   Your earlier test worked on STUN alone, but `track.md` didn't record the networks. If your mobile carrier uses strict NAT, saved connections will fail off Wi-Fi. Test on your own carrier in M1. Relayed bytes count twice against the 600 GB budget, at 24 Mbit/s per session.
5. **Which country are you in, and will the repo be public?**
   Commits show UTC+6. That decides Windows signing outside the Store: Artifact Signing is probably out, and SignPath needs open source.
6. **Is Cloudflare seeing signaling metadata acceptable?**
   My default: yes, since contents are protected. Otherwise `/ws` moves to a direct TLS endpoint on the VPS, which would also allow longer keepalives and save battery, at the cost of a certificate and an open port.
7. **Do you want to keep the keypair anyway?**
   Only if you foresee a single identity across many devices. It costs 3-4 days and more spec.
8. **Do you need saved connections in the browser?**
   My default: no. Browsers can't listen, and their storage can be cleared.
9. **Is a roughly 100 MB desktop download acceptable?**
   My default: yes. If not, the fallback is Tauri with native WebRTC, about 2 weeks more.
10. **Is one peer at a time fine for v1?**
    My default: yes.

---

## 8. What I could not verify

- **No Android, Windows or macOS code was run,** and no WebRTC library was tried. All Android behaviour is from docs or memory until M1.
- **WebKitGTK:** most reports are from 2021-23. It may be better now, but I would still not depend on it across distros.
- **libwebrtc builds:** current versions, maintenance and security update speed. Results conflicted, and one source claimed Google resumed builds, which I could not confirm.
- **Cloudflare:** the 100 s limit comes from community reports, and I found nothing specific to Tunnels. Same for how ping frames count.
- **Battery and throughput:** every figure here is an estimate.
- **Share-sheet grants** surviving in a service, and **`safeStorage` at autostart.**
- **Sizes, prices and fees marked [memory]:** especially Apple's $99, Play's $25, and Electron's size.
- **The security design has had no outside review.** It is built from standard parts, but it is custom. Get someone else to read section 2.5 before release, and don't describe it as audited.
- **Effort figures** assume steady, focused work and some Kotlin and Compose experience; if you're new to Android, add 30-50% to M3.

## Sources

- [Android 15 behavior changes](https://developer.android.com/about/versions/15/behavior-changes-15)
- [Foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)
- [Play: foreground service requirements](https://support.google.com/googleplay/android-developer/answer/13392821?hl=en)
- [MediaStore columns (`DATE_EXPIRES`)](https://d.android.com/reference/android/provider/MediaStore.MediaColumns)
- [Granting permissions on a Uri in an Intent extra](https://commonsware.com/blog/2016/08/31/granting-permissions-uri-intent-extra.html)
- [Android developer verification, June 2026](https://android-developers.googleblog.com/2026/06/android-developer-verification.html)
- [Android developer verification, March 2026](https://android-developers.googleblog.com/2026/03/android-developer-verification-rolling-out-to-all-developers.html)
- [Play closed testing rule](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en-GB)
- [webrtc-sdk/android](https://github.com/webrtc-sdk/android)
- [Electron `safeStorage`](https://electronjs.org/docs/latest/api/safe-storage)
- [wry WebRTC issue](https://github-redirect.dependabot.com/tauri-apps/wry/issues/85)
- [KittyCAD Tauri WebRTC issue](https://github-redirect.dependabot.com/KittyCAD/modeling-app/issues/625)
- [Hopp on WebKit and WebRTC](https://scour.ing/@tyler/p/https://gethopp.app/blog/hate-webkit)
- [Cloudflare community: WebSocket timeout](https://community.cloudflare.com/t/cloudflare-websocket-timeout/5865)
- [Microsoft Store: free individual registration](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/)
- [Microsoft: code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Artifact Signing pricing](https://azure.microsoft.com/pricing/details/trusted-signing/)
- [Microsoft Q&A: individual eligibility](https://learn.microsoft.com/en-us/answers/questions/5810735/cant-create-a-new-trusted-signing-individual-ident)
- [Code signing certificates in 2026](https://codenote.net/ja/posts/ov-ev-code-signing-certificate-pricing-japan-2026/)
