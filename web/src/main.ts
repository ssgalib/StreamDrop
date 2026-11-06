import { createPeer, type Signal } from "./peer";
import {
  CHUNK, createReceiver, createSender, fingerprint, newTransferId, parseMeta, parseResume, parseResumeAt,
  type Meta, type Sink,
} from "./transfer";
import { chooseSink, cleanOpfs, discardParts, openParts, partsOffset } from "./sinks";
import { drawQr } from "./qr";
import { fmtSize } from "./format";
import { initStored, openStoredLink } from "./stored";
import { parseStoredLink } from "./store";
import "./style.css";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const startSection = $("#start");
const roomSection = $("#room");
const shareP = $("#share");
const tokenEl = $("#token");
const linkEl = $<HTMLInputElement>("#link");
const copyBtn = $("#copy");
const renewDiv = $("#renew");
const qrDiv = $("#qr");
const tokenInput = $<HTMLInputElement>("#token-input");
const senderDiv = $("#sender");
const fileInput = $<HTMLInputElement>("#file");
const offerDiv = $("#offer");
const transferDiv = $("#transfer");
const progressEl = $<HTMLProgressElement>("#progress");
const pctEl = $("#pct");
const statusEl = $("#status");
const errorEl = $("#error");
const unfinishedSection = $("#unfinished");
const resumeBtn = $("#resume");
const resumeFile = $<HTMLInputElement>("#resume-file");

const setStatus = (t: string) => (statusEl.textContent = t);
const showError = (t: string) => (errorEl.textContent = t);

const errorText: Record<string, string> = {
  "bad-message": "The server rejected a message.",
  "invalid-token": "That link isn't valid. Ask the sender for a new one.",
  expired: "This link has expired. Ask the sender for a new one.",
  "room-full": "This link has already been used.",
  "already-in-room": "Already in a room.",
  "not-paired": "No peer is connected yet.",
  "server-busy": "The server is busy. Try again later.",
};

function fmtTime(s: number) {
  if (s < 60) return `${Math.ceil(s)} s`;
  if (s < 3600) return `${Math.ceil(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

let samples: [number, number][] = []; // [time, bytes] over the last 5 s, for a steady speed
let lastPaint = 0;

function showProgress(done: number, total: number) {
  const now = performance.now();
  if (done === 0) samples = [];
  samples.push([now, done]);
  while (samples.length > 1 && now - samples[0][0] > 5000) samples.shift();
  if (done > 0 && done < total && now - lastPaint < 500) return; // at most twice a second
  lastPaint = now;
  progressEl.max = total || 1;
  progressEl.value = done;
  const [t0, b0] = samples[0];
  const rate = now > t0 ? ((done - b0) * 1000) / (now - t0) : 0;
  let text = `${total ? Math.floor((done / total) * 100) : 100}% · ${fmtSize(done)} of ${fmtSize(total)}`;
  if (rate > 0 && done < total) text += ` · ${fmtSize(rate)}/s · ${fmtTime((total - done) / rate)} left`;
  pctEl.textContent = text;
}

let ws: WebSocket | undefined;
let peer: ReturnType<typeof createPeer> | undefined;
let channelOpen = false;

// One transfer at a time. "offered": meta sent or received, waiting for Accept. "active": bytes flowing.
// "paused": the connection dropped; both sides keep what they have and reconnect through the same transfer id.
type Role = "sender" | "receiver";
let state: "idle" | "offered" | "active" | "paused" = "idle";
let role: Role | undefined;
let transferId: string | undefined; // set when both sides can resume
let transferFp: string | undefined;
let transferMeta: Meta | undefined;
let resumeOffset = 0; // receiver: bytes already stored
let pendingFile: File | undefined;
let incoming: Meta | undefined;
let sender: ReturnType<typeof createSender> | undefined;
let receiver: ReturnType<typeof createReceiver> | undefined;
let sink: Sink | undefined;
let lock: WakeLockSentinel | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

// Closing the tab mid-transfer would lose the file.
addEventListener("beforeunload", (e) => { if (state === "active" || state === "paused") e.preventDefault(); });

// What an interrupted transfer needs after a reload. Reads are wrapped: storage can be blocked.
const RECORD_KEY = "streamdrop-transfer";
type SavedTransfer = Meta & { id: string; fp: string; role: Role };

function saveRecord() {
  try {
    if (transferId && transferFp && role && transferMeta) {
      localStorage.setItem(RECORD_KEY, JSON.stringify({ ...transferMeta, id: transferId, fp: transferFp, role }));
    }
  } catch { /* storage blocked: the transfer just can't resume after a reload */ }
}

function clearRecord() {
  try { localStorage.removeItem(RECORD_KEY); } catch { /* ignore */ }
}

function loadRecord(): SavedTransfer | null {
  try {
    const raw = JSON.parse(localStorage.getItem(RECORD_KEY) ?? "null");
    const m = parseMeta(raw); // the stored text is untrusted too
    if (m?.id && m.fp && (raw.role === "sender" || raw.role === "receiver")) return { ...m, id: m.id, fp: m.fp, role: raw.role };
  } catch { /* none or corrupt */ }
  return null;
}

const sendCtl = (m: object) => peer!.channel().send(JSON.stringify(m));

function resetTransfer() {
  state = "idle";
  clearTimeout(retryTimer);
  pendingFile = incoming = sender = receiver = sink = undefined;
  role = transferId = transferFp = transferMeta = undefined;
  resumeOffset = 0;
  clearRecord();
  offerDiv.hidden = transferDiv.hidden = true;
  void lock?.release();
  lock = null;
  fileInput.value = "";
  fileInput.disabled = !channelOpen;
}

// Stop a transfer that did not finish: drop what was received and tell the user why.
function endTransfer(message: string) {
  const wasPaused = state === "paused";
  sender?.cancel();
  void sink?.abort();
  resetTransfer();
  if (wasPaused) leaveRoom(); // nobody is coming back: stop waiting in the room
  showError(message);
}

// Drop the signaling socket and any half-built connection, and go back to the start page.
function leaveRoom() {
  if (ws) ws.onmessage = ws.onclose = ws.onerror = null;
  ws?.close();
  ws = undefined;
  peer?.close();
  peer = undefined;
  channelOpen = false;
  startSection.hidden = false;
  roomSection.hidden = true;
  setStatus("Not connected");
}

// Local failure: also tell the peer so it stops too.
function abortTransfer(message: string) {
  try { sendCtl({ t: "cancel" }); } catch { /* channel already gone */ }
  endTransfer(message);
}

const fail = (err: unknown) => {
  // Already paused: a send or write that was in flight when the connection dropped. Nothing is wrong.
  if (state === "paused") return;
  // A send or write that fails because the channel died is a lost connection, not a failed transfer:
  // pause, and carry on when both sides are back. pause() is defined below; calls happen later.
  if (state === "active" && transferId && peer && peer.channel().readyState !== "open") return pause();
  abortTransfer(
    err instanceof Error && err.name === "QuotaExceededError"
      ? "Not enough disk space"
      : err instanceof Error ? err.message : String(err),
  );
};

function startSending(file: File, from: number) {
  const chunk = Math.min(CHUNK, peer!.maxMessageSize() ?? CHUNK);
  sender = createSender(file, peer!.channel(), chunk, (n) => showProgress(n, file.size), from);
  sender.run().catch(fail);
}

function startTransfer() {
  state = "active";
  offerDiv.hidden = true;
  transferDiv.hidden = false;
  // Keeps the screen on so the tab isn't suspended; a refusal is fine.
  navigator.wakeLock?.request("screen").then((l) => {
    if (state === "active") lock = l;
    else void l.release();
  }, () => {});
}

function onControl(msg: any) {
  switch (msg.t) {
    case "meta": {
      const meta = state === "idle" ? parseMeta(msg) : null;
      if (!meta) {
        sendCtl({ t: "reject", reason: "invalid" });
        showError("Peer sent an invalid file offer.");
        return;
      }
      incoming = meta;
      role = "receiver";
      transferId = meta.id;
      transferFp = meta.fp;
      transferMeta = { name: meta.name, size: meta.size, type: meta.type };
      state = "offered";
      $("#offer-name").textContent = meta.name; // textContent only: the name is untrusted
      $("#offer-size").textContent = fmtSize(meta.size);
      offerDiv.hidden = false;
      $("#accept").focus();
      break;
    }
    case "accept": {
      const file = pendingFile;
      if (state !== "offered" || !file) return;
      startTransfer();
      showProgress(0, file.size);
      setStatus("Sending");
      saveRecord();
      startSending(file, 0);
      break;
    }
    case "resume": {
      // Receiver: the sender came back. Only the transfer we kept can resume, and only with the same file.
      const r = parseResume(msg);
      if (state !== "paused" || role !== "receiver" || !sink || !transferMeta || !r || r.id !== transferId || r.fp !== transferFp) {
        sendCtl({ t: "reject", reason: "unknown" });
        return;
      }
      const m = transferMeta;
      sendCtl({ t: "resume-at", bytes: resumeOffset });
      receiver = createReceiver(m.size, sink, peer!.channel(), (n) => showProgress(n, m.size), fail, resumeOffset);
      startTransfer();
      showProgress(resumeOffset, m.size);
      setStatus("Receiving");
      break;
    }
    case "resume-at": {
      // Sender: carry on from where the receiver says it has everything.
      const bytes = parseResumeAt(msg, pendingFile?.size ?? -1);
      if (state !== "paused" || role !== "sender" || !pendingFile || bytes === null) return;
      startTransfer();
      showProgress(bytes, pendingFile.size);
      setStatus("Sending");
      startSending(pendingFile, bytes);
      break;
    }
    case "reject":
      if (state === "paused" && role === "sender") {
        endTransfer("The other person no longer has this transfer. Choose the file again to start over.");
        return;
      }
      if (state !== "offered") return;
      resetTransfer();
      showError(msg.reason === "declined" || typeof msg.reason !== "string"
        ? "Receiver declined the file."
        : `Receiver can't take the file: ${msg.reason.slice(0, 200)}`);
      setStatus("Connected");
      break;
    case "ack":
      if (typeof msg.bytes === "number") sender?.ack(msg.bytes);
      break;
    case "done":
      if (!receiver) return fail(new Error("Unexpected end of file"));
      setStatus("Finalizing…");
      receiver.done().then(() => {
        resetTransfer();
        setStatus("File received");
      }, fail);
      break;
    case "saved":
      if (state !== "active" || !sender) return;
      resetTransfer();
      setStatus("Complete");
      break;
    case "cancel":
      if (state === "idle") return;
      endTransfer("Peer cancelled the transfer.");
      setStatus("Connected");
      break;
  }
}

// The connection dropped mid-transfer. Keep what we have and reconnect through the same transfer id.
function pause() {
  if (state === "paused") return; // a drop can report several times; only the first acts
  state = "paused";
  channelOpen = false;
  fileInput.disabled = true;
  sender?.cancel();
  sender = undefined;
  const r = receiver;
  receiver = undefined;
  peer?.close(); // marks it dead, so its late events are ignored
  peer = undefined;
  void lock?.release();
  lock = null;
  setStatus("Reconnecting…");
  showError("");
  void (async () => {
    if (r) resumeOffset = await r.flush(); // writes already queued still land, so the offset is exact
    scheduleRejoin(0);
  })();
}

function scheduleRejoin(delay: number) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (state === "paused" && transferId) connect({ type: "rejoin", token: transferId });
  }, delay);
}

// A crashed tab may never close its channel cleanly, so "disconnected" and "failed" count as lost too.
function peerLost(failed = false) {
  if (state === "active" && transferId) return pause();
  if (state === "paused") {
    // The new connection failed before it opened: start over after a moment.
    peer?.close();
    peer = undefined;
    scheduleRejoin(2000);
    return;
  }
  setStatus("Peer disconnected");
  if (state !== "idle") endTransfer("The other person disconnected. The transfer stopped.");
  else if (failed && !channelOpen) showError("Couldn't connect the two devices.");
}

const events = {
  signal: (s: Signal) => ws?.send(JSON.stringify(s)),
  state(text: string) {
    if (text === "failed" || text === "disconnected") peerLost(text === "failed");
    else if (state !== "paused") setStatus(text === "connected" ? "Connected" : "Connecting");
  },
  open() {
    channelOpen = true;
    clearTimeout(retryTimer);
    if (state === "paused") {
      setStatus("Resuming…");
      // The sender speaks first; the receiver waits for it.
      if (role === "sender") sendCtl({ t: "resume", id: transferId, fp: transferFp });
      return;
    }
    fileInput.disabled = state !== "idle";
    setStatus("Connected");
  },
  closed() {
    channelOpen = false;
    fileInput.disabled = true;
    peerLost();
  },
  message(data: string | ArrayBuffer) {
    try {
      if (typeof data === "string") return onControl(JSON.parse(data));
      if (state === "active" && receiver) return receiver.chunk(data);
      // Idle: chunks still in flight after a cancel or failure. Only data before Accept is a protocol error.
      if (state === "offered") fail(new Error("Unexpected data from peer"));
    } catch (err) {
      fail(err);
    }
  },
  low: () => sender?.wake(),
};

function connect(first: { type: string; token?: string }) {
  showError("");
  if (ws) ws.onmessage = ws.onclose = ws.onerror = null; // drop the socket from a failed join or an old room
  ws?.close();
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => ws!.send(JSON.stringify(first));
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    try {
      switch (msg.type) {
        case "created":
          if (first.type === "rejoin") {
            // Reconnecting: we are first back, so wait quietly. No invite link, the other side knows the id.
            startSection.hidden = true;
            roomSection.hidden = false;
            renewDiv.hidden = true;
            setStatus("Reconnecting…");
            break;
          }
          startSection.hidden = true;
          roomSection.hidden = shareP.hidden = senderDiv.hidden = false;
          renewDiv.hidden = true;
          tokenEl.textContent = msg.token;
          linkEl.value = `${location.origin}/#${msg.token}`;
          drawQr($<SVGSVGElement & HTMLElement>("#qr-code"), linkEl.value);
          qrDiv.hidden = false;
          copyBtn.focus();
          setStatus("Waiting for peer");
          break;
        case "joined":
          startSection.hidden = true;
          roomSection.hidden = false;
          peer = createPeer(false, msg.iceServers ?? [], events);
          setStatus("Connecting");
          break;
        case "peer-joined":
          qrDiv.hidden = true; // the link is used up
          peer = createPeer(true, msg.iceServers ?? [], events);
          setStatus("Connecting");
          await peer.start();
          break;
        case "offer":
        case "answer":
        case "candidate":
          await peer?.handle(msg);
          break;
        case "peer-left":
          // The direct connection reports its own failure.
          if (channelOpen) break;
          if (state === "paused") {
            // The other side dropped again before the connection opened: wait for it in a fresh room.
            peer?.close();
            peer = undefined;
            scheduleRejoin(1000);
            break;
          }
          peer?.close();
          setStatus("Peer left. Reload to start again.");
          break;
        case "error":
          if (state === "paused") {
            // Room full, expired, server busy or restarting: all pass with a retry.
            if (msg.code === "invalid-token") showError(errorText[msg.code]);
            else scheduleRejoin(2000);
            break;
          }
          if (msg.code === "expired" && !shareP.hidden && !peer) {
            // Our own waiting room timed out: drop the dead link and offer a fresh one.
            shareP.hidden = qrDiv.hidden = true;
            renewDiv.hidden = false;
            setStatus("Link expired");
            showError("Link expired.");
            break;
          }
          showError(errorText[msg.code] ?? `Server error: ${msg.code}`);
          break;
      }
    } catch (err) {
      showError(String(err));
    }
  };
  ws.onerror = ws.onclose = () => {
    // An open DataChannel doesn't need signaling, so leave it running.
    if (channelOpen) setStatus("Connected (signaling is down)");
    else if (state === "paused") scheduleRejoin(2000); // signaling lost while reconnecting
    else if (!peer && renewDiv.hidden) showError("Cannot reach the server."); // an expired room closes its socket on purpose
  };
}

$("#create").addEventListener("click", () => connect({ type: "create" }));
$("#renew-btn").addEventListener("click", () => connect({ type: "create" }));
copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(linkEl.value).then(
    () => {
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = "Copy"), 2000);
    },
    () => linkEl.select(), // clipboard blocked: select it so Ctrl+C works
  );
});
$("#join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  connect({ type: "join", token: tokenInput.value.trim() });
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file || state !== "idle" || !channelOpen) return;
  showError("");
  pendingFile = file;
  state = "offered";
  role = "sender";
  transferId = newTransferId();
  fileInput.disabled = true;
  transferDiv.hidden = false;
  showProgress(0, file.size);
  setStatus("Waiting for receiver to accept");
  const fp = await fingerprint(file);
  if (state !== "offered" || pendingFile !== file) return; // cancelled while hashing
  transferFp = fp;
  transferMeta = { name: file.name, size: file.size, type: file.type };
  sendCtl({ t: "meta", ...transferMeta, id: transferId, fp });
});

$("#accept").addEventListener("click", async () => {
  const m = incoming;
  if (state !== "offered" || !m) return;
  showError("");
  let s: Sink;
  try {
    s = await chooseSink(m); // first await in the handler: the save picker needs the click
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return; // picker cancelled: stay on the prompt
    const reason = err instanceof Error ? err.message : String(err);
    sendCtl({ t: "reject", reason });
    resetTransfer();
    showError(reason);
    return;
  }
  if (state !== "offered" || incoming !== m) return void s.abort(); // peer cancelled while the picker was open
  sink = s;
  receiver = createReceiver(m.size, sink, peer!.channel(), (n) => showProgress(n, m.size), fail);
  startTransfer();
  showProgress(0, m.size);
  setStatus("Receiving");
  if (sink.resumable) saveRecord(); // only a sink that survives a tab close can resume after a reload
  sendCtl({ t: "accept" });
});

$("#decline").addEventListener("click", () => {
  if (state !== "offered") return;
  sendCtl({ t: "reject", reason: "declined" });
  resetTransfer();
});

$("#cancel").addEventListener("click", () => {
  if (state === "idle") return;
  abortTransfer("Transfer cancelled.");
  setStatus("Connected");
});

void cleanOpfs();

// After a reload: offer to carry on with a transfer that was interrupted.
async function showUnfinished() {
  const rec = loadRecord();
  if (!rec) return;
  $("#unfinished-name").textContent = rec.name; // textContent only
  if (rec.role === "receiver") {
    const done = await partsOffset(rec.id);
    $("#unfinished-pct").textContent = rec.size ? `(${Math.floor((done / rec.size) * 100)}% saved)` : "";
    resumeBtn.hidden = false;
    $("#unfinished-sender").hidden = true;
  } else {
    $("#unfinished-pct").textContent = "";
    resumeBtn.hidden = true;
    $("#unfinished-sender").hidden = false;
  }
  unfinishedSection.hidden = false;
}

function resumeUi(rec: SavedTransfer, done: number) {
  unfinishedSection.hidden = true;
  showError("");
  role = rec.role;
  transferId = rec.id;
  transferFp = rec.fp;
  transferMeta = { name: rec.name, size: rec.size, type: rec.type };
  state = "paused";
  startSection.hidden = true;
  roomSection.hidden = false;
  transferDiv.hidden = false;
  showProgress(done, rec.size);
  setStatus("Reconnecting…");
  connect({ type: "rejoin", token: rec.id });
}

resumeBtn.addEventListener("click", async () => {
  const rec = loadRecord();
  if (!rec || rec.role !== "receiver") return;
  try {
    const opened = await openParts(rec.id, rec.name, rec.type);
    sink = opened.sink;
    resumeOffset = opened.offset;
    resumeUi(rec, opened.offset);
  } catch {
    clearRecord();
    unfinishedSection.hidden = true;
    showError("This browser can't continue that transfer. Ask the sender to send the file again.");
  }
});

resumeFile.addEventListener("change", async () => {
  const file = resumeFile.files?.[0];
  const rec = loadRecord();
  if (!file || !rec || rec.role !== "sender") return;
  if (file.size !== rec.size || (await fingerprint(file)) !== rec.fp) {
    resumeFile.value = "";
    showError("This isn't the same file.");
    return;
  }
  pendingFile = file;
  resumeUi(rec, 0);
});

$("#discard").addEventListener("click", async () => {
  const rec = loadRecord();
  clearRecord();
  unfinishedSection.hidden = true;
  if (rec?.role === "receiver") await discardParts(rec.id);
});

// Links carry their secret after "#", which the server never sees. Take it out of the address bar.
const stored = parseStoredLink(location.hash);
const linkToken = location.hash.slice(1);
if (stored) {
  history.replaceState(null, "", location.pathname + location.search);
  void openStoredLink(stored);
} else if (linkToken) {
  history.replaceState(null, "", location.pathname + location.search);
  tokenInput.value = linkToken;
  connect({ type: "join", token: linkToken });
} else {
  void showUnfinished();
  void initStored();
}
