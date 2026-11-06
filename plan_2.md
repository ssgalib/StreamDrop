# StreamDrop: Two Transfer Modes (Direct and Stored)

Status: built and tested locally on 2026-11-06 (see `track.md`); not deployed. Written from `graphify-out/GRAPH_REPORT.md` and the source.

| | **Direct** (exists, gains resume) | **Stored** (new) |
|---|---|---|
| Where the file lives | Only in the two browsers | Encrypted on the VPS for up to 24 h |
| Both people online together? | Yes. After a break, both must come back | No. The sender can leave once the upload ends |
| VPS bandwidth | About 0 | File size up, plus file size for each download |
| VPS disk | 0 | File size, until it expires |
| Size limit | 20 GiB | 2 GiB (proposed) |
| Default | Yes | Opt-in, off until `STORE_GB` is set |

Each transfer picks a mode on the start page. It is not a server-wide switch. Direct ships first and does not depend on Stored.

---

## 1. Decisions needed before Stored is built

Direct mode needs none of these.

| # | Question | Recommendation | Why |
|---|---|---|---|
| 1 | Who may upload? | **Passcode** (`STORE_KEY`), shared with people you trust | An open upload form makes this an anonymous file host on the same VPS as your other sites. You would answer for what people put there. |
| 2 | Encrypt in the browser? | **Yes** | The VPS then holds only unreadable data, and the key stays in the link after `#`, as the invite token does today. The cost: you can't scan or inspect files, and downloads must run through the page (section 4.3). |
| 3 | Send file bytes through Cloudflare? | **Read the terms first, then decide** | See section 2, finding 5. Chunking solves the size limit, not the terms. |
| 4 | Are these limits right? | 2 GiB per file, 5 GB stored in total, 3 GB disk always left free, 24 h expiry, 3 downloads per file | The VPS has 11 GB free (checked today) and other sites need it. |

If the answer to 3 is no, Cloudflare R2 storage would keep the same page flow but move the files off the VPS. That is a different design and is not planned here.

---

## 2. Findings that shaped this plan

**1. Partial data in the current sinks does not survive a tab close. (Tested.)**
`pickerSink` and `opfsSink` use `createWritable()`, which only commits on `close()`. In Chromium, 32 MiB written to a writable that was never closed read back as **0 bytes** after the tab closed. The same 32 MiB written as four closed 8 MiB part files survived a tab close and a full browser restart, and `new Blob(parts)` joined them correctly. The part still open read 0 bytes. The test covered OPFS only. The real save picker can't be driven headless, so its behaviour is assumed to match, and an actual crash was not confirmed (`chrome://crash` may not have fired).

So "keep the partial file" needs a new sink, not a small edit to the old ones.

**2. A room can't be relied on to last until a resume.**
The pasted plan says to keep the room alive. But `Hub.Leave` runs whenever a WebSocket drops, and the socket is idle during a transfer. nginx closes it after 1 h (`proxy_read_timeout`), and Cloudflare reportedly closes idle sockets after about 100 s (community reports, not official docs). Rooms are also in memory, so every deploy wipes them. A room kept for a grace period could expire while the transfer is still running fine.

Instead, the server keeps nothing for resume (section 3.1).

**3. Directory listing order is not file order.**
The test listed `p4, p3, p2, p1, p0`. Parts must be sorted by number before joining them. A wrong order would silently corrupt the file.

**4. Cloudflare rejects request bodies over 100 MB on Free and Pro.**
This is in the [Cloudflare 413 docs](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413), which recommend chunking. nginx also defaults to a 1 MB body limit. Stored mode therefore uploads in 8 MiB chunks.

**5. Cloudflare's terms are a real risk for Stored mode.**
The terms limit serving a disproportionate share of large files through the CDN on non-paid products, and [Cloudflare's policy page](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/) says violations can lead to takedown ([background](https://blog.cloudflare.com/updated-tos/)). Whether Tunnel traffic counts is disputed in forums, and I found no official answer. `streamdrop.kurohane.xyz` shares a tunnel with your other sites, so check the current terms or ask Cloudflare support.

**6. `install-turn.sh` would erase Stored settings.**
Line 17 writes `/etc/streamdrop/env` with `>` when `TURN_SECRET` is missing. It must become `>>`.

**7. The budget only runs when the relay is on.**
`newBudget` is created inside the `TURN_SECRET` branch of `main.go`, and only `scan` adds bytes. Stored mode needs it to run on its own and to share the same 600 GB.

---

## 3. Direct mode: resume

### What it covers

| Interruption | Resumes? | Lost |
|---|---|---|
| Network drop, both tabs stay open | Yes, automatically, on every sink | Nothing (sender continues from `stored`) |
| Receiver refresh or tab close, OPFS sink | Yes, after clicking Resume | Up to 64 MiB (the open part) |
| Receiver refresh or tab close, picker or memory sink | No, starts again | Everything received |
| Sender refresh or tab close | Yes, after re-selecting the file | Nothing on the receiver's side |
| Server restart or deploy | Yes | Nothing |
| Other person never returns | No, Discard clears it | The window is 24 h, set by OPFS cleanup |

### 3.1 Server: stateless `rejoin` (`server/hub.go`, `server/signal.go`)

The sender creates a random 128-bit `id` for each transfer and sends it in `meta`, over the encrypted DataChannel. The server first sees it when someone rejoins.

`{type:"rejoin", token:id}` is a get-or-create:

- No room for that key: create one with this peer as creator, and reply `created`.
- Room exists: join it, and reply `joined` / `peer-joined`.

Everything after that is the existing path, including fresh relay credentials, and the first to arrive sends the offer. `Leave`, `Sweep` and `tokenTTL` don't change.

- Add `Hub.Rejoin(id, p)`, reusing the `Create` and `Join` bodies. Keep the checks: `maxRooms`, `ErrRoomFull`.
- Key rooms as `"r:" + id`, so `rejoin` can never reach an invite token.
- Validate `id` at the boundary: base32, 26 characters, the same form as `rand.Text()`.
- Share the `join` branch of `handle` for sending `joined` and `peer-joined`.
- Tests in `hub_test.go` / `signal_test.go`: both arrival orders, a third peer gets `room-full`, a bad id is rejected, an invite token isn't reachable, an unpaired rejoin room expires.

### 3.2 Sink (`web/src/sinks.ts`)

- New `opfsPartsSink(id, type)`: writes to OPFS directory `resume-<id>/`, closing the current part and starting the next once it reaches 64 MiB. Part sizes need not be aligned, because the offset is the sum of closed part sizes.
- New `openParts(id)` for a reload: deletes 0-byte parts, sorts by number, returns the sink and its offset.
- `close()`: `new Blob(sortedFiles, {type})`, then the existing `downloadBlob`. `abort()`: remove the directory.
- `chooseSink`: **try OPFS parts before the picker**, when `size * 2` fits the quota, so most transfers survive a tab close. The picker stays as the fallback for files too large for the quota.
  - Behaviour change: on desktop Chrome, files go to Downloads with no "Save as" dialog. If you prefer the dialog, keep the picker first and accept that those transfers can't survive a tab close.
- `cleanOpfs`: also remove directories. It only handles files today, so `resume-*` folders would otherwise never be cleaned. Age comes from the newest part.

### 3.3 Transfer (`web/src/transfer.ts`)

- `createSender(..., start = 0)`: `sent` and `acked` begin at `start`.
- `createReceiver(..., start = 0)`: `arrived`, `stored` and `lastAck` begin at `start`. Expose `flush()` (awaits `queue`, returns `stored`), so an offset is only reported once writes have landed.
- `parseMeta`: validate the new `id` and `fp` fields, since the peer controls them.
- New `fingerprint(file)`: SHA-256 over size, `lastModified`, and the first and last 1 MiB. Hashing the whole file would take too long at 20 GiB. An edit in the middle that keeps the same size and timestamp would go undetected, which is very unlikely.
- New messages, with every field validated:

| Message | Direction | Meaning |
|---|---|---|
| `{t:"resume", id, fp}` | sender → receiver | Sent when the channel reopens |
| `{t:"resume-at", bytes}` | receiver → sender | Continue here. Sender checks `0 <= bytes <= file.size` |
| `{t:"reject", reason:"unknown"}` | receiver → sender | No record or `fp` differs. Reuses `reject` and offers a fresh start |

### 3.4 Page (`web/src/main.ts`, `web/index.html`)

- Add a `"paused"` state. `peerLost` pauses instead of ending when a transfer is `active` and has an `id`.
- `peerLost` can fire up to three times for one drop (`disconnected`, `failed`, `closed`). Only the first may act. Close the old peer and ignore events from it, or a late `closed` will pause the new connection.
- The drop path: receiver awaits `flush()`, both call `connect({type:"rejoin", token:id})`, show "Reconnecting…", and the sender sends `resume` on `open`.
- `connect`'s `created` handler must skip the invite and QR UI while rejoining. The `expired` branch must retry while paused, or a person waiting over 10 minutes would be dropped.
- Save `{id, role, name, size, type, fp}` to `localStorage` at Accept, and clear it on finish, cancel or Discard. Wrap reads in try/catch.
- On load, if a record exists, show "Unfinished: name (43%)" with **Resume** and **Discard**. The sender's Resume opens the file picker and compares `fp` before rejoining.
- Show a plain message when the file doesn't match: "This isn't the same file."
- Extend the `beforeunload` guard to `paused`.

### 3.5 Known limit

If the connection drops after the receiver finished but before `saved` arrives, the sender waits with nobody coming back. It keeps showing "Reconnecting…" until Discard. The file arrived, so this is cosmetic.

### 3.6 Done when

- Unit (`transfer.test.ts`): sender and receiver with `start > 0`, a file not a multiple of the chunk size, `fingerprint`, `parseMeta` with bad fields, part sort order with 10 or more parts.
- e2e (`web/e2e/`), sha256 must match the original in every case:
  - network drop mid-transfer, both tabs open (`context.setOffline`)
  - receiver reload at 50% on OPFS. The current e2e forces the memory sink, so this needs a persistent profile
  - sender reload at 50%, same file re-selected
  - wrong file re-selected: refused
  - server restarted during the pause
- 2 GiB transfer on OPFS parts, with speed compared against the 36 MiB/s baseline. A 64 MiB part close must not cause a visible stall.

---

## 4. Stored mode

### 4.1 Flow

```
Sender page                     VPS (Go)                       Receiver page
  pick file, enter passcode
  generate AES key
  POST /store  ---------------> reserve space, return id + writeToken
  PUT /store/{id}/{n}  -------> save encrypted chunk (8 MiB each)
  POST /store/{id}/finish ----> mark ready
  show link /#s/<id>.<key>
  (sender can now leave)
                                GET /store/{id}  <------------ encrypted name, chunk count, expiry
                                GET /store/{id}/{n}  <-------- chunks, decrypted into the sink
```

### 4.2 Server: new `server/store.go`, about 200 lines

Off unless `STORE_GB` is set, matching how the relay is enabled.

**Layout:** `$STATE_DIRECTORY/files/<id>/meta.json` plus one file per chunk. `ProtectSystem=strict` already allows this path through `StateDirectory`, so the unit doesn't change. There is no database. Each chunk is written to a temp name and renamed, so a half-written chunk is never served.

| Route | Auth | Purpose |
|---|---|---|
| `GET /store` | none | `{enabled, maxBytes, ttlHours}`, so the page can hide the option |
| `POST /store` | `STORE_KEY` | Checks limits, reserves space, returns `id`, `writeToken`, `expiresAt` |
| `PUT /store/{id}/{n}` | `writeToken` | One chunk, body capped with `http.MaxBytesReader` |
| `POST /store/{id}/finish` | `writeToken` | Requires every chunk present. Readers get 404 until then |
| `DELETE /store/{id}` | `writeToken` | Sender removes the file early |
| `GET /store/{id}` | link | Encrypted metadata, chunk count, expiry |
| `GET /store/{id}/{n}` | link | One chunk, with `Cache-Control: no-store` |

**Must not be skipped:**

- `id` must match the `rand.Text()` form and `n` must be an integer in range, both checked **before** any path is built. This is the path traversal guard.
- `crypto/subtle.ConstantTimeCompare` for `STORE_KEY` and `writeToken`.
- `POST /store` refuses if the total would pass `STORE_GB`, if `syscall.Statfs` shows the free-disk floor would be crossed, or if the file is over the size limit. Each chunk write rechecks the floor, so a full disk stops uploads before it hurts other sites.
- Unfinished uploads expire after 1 h, so abandoned reservations free their space. Finished files expire after 24 h.
- A per-request deadline through `http.NewResponseController`, because the server has no global timeouts (the WebSocket handler needs none).
- Downloads stop at 3× file size served. `shortcut: the served count is in memory and resets on restart, persist it in meta.json if restarts become frequent.`
- Startup scans `files/` to rebuild the used total and delete anything expired, so restarts leak nothing. The sweep joins the existing 30 s ticker in `main.go`.
- Log no ids or tokens, matching the current rule.

**Budget (`server/budget.go`, `server/main.go`):**

- Build the budget when the relay **or** Stored is on. Start `Tail` only for the relay.
- Add `Budget.Add(n)`, and pull the save code out of `scan` into a shared `save()`.
- Check `Allow()` before each chunk read or write, and return 503 when used up. Count each chunk when it is transferred, so Stored can only overshoot by the chunks in flight.
- The 600 GB stays one shared total with the relay. A file uploaded and downloaded once uses twice its size, so the budget covers about 300 GB of files a month, or about 150 GB if every file is downloaded 3 times.
- Tunnel and TLS overhead isn't counted. Keep checking the provider's panel monthly.

### 4.3 Encryption and page (new `web/src/store.ts`, `main.ts`, `index.html`)

- AES-256-GCM with `crypto.subtle`, one fresh key per file. The key goes in the link after `#`, so the server never sees it.
- IV comes from the chunk index, and the additional authenticated data is the index plus the total chunk count, so the server can't reorder or truncate chunks unnoticed.
- Upload retries must resend **the same encrypted buffer**, never re-encrypt. If the file changed on disk, re-encrypting would reuse an IV with different data, which breaks GCM.
- Name, type and size are encrypted the same way into the `POST /store` body.
- Upload: sequential chunks, 3 retries each, progress through the existing `showProgress`.
- Download: `chooseSink` from the Download click, then fetch, decrypt and `sink.write` per chunk, with the same retries. Reuses all three sinks.
  - Limit: on a browser with neither picker nor OPFS, files over 512 MiB fail with the existing error.
- Start page gets a second action, "Upload for later", shown only when `GET /store` says enabled, with a passcode field.
- Link format `/#s/<id>.<key>`. Extend the hash check at the end of `main.ts`: `#s/` opens the download view, anything else joins as today. Remove the hash from the address bar as today.
- Link shown as text and QR, reusing `drawQr`, plus the expiry time and a Delete button.
- The filename is untrusted: `textContent` only, as with `offer-name`.

### 4.4 Deploy

- `deploy/nginx-streamdrop.conf`: add `location /store` with `proxy_pass`, the same `X-Forwarded-For` line as `/ws`, `client_max_body_size 9m`, `proxy_request_buffering off`, `proxy_buffering off`. The buffering settings stop nginx spooling chunks to the shared disk.
- CSP needs no change: `connect-src 'self'` covers `fetch`.
- `web/vite.config.ts`: proxy `/store` for development.
- `deploy/install-turn.sh`: fix line 17 (finding 6).
- `/etc/streamdrop/env`: add `STORE_GB=5`, `STORE_KEY=<openssl rand -hex 16>`, by hand. `RELAY_BUDGET_GB` is misleadingly named now, but keep it so a running setup doesn't change.
- You run `deploy/deploy.sh`, since it needs sudo.

### 4.5 Done when

- Go tests (`store_test.go`): wrong passcode, wrong `writeToken`, bad `id` and `n` including `../`, oversized chunk, total cap, disk floor, not readable before `finish`, expiry, restart rebuilds totals, download limit, budget stops reads and writes, `Budget.Add` survives restart and rolls over monthly. Run with `-race`.
- Unit: encrypt then decrypt round trip, tampered chunk fails, swapped chunks fail.
- e2e: upload, **close the sender**, download in a new browser, sha256 matches, with a file that isn't a multiple of 8 MiB, and a zero-byte file.
- Check on the VPS: a file on disk contains no plaintext, a 500 MiB file works through the real tunnel, `df` shows the space returns after expiry, other sites still return 200.

---

## 5. Order of work

1. Direct: `rejoin` on the server and its tests.
2. Direct: resume in `transfer.ts` and automatic reconnect with tabs open. This is usable by itself.
3. Direct: `opfsPartsSink`, the Resume prompt, and reload tests.
4. Deploy and try it between two real devices.
5. Get answers to section 1.
6. Stored: `store.go`, budget changes, Go tests.
7. Stored: `store.ts`, page, e2e.
8. Stored: nginx, env, deploy, VPS checks.

Update when each mode lands:

- `README.md`: the opening line ("never stored"), "Nothing is stored for later", "There is no resume", "Nothing needs backing up", the layout list, the new limits, and how to remove a reported file (`rm -rf` of its folder under `/var/lib/streamdrop/files/`).
- `project-plan.md`: lines 69, 823 and 828 list resume, server storage and extra encryption as left out.
- `track.md`: progress and results.

## 6. Left out

- Resuming an upload or download after a page reload in Stored mode. Retries cover short drops, and a reload restarts it.
- Saving the sender's file handle so it needn't re-select (`showOpenFilePicker` + IndexedDB).
- Resume for picker and memory sinks after a tab close.
- Parallel chunk uploads, accounts, multiple recipients, malware scanning (impossible with encryption).
- Switching a live Direct transfer to Stored when someone leaves.
