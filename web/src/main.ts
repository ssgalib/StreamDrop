import { createPeer, type Signal } from "./peer";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const startSection = $("#start");
const roomSection = $("#room");
const shareP = $("#share");
const tokenEl = $("#token");
const tokenInput = $<HTMLInputElement>("#token-input");
const messageInput = $<HTMLInputElement>("#message");
const sendBtn = $<HTMLButtonElement>("#send");
const logEl = $("#log");
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

function addLog(line: string) {
  const li = document.createElement("li");
  li.textContent = line; // never innerHTML: peer text is untrusted
  logEl.append(li);
}

function setChatEnabled(on: boolean) {
  messageInput.disabled = sendBtn.disabled = !on;
}

let ws: WebSocket | undefined;
let peer: ReturnType<typeof createPeer> | undefined;
let channelOpen = false;

const events = {
  signal: (s: Signal) => ws?.send(JSON.stringify(s)),
  state(text: string) {
    setStatus(text);
    if (text === "failed") showError("Peer connection failed.");
  },
  open() {
    channelOpen = true;
    setChatEnabled(true);
    setStatus("Connected");
  },
  closed() {
    channelOpen = false;
    setChatEnabled(false);
  },
  message: (text: string) => addLog(`Peer: ${text}`),
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
          roomSection.hidden = shareP.hidden = false;
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
          peer?.close();
          setChatEnabled(false);
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
$("#chat").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = messageInput.value;
  peer?.send(text);
  addLog(`You: ${text}`);
  messageInput.value = "";
});
