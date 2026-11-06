import { sdpFingerprint, type Fingerprints } from "./auth";
import { LOW_WATER } from "./transfer";

export type Signal =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "candidate"; candidate: RTCIceCandidateInit };

type Events = {
  signal(s: Signal): void;
  state(text: string): void;
  open(): void;
  closed(): void;
  message(data: string | ArrayBuffer): void;
  low(): void;
};

export function createPeer(initiator: boolean, relayServers: RTCIceServer[], handlers: Events) {
  // After close(), late events from this connection (a drop can report disconnected, failed and closed) are ignored.
  let dead = false;
  const on: Events = {
    signal: (s) => { if (!dead) handlers.signal(s); },
    state: (t) => { if (!dead) handlers.state(t); },
    open: () => { if (!dead) handlers.open(); },
    closed: () => { if (!dead) handlers.closed(); },
    message: (d) => { if (!dead) handlers.message(d); },
    low: () => { if (!dead) handlers.low(); },
  };
  // STUN lets each browser learn its public address so peers on different networks can connect.
  // It only sees the address, never the file. relayServers (TURN) come from the server once two
  // peers are paired; they carry the file only when no direct path works.
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }, ...relayServers],
    // ?relay=1 forces the relay path, to test it without redeploying.
    iceTransportPolicy: new URLSearchParams(location.search).has("relay") ? "relay" : "all",
  });
  const pending: RTCIceCandidateInit[] = [];
  let channel: RTCDataChannel | undefined;

  function useChannel(dc: RTCDataChannel) {
    channel = dc;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onbufferedamountlow = on.low;
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
    useChannel(pc.createDataChannel("file", { ordered: true }));
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
    channel: () => channel!,
    maxMessageSize: () => pc.sctp?.maxMessageSize,
    // Offerer's first. What this connection really checks, so it is what the proof must cover.
    fingerprints(): Fingerprints | null {
      const local = sdpFingerprint(pc.localDescription?.sdp), remote = sdpFingerprint(pc.remoteDescription?.sdp);
      if (!local || !remote) return null;
      return initiator ? { fo: local, fa: remote } : { fo: remote, fa: local };
    },
    close() {
      dead = true;
      pc.close();
    },
  };
}
