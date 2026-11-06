import { createPeer, type Signal } from "./peer";
import { CHUNK, createReceiver, createSender, parseMeta, type Meta, type Sink } from "./transfer";
import { memorySink } from "./sinks";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const startSection = $("#start");
const roomSection = $("#room");
const shareP = $("#share");
const tokenEl = $("#token");
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
  "invalid-token": "That token doesn't exist.",
  expired: "That token has expired.",
  "room-full": "That room is full.",
  "already-in-room": "Already in a room.",
  "not-paired": "No peer is connected yet.",
  "server-busy": "The server is busy. Try again later.",
};

function fmtSize(n: number) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024).toFixed(1)} KiB`;
}

function showProgress(done: number, total: number) {
  progressEl.max = total || 1;
  progressEl.value = done;
  pctEl.textContent = `${total ? Math.floor((done / total) * 100) : 100}%`;
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

const sendCtl = (m: object) => peer!.channel().send(JSON.stringify(m));

function resetTransfer() {
  state = "idle";
  pendingFile = incoming = sender = receiver = sink = undefined;
  offerDiv.hidden = transferDiv.hidden = true;
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

const fail = (err: unknown) => abortTransfer(err instanceof Error ? err.message : String(err));

function startTransfer() {
  state = "active";
  offerDiv.hidden = true;
  transferDiv.hidden = false;
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
      showError("Receiver declined the file.");
      setStatus("Connected");
      break;
    case "ack":
      if (typeof msg.bytes === "number") sender?.ack(msg.bytes);
      break;
    case "done":
      if (!receiver) return fail(new Error("Unexpected end of file"));
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
function peerLost() {
  setStatus("Peer disconnected");
  if (state !== "idle") endTransfer("Peer disconnected during the transfer.");
}

const events = {
  signal: (s: Signal) => ws?.send(JSON.stringify(s)),
  state(text: string) {
    if (text === "failed") showError("Peer connection failed.");
    if (text === "failed" || text === "disconnected") peerLost();
    else setStatus(text === "connected" ? "Connected" : text);
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
      fail(new Error("Unexpected data from peer"));
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
          tokenEl.textContent = msg.token;
          setStatus("Waiting for peer");
          break;
        case "joined":
          startSection.hidden = true;
          roomSection.hidden = false;
          peer = createPeer(false, events);
          setStatus("Connecting");
          break;
        case "peer-joined":
          peer = createPeer(true, events);
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
    else if (!peer) showError("Cannot reach the server.");
  };
}

$("#create").addEventListener("click", () => connect({ type: "create" }));
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

$("#accept").addEventListener("click", () => {
  const m = incoming;
  if (state !== "offered" || !m) return;
  showError("");
  sink = memorySink(m.name, m.type);
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
