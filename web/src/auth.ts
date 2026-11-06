import { isId, CHUNK, ID_LEN, MAX_CONTROL, controlBytes } from "./transfer.ts";

// Proves who is on the other end of a DataChannel (docs/protocol.md, sections 2.4-2.7). The signaling server
// carries the SDP, so it could sit in the middle of a connection. Each side proves it knows a key the server
// never saw, over the DTLS fingerprints it actually sees, so a connection with someone in the middle can't pass.
export type Role = "offer" | "answer";
export type Mode = "pair" | "saved";
export type Fingerprints = { fo: Uint8Array; fa: Uint8Array };

export const VERSION = 2; // the protocol this code speaks
export const MIN_VERSION = 1; // the oldest it accepts
const HELLO_MS = 3000;
const AUTH_MS = 15_000;
const MAX_HELD = 256;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;

const enc = (s: string) => new TextEncoder().encode(s);

export function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function b32decode(s: string) {
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const c of s) {
    value = ((value << 5) | B32.indexOf(c)) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

export const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function unb64u(s: unknown, length: number): Uint8Array | null {
  if (typeof s !== "string" || !/^[\w-]+$/.test(s)) return null;
  try {
    const out = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    return out.length === length ? out : null;
  } catch {
    return null;
  }
}

export async function hkdf(ikm: Uint8Array, info: string, salt = new Uint8Array()) {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: enc(info) }, key, 256));
}

const hmacKey = (key: Uint8Array, use: KeyUsage) =>
  crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [use]);

export async function hmac(key: Uint8Array, data: Uint8Array) {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(key, "sign"), data as BufferSource));
}

// Constant time, unlike comparing the bytes ourselves.
export async function hmacOk(key: Uint8Array, mac: Uint8Array, data: Uint8Array) {
  return crypto.subtle.verify("HMAC", await hmacKey(key, "verify"), mac as BufferSource, data as BufferSource);
}

export const pairProofKey = (p: string) => hkdf(b32decode(p), "sd-pair-proof");

export function transcript(mode: Mode, f: Fingerprints, no: Uint8Array, na: Uint8Array) {
  return concat(enc(`streamdrop-v2\0${mode}\0`), f.fo, f.fa, no, na);
}

export const proofInput = (role: Role, t: Uint8Array) => concat(enc(role), t);

// The one sha-256 fingerprint of an SDP. Anything else (none, two different ones, another hash) is refused,
// because the proof must cover exactly the certificate the connection checks.
export function sdpFingerprint(sdp: string | undefined): Uint8Array | null {
  const found = new Set<string>();
  for (const [, algo, value] of (sdp ?? "").matchAll(/^a=fingerprint:(\S+) (\S+)\s*$/gim)) {
    if (algo.toLowerCase() !== "sha-256" || !/^([0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(value)) return null;
    found.add(value.toUpperCase());
  }
  if (found.size !== 1) return null;
  return Uint8Array.from([...found][0].split(":"), (h) => parseInt(h, 16));
}

// An invite is TOKEN.P in the part of a link after "#", or a bare TOKEN typed by hand. P must never reach the
// server, so everything that came with the token is split off here, whatever was pasted.
export function parseInvite(text: string): { token: string; p?: string } {
  const [token, p] = text.trim().slice(text.trim().lastIndexOf("#") + 1).split(".");
  return isId(p) ? { token, p } : { token };
}

export type GateOptions = {
  role: Role;
  mode: Mode;
  key?: Promise<Uint8Array>; // absent: this device has nothing to prove with, the connection can only be temporary
  required: boolean; // the other device must prove itself: no falling back to temporary
  caps?: string[]; // what else this device offers
  fingerprints(): Fingerprints | null;
  send(msg: object): void;
  deliver(data: string | ArrayBuffer): void; // for the layers above; held back until the gate opens
  passed(verified: boolean, peerCaps: string[]): void;
  failed(reason: "auth" | "upgrade"): void;
};

// Runs when a DataChannel opens. Nothing but hello, auth-* and bye gets through until it passes.
export function createGate(o: GateOptions) {
  let state: "hello" | "auth" | "open" | "closed" = "hello";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work = Promise.resolve(); // crypto is async, and messages must still be handled in order
  let t: Uint8Array | undefined;
  let peerCaps: string[] = [];
  const held: (string | ArrayBuffer)[] = [];
  let queuedBytes = 0;
  let heldBytes = 0;
  let queuedMessages = 0;
  const mine = crypto.getRandomValues(new Uint8Array(32));
  const other: Role = o.role === "offer" ? "answer" : "offer";

  const stop = () => {
    clearTimeout(timer);
    held.length = 0;
    heldBytes = 0;
  };
  function fail(reason: "auth" | "upgrade") {
    if (state === "closed") return;
    state = "closed";
    stop();
    try { o.send({ t: "bye", reason, ...(reason === "upgrade" && { min: MIN_VERSION }) }); } catch { /* it's closing anyway */ }
    o.failed(reason);
  }
  function pass(verified: boolean) {
    const waiting = held.splice(0);
    state = "open";
    stop();
    o.passed(verified, peerCaps);
    for (const d of waiting) o.deliver(d);
  }
  // A version 1 peer never says hello.
  function noHello() {
    if (o.required) fail("auth");
    else pass(false);
  }
  function arm(ms: number, then: () => void) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      work = work.then(() => { if (state === "hello" || state === "auth") then(); });
    }, ms);
  }

  async function step(data: string | ArrayBuffer) {
    if (state === "closed") return;
    if (state === "open") return o.deliver(data);
    let m: any;
    if (typeof data === "string") {
      try { m = JSON.parse(data); } catch { /* not a control message */ }
    }
    switch (m?.t) {
      case "hello": return state === "hello" ? onHello(m) : fail("auth");
      case "auth-n": return onNonce(m);
      case "auth-p": return onProof(m);
      case "bye": return o.deliver(data); // an unproven goodbye can only end the attempt
    }
    if (state === "hello") {
      noHello(); // ordered channel: anything before a hello means none is coming
      return step(data);
    }
    if (held.length >= MAX_HELD) return fail("auth");
    const bytes = typeof data === "string" ? controlBytes(data) : data.byteLength;
    if (heldBytes + bytes > MAX_QUEUED_BYTES) return fail("auth");
    heldBytes += bytes;
    held.push(data);
  }

  async function onHello(m: any) {
    if (!Number.isSafeInteger(m.v) || !Number.isSafeInteger(m.min) || !Array.isArray(m.caps)) return fail("auth");
    if (m.v < MIN_VERSION || m.min > VERSION) return fail("upgrade");
    peerCaps = m.caps.filter((c: unknown) => typeof c === "string");
    if (o.key && m.caps.includes(o.mode)) {
      state = "auth";
      arm(AUTH_MS, () => fail("auth"));
      return o.send({ t: "auth-n", mode: o.mode, n: b64u(mine) });
    }
    if (o.required) return fail("auth");
    pass(false);
  }

  async function onNonce(m: any) {
    const theirs = unb64u(m.n, 32);
    const f = o.fingerprints();
    if (state !== "auth" || t || m.mode !== o.mode || !theirs || !f) return fail("auth");
    t = transcript(o.mode, f, o.role === "offer" ? mine : theirs, o.role === "offer" ? theirs : mine);
    o.send({ t: "auth-p", p: b64u(await hmac(await o.key!, proofInput(o.role, t))) });
  }

  async function onProof(m: any) {
    const p = unb64u(m.p, 32);
    if (state !== "auth" || !t || !p || !(await hmacOk(await o.key!, p, proofInput(other, t)))) return fail("auth");
    pass(true);
  }

  return {
    start() {
      o.send({ t: "hello", v: VERSION, min: MIN_VERSION, caps: [...(o.key ? [o.mode] : []), ...(o.caps ?? [])] });
      arm(o.required ? AUTH_MS : HELLO_MS, noHello);
    },
    message(data: string | ArrayBuffer) {
      if (state === "closed") return;
      if (typeof data === "string" && data.length > MAX_CONTROL) return fail("auth");
      const bytes = typeof data === "string" ? controlBytes(data) : data.byteLength;
      const max = typeof data === "string" ? MAX_CONTROL : CHUNK + ID_LEN;
      // Bound before chaining: otherwise an async crypto operation can accumulate unlimited callbacks.
      if (bytes > max || queuedBytes + heldBytes + bytes > MAX_QUEUED_BYTES || queuedMessages >= MAX_HELD) return fail("auth");
      queuedBytes += bytes;
      queuedMessages++;
      work = work.then(async () => {
        queuedBytes -= bytes;
        queuedMessages--;
        await step(data);
      }).catch(() => fail("auth"));
    },
    close() {
      state = "closed";
      stop();
    },
  };
}

export type Gate = ReturnType<typeof createGate>;
