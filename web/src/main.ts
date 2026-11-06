import { createPeer, type Signal } from "./peer";
import { CHUNK, createReceiver, createSender, parseMeta, type Meta, type Sink } from "./transfer";
import { chooseSink, cleanOpfs } from "./sinks";
import "./style.css";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const startSection = $("#start");
const roomSection = $("#room");
const shareP = $("#share");
const tokenEl = $("#token");
const linkEl = $<HTMLInputElement>("#link");
const copyBtn = $("#copy");
const renewDiv = $("#renew");
const tokenInput = $<HTMLInputElement>("#token-input");
const senderDiv = $("#sender");
const fileInput = $<HTMLInputElement>("#file");
const offerDiv = $("#offer");
const transferDiv = $("#transfer");
const progressEl = $<HTMLProgressElement>("#progress");
const pctEl = $("#pct");
const statusEl = $("#status");
const errorEl = $("#error");

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

function fmtSize(n: number) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024).toFixed(1)} KiB`;
}

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
let state: "idle" | "offered" | "active" = "idle";
let pendingFile: File | undefined;
let incoming: Meta | undefined;
let sender: ReturnType<typeof createSender> | undefined;
let receiver: ReturnType<typeof createReceiver> | undefined;
let sink: Sink | undefined;
let lock: WakeLockSentinel | null = null;

// Closing the tab mid-transfer would lose the file.
addEventListener("beforeunload", (e) => { if (state === "active") e.preventDefault(); });

const sendCtl = (m: object) => peer!.channel().send(JSON.stringify(m));

function resetTransfer() {
  state = "idle";
  pendingFile = incoming = sender = receiver = sink = undefined;
  offerDiv.hidden = transferDiv.hidden = true;
  void lock?.release();
  lock = null;
  fileInput.value = "";
  fileInput.disabled = !channelOpen;
}

// Stop a transfer that did not finish: drop what was received and tell the user why.
function endTransfer(message: string) {
  sender?.cancel();
  void sink?.abort();
  resetTransfer();
  showError(message);
}

// Local failure: also tell the peer so it stops too.
function abortTransfer(message: string) {
  try { sendCtl({ t: "cancel" }); } catch { /* channel already gone */ }
  endTransfer(message);
}

const fail = (err: unknown) =>
  abortTransfer(
    err instanceof Error && err.name === "QuotaExceededError"
      ? "Not enough disk space"
      : err instanceof Error ? err.message : String(err),
  );

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
      const chunk = Math.min(CHUNK, peer!.maxMessageSize() ?? CHUNK);
      sender = createSender(file, peer!.channel(), chunk, (n) => showProgress(n, file.size));
      sender.run().catch(fail);
      break;
    }
    case "reject":
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

// A crashed tab may never close its channel cleanly, so "disconnected" and "failed" count as lost too.
function peerLost(failed = false) {
  setStatus("Peer disconnected");
  if (state !== "idle") endTransfer("The other person disconnected. The transfer stopped.");
  else if (failed && !channelOpen) showError("Couldn't connect the two devices.");
}

const events = {
  signal: (s: Signal) => ws?.send(JSON.stringify(s)),
  state(text: string) {
    if (text === "failed" || text === "disconnected") peerLost(text === "failed");
    else setStatus(text === "connected" ? "Connected" : "Connecting");
  },
  open() {
    channelOpen = true;
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

function connect(first: object) {
  showError("");
  if (ws) ws.onclose = ws.onerror = null; // drop the socket from a failed join
  ws?.close();
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => ws!.send(JSON.stringify(first));
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    try {
      switch (msg.type) {
        case "created":
          startSection.hidden = true;
          roomSection.hidden = shareP.hidden = senderDiv.hidden = false;
          renewDiv.hidden = true;
          tokenEl.textContent = msg.token;
          linkEl.value = `${location.origin}/#${msg.token}`;
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
          peer?.close();
          setStatus("Peer left. Reload to start again.");
          break;
        case "error":
          if (msg.code === "expired" && !shareP.hidden && !peer) {
            // Our own waiting room timed out: drop the dead link and offer a fresh one.
            shareP.hidden = true;
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

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file || state !== "idle" || !channelOpen) return;
  showError("");
  pendingFile = file;
  state = "offered";
  fileInput.disabled = true;
  transferDiv.hidden = false;
  showProgress(0, file.size);
  setStatus("Waiting for receiver to accept");
  sendCtl({ t: "meta", name: file.name, size: file.size, type: file.type });
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

// An invite link carries the token after "#", which the server never sees. Take it out of the address bar.
const linkToken = location.hash.slice(1);
if (linkToken) {
  history.replaceState(null, "", location.pathname + location.search);
  tokenInput.value = linkToken;
  connect({ type: "join", token: linkToken });
}
