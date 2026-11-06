import { createGate, pairProofKey, type Gate, type Mode } from "./auth";
import { createPeer, type Signal } from "./peer";
import { newTransferId } from "./transfer";

// One device-to-device connection: the signaling socket, the WebRTC peer, and getting back together after
// a drop. No page code. Once connected, the two devices share a secret `session` (sent over the encrypted
// DataChannel) that only they know; rejoining uses it, so nobody else can slip into a reconnecting pair.
// The server does see that secret when rejoining, so a connection is only verified by the gate in auth.ts.
export type Phase = "idle" | "waiting" | "connecting" | "open" | "reconnecting";

export type ConnectionEvents = {
  phase(p: Phase): void;
  invite(token: string, p: string): void; // our room is ready: this is what to share
  inviteExpired(): void; // nobody joined in time
  open(reconnected: boolean): void; // the DataChannel is open and the gate has passed
  message(data: string | ArrayBuffer): void;
  low(): void; // the send buffer drained
  lost(): void; // an open connection dropped; the app decides: rejoin() or leave()
  bye(): void; // the other device disconnected on purpose: don't wait for it
  session(id: string): void; // the shared secret is known, so the pair can be saved and rejoined later
  error(text: string): void;
  refused(text: string): void; // the other device couldn't be verified, or is too old: the connection is over
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

const refusedText = {
  auth: "Couldn't verify the other device, so the connection was closed.",
  upgrade: "Update StreamDrop on the other device.",
};

const SESSION_RE = /^[A-Z2-7]{26}$/;

const defaultSignalUrl = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export function createConnection(ev: ConnectionEvents, signalUrl = defaultSignalUrl()) {
  let ws: WebSocket | undefined;
  let peer: ReturnType<typeof createPeer> | undefined;
  let phase: Phase = "idle";
  let session: string | undefined;
  let opened = false; // the DataChannel is open right now
  let everOpened = false;
  let rejoining = false;
  let expired = false; // our waiting room timed out and the server closed the socket on purpose
  let retry: ReturnType<typeof setTimeout> | undefined;
  let gate: Gate | undefined; // set from the moment the DataChannel opens
  let mode: Mode = "pair";
  let inviteKey: string | undefined; // P: the key in the invite link, which the server never sees
  let proofKey: Promise<Uint8Array> | undefined;
  let required = false; // the other device must prove itself, or the connection is refused
  let verified = false;

  function useInviteKey(p?: string) {
    mode = "pair";
    inviteKey = p;
    proofKey = p ? pairProofKey(p) : undefined;
    required = false;
    verified = false;
  }

  function closePeer() {
    gate?.close();
    gate = undefined;
    peer?.close(); // marks it dead, so its late events are ignored
    peer = undefined;
  }

  const setPhase = (p: Phase) => {
    phase = p;
    ev.phase(p);
  };

  function drop() {
    clearTimeout(retry);
    if (ws) ws.onmessage = ws.onclose = ws.onerror = null;
    ws?.close();
    ws = undefined;
    closePeer();
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
      closePeer();
      ev.lost();
    } else if (rejoining) {
      // the new connection failed before it opened: start over after a moment
      closePeer();
      scheduleRejoin(2000);
    } else if (failed) {
      leave();
      ev.error("Couldn't connect the two devices.");
    }
  }

  // The channel is open and the other device is who it should be, as far as this connection can tell.
  function ready(isVerified: boolean) {
    opened = true;
    verified = isVerified;
    if (isVerified) required = true; // from now on, every reconnect must prove itself too
    else proofKey = inviteKey = undefined;
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
  }

  function refuse(reason: "auth" | "upgrade") {
    leave();
    ev.refused(refusedText[reason]);
  }

  function onData(data: string | ArrayBuffer) {
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
        if (m.t === "bye") {
          if (m.reason === "auth" || m.reason === "upgrade") return refuse(m.reason);
          return ev.bye();
        }
      } catch { /* not ours: pass it on */ }
    }
    ev.message(data);
  }

  const peerEvents = {
    signal: (s: Signal) => ws?.send(JSON.stringify(s)),
    state(text: string) {
      if (text === "failed" || text === "disconnected") peerLost(text === "failed" || (!!gate && !opened));
    },
    open() {
      const p = peer!;
      gate = createGate({
        role: isCreator ? "offer" : "answer",
        mode,
        key: proofKey,
        required,
        fingerprints: () => p.fingerprints(),
        send: (m) => p.channel().send(JSON.stringify(m)),
        deliver: onData,
        passed: ready,
        failed: refuse,
      });
      gate.start();
    },
    closed: () => peerLost(!!gate && !opened), // closed while proving itself: a failed attempt, not a drop
    message: (data: string | ArrayBuffer) => gate?.message(data),
    low: () => ev.low(),
  };

  let isCreator = false; // the device that made the room starts the WebRTC offer

  function openSocket(first: { type: string; token?: string }) {
    drop();
    expired = false;
    const socket = (ws = new WebSocket(signalUrl));
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
              ev.invite(msg.token, inviteKey!);
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
              closePeer();
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
    useInviteKey();
    setPhase("idle");
  }

  return {
    create() {
      rejoining = false;
      session = undefined;
      everOpened = false;
      useInviteKey(newTransferId());
      openSocket({ type: "create" });
    },
    // p came with the link, so the device that made it holds it too: a connection without its proof is an attack.
    join(token: string, p?: string) {
      rejoining = false;
      session = undefined;
      everOpened = false;
      useInviteKey(p);
      required = !!p;
      openSocket({ type: "join", token });
    },
    // Get back together after a drop (or a page reload, with the saved secret and invite key).
    rejoin(secret?: string, p?: string) {
      if (secret) {
        session = secret;
        everOpened = true;
        useInviteKey(p);
        required = !!p;
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
    get inviteKey() { return required ? inviteKey : undefined; }, // a reload needs it to keep proving itself
    get verified() { return verified; },
    get phase() { return phase; },
  };
}

export type Connection = ReturnType<typeof createConnection>;
