import { createPeer, type Signal } from "./peer";
import { newTransferId } from "./transfer";

// One device-to-device connection: the signaling socket, the WebRTC peer, and getting back together after
// a drop. No page code. Once connected, the two devices share a secret `session` (sent over the encrypted
// DataChannel) that only they know; rejoining uses it, so nobody else can slip into a reconnecting pair.
export type Phase = "idle" | "waiting" | "connecting" | "open" | "reconnecting";

export type ConnectionEvents = {
  phase(p: Phase): void;
  invite(token: string): void; // our room is ready: this is what to share
  inviteExpired(): void; // nobody joined in time
  open(reconnected: boolean): void; // the DataChannel is open
  message(data: string | ArrayBuffer): void;
  low(): void; // the send buffer drained
  lost(): void; // an open connection dropped; the app decides: rejoin() or leave()
  bye(): void; // the other device disconnected on purpose: don't wait for it
  session(id: string): void; // the shared secret is known, so the pair can be saved and rejoined later
  error(text: string): void;
};

const errorText: Record<string, string> = {
  "bad-message": "The server rejected a message.",
  "invalid-token": "That link isn't valid. Ask the sender for a new one.",
  expired: "This link has expired. Ask the sender for a new one.",
  "room-full": "This link has already been used.",
  "already-in-room": "Already in a room.",
  "not-paired": "No other device is connected yet.",
  "server-busy": "The server is busy. Try again later.",
};

const SESSION_RE = /^[A-Z2-7]{26}$/;

export function createConnection(ev: ConnectionEvents) {
  let ws: WebSocket | undefined;
  let peer: ReturnType<typeof createPeer> | undefined;
  let phase: Phase = "idle";
  let session: string | undefined;
  let opened = false; // the DataChannel is open right now
  let everOpened = false;
  let rejoining = false;
  let expired = false; // our waiting room timed out and the server closed the socket on purpose
  let retry: ReturnType<typeof setTimeout> | undefined;

  const setPhase = (p: Phase) => {
    phase = p;
    ev.phase(p);
  };

  function drop() {
    clearTimeout(retry);
    if (ws) ws.onmessage = ws.onclose = ws.onerror = null;
    ws?.close();
    ws = undefined;
    peer?.close(); // marks it dead, so its late events are ignored
    peer = undefined;
    opened = false;
  }

  function scheduleRejoin(delay: number) {
    clearTimeout(retry);
    retry = setTimeout(() => {
      if (rejoining && session) openSocket({ type: "rejoin", token: session });
    }, delay);
  }

  // The connection failed before it opened, or an open one died.
  function peerLost(failed: boolean) {
    if (opened) {
      opened = false;
      peer?.close();
      peer = undefined;
      ev.lost();
    } else if (rejoining) {
      // the new connection failed before it opened: start over after a moment
      peer?.close();
      peer = undefined;
      scheduleRejoin(2000);
    } else if (failed) {
      leave();
      ev.error("Couldn't connect the two devices.");
    }
  }

  const peerEvents = {
    signal: (s: Signal) => ws?.send(JSON.stringify(s)),
    state(text: string) {
      if (text === "failed" || text === "disconnected") peerLost(text === "failed");
    },
    open() {
      opened = true;
      clearTimeout(retry);
      const reconnected = everOpened;
      everOpened = true;
      rejoining = false;
      // The first connection settles a shared secret, over the encrypted channel, for getting back together.
      if (!session && !reconnected && peer && isCreator) {
        session = newTransferId();
        send({ t: "session", id: session });
        ev.session(session);
      }
      setPhase("open");
      ev.open(reconnected);
    },
    closed: () => peerLost(false),
    message(data: string | ArrayBuffer) {
      if (typeof data === "string" && data.startsWith('{"t":"')) {
        try {
          const m = JSON.parse(data);
          if (m.t === "session") {
            if (!session && typeof m.id === "string" && SESSION_RE.test(m.id)) {
              session = m.id as string;
              ev.session(m.id);
            }
            return;
          }
          if (m.t === "bye") return ev.bye();
        } catch { /* not ours: pass it on */ }
      }
      ev.message(data);
    },
    low: () => ev.low(),
  };

  let isCreator = false; // the device that made the room starts the WebRTC offer

  function openSocket(first: { type: string; token?: string }) {
    drop();
    expired = false;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const socket = (ws = new WebSocket(url));
    socket.onopen = () => socket.send(JSON.stringify(first));
    socket.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      try {
        switch (msg.type) {
          case "created":
            isCreator = true;
            if (first.type === "rejoin") setPhase("reconnecting"); // first back: wait quietly, the other side knows the secret
            else {
              setPhase("waiting");
              ev.invite(msg.token);
            }
            break;
          case "joined":
            isCreator = false;
            peer = createPeer(false, msg.iceServers ?? [], peerEvents);
            setPhase(rejoining ? "reconnecting" : "connecting");
            break;
          case "peer-joined":
            peer = createPeer(true, msg.iceServers ?? [], peerEvents);
            setPhase(rejoining ? "reconnecting" : "connecting");
            await peer.start();
            break;
          case "offer":
          case "answer":
          case "candidate":
            await peer?.handle(msg);
            break;
          case "peer-left":
            if (opened) break; // the direct connection reports its own failure
            if (rejoining) {
              // the other side dropped again before the connection opened: wait for it in a fresh room
              peer?.close();
              peer = undefined;
              scheduleRejoin(1000);
            } else if (!everOpened) {
              leave();
              ev.error("The other device left before the connection was ready.");
            }
            // Otherwise we were connected and this is the same drop, reported a moment later by the
            // server. lost() is already handling it (it may still be saving what arrived), so keep the
            // session: throwing it away here would leave nothing to reconnect to.
            break;
          case "error":
            if (rejoining) {
              // room full, expired, busy, restarting: all pass with a retry
              if (msg.code === "invalid-token") ev.error(errorText[msg.code]);
              else scheduleRejoin(2000);
            } else if (msg.code === "expired" && phase === "waiting") {
              expired = true;
              ev.inviteExpired();
            } else {
              ev.error(errorText[msg.code] ?? `Server error: ${msg.code}`);
            }
            break;
        }
      } catch (err) {
        ev.error(String(err));
      }
    };
    socket.onerror = socket.onclose = () => {
      if (opened || expired) return; // an open channel doesn't need signaling
      if (everOpened && !rejoining) return; // we were connected: lost() decides what happens next
      if (rejoining) scheduleRejoin(2000);
      else if (!peer) ev.error("Cannot reach the server.");
    };
  }

  function send(msg: object) {
    peer!.channel().send(JSON.stringify(msg));
  }

  function leave() {
    drop();
    rejoining = false;
    session = undefined;
    everOpened = false;
    setPhase("idle");
  }

  return {
    create() {
      rejoining = false;
      session = undefined;
      everOpened = false;
      openSocket({ type: "create" });
    },
    join(token: string) {
      rejoining = false;
      session = undefined;
      everOpened = false;
      openSocket({ type: "join", token });
    },
    // Get back together after a drop (or a page reload, with the saved secret).
    rejoin(secret?: string) {
      if (secret) {
        session = secret;
        everOpened = true;
      }
      if (!session) return;
      rejoining = true;
      setPhase("reconnecting");
      scheduleRejoin(0);
    },
    leave,
    send,
    channel: () => peer!.channel(),
    // The channel's own state, not just our last event: a closing channel throws on send a moment
    // before its "close" event arrives, and that must read as a lost connection, not a failed file.
    isOpen: () => opened && peer?.channel()?.readyState === "open",
    maxMessage: () => peer?.maxMessageSize(),
    get session() { return session; },
    get phase() { return phase; },
  };
}

export type Connection = ReturnType<typeof createConnection>;
