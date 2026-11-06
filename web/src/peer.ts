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

export function createPeer(initiator: boolean, on: Events) {
  // STUN lets each browser learn its public address so peers on different networks can connect.
  // It only sees the address, never the file. shortcut: no TURN relay, so strict NATs can still fail;
  // add coturn if real users report "Couldn't connect the two devices".
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
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
    close: () => pc.close(),
  };
}
