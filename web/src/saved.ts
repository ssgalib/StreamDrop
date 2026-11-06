import { b64u, concat, hkdf, hmac, hmacOk, b32decode, type Fingerprints, type Role } from "./auth.ts";
import { b32 } from "./transfer.ts";

// Saved connections (docs/protocol.md): one secret K per pair of devices, from which both derive a rendezvous
// id the server may see and a proof key it never does.
export async function savedKeys(k: Uint8Array) {
  return {
    roomId: b32((await hkdf(k, "sd-room")).slice(0, 16)),
    ka: await hkdf(k, "sd-auth"),
  };
}

export const deriveK = (p: string, ro: Uint8Array, ra: Uint8Array, f: Fingerprints) =>
  hkdf(concat(b32decode(p), ro, ra), "sd-pair-key", concat(f.fo, f.fa));

const enc = (s: string) => new TextEncoder().encode(s);
export const confirmInput = (role: Role) => enc(`confirm${role}`);

const NAME_MAX = 64;
// The other device names itself, so this is untrusted text: it is only ever shown, and never used as a path here.
export function parseName(m: any): string | null {
  if (typeof m?.name !== "string") return null;
  const name = m.name.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").trim().slice(0, NAME_MAX);
  return name || null;
}

function unb64(s: unknown) {
  if (typeof s !== "string" || !/^[\w-]{43}$/.test(s)) return null;
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

export type PairingOptions = {
  role: Role;
  p: string;
  fingerprints(): Fingerprints | null;
  send(msg: object): void;
  saved(k: Uint8Array): void | Promise<void>; // resolves after the pair is stored locally
  failed(): void;
};

// Runs inside an already verified connection. Both devices must tap Save; K only exists once both have.
export function createPairing(o: PairingOptions) {
  let mine: Uint8Array | undefined, theirs: Uint8Array | undefined, k: Uint8Array | undefined, ka: Uint8Array | undefined;
  let theirConfirm: Uint8Array | undefined;
  let finished = false;
  let work = Promise.resolve(); // crypto is async, and messages must still be handled in order

  const other: Role = o.role === "offer" ? "answer" : "offer";
  const fail = () => {
    if (finished) return;
    finished = true;
    o.failed();
  };

  async function settle() {
    if (!mine || !theirs || k) return;
    const f = o.fingerprints();
    if (!f) return fail();
    k = await deriveK(o.p, o.role === "offer" ? mine : theirs, o.role === "offer" ? theirs : mine, f);
    ka = (await savedKeys(k)).ka;
    o.send({ t: "pair-ok", c: b64u(await hmac(ka, confirmInput(o.role))) });
    await check();
  }

  async function check() {
    if (!ka || !theirConfirm || finished) return;
    if (!(await hmacOk(ka, theirConfirm, confirmInput(other)))) return fail();
    finished = true;
    try { await o.saved(k!); } catch { o.failed(); }
  }

  return {
    get started() { return !!mine; },
    get asked() { return !!theirs; }, // the other device already tapped Save
    save() {
      if (mine) return;
      mine = crypto.getRandomValues(new Uint8Array(32));
      o.send({ t: "pair-key", r: b64u(mine) });
      work = work.then(settle).catch(fail);
    },
    // True when the message was one of ours.
    message(m: any) {
      if (m?.t === "pair-key") {
        const r = unb64(m.r);
        if (!r || theirs) fail();
        else theirs = r;
        work = work.then(settle).catch(fail);
        return true;
      }
      if (m?.t === "pair-ok") {
        const c = unb64(m.c);
        if (!c || theirConfirm) fail();
        else theirConfirm = c;
        work = work.then(check).catch(fail);
        return true;
      }
      return false;
    },
  };
}

// One idle socket that waits on every saved device. A ring means someone is waiting in that device's room.
export function createListener(url: string, ids: () => string[], ring: (id: string) => void, makeSocket = (u: string) => new WebSocket(u)) {
  let ws: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  let stopped = false;

  const announce = () => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "listen", ids: ids() }));
  };
  function open() {
    clearTimeout(retry);
    if (stopped || !ids().length) return;
    const s = (ws = makeSocket(url));
    s.onopen = () => {
      delay = 1000;
      announce();
    };
    s.onmessage = (e) => {
      let m: any;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m?.type === "ring" && typeof m.token === "string") ring(m.token);
    };
    s.onclose = () => {
      if (ws !== s) return;
      ws = undefined;
      retry = setTimeout(open, delay + Math.random() * 1000); // spread out, so a server restart isn't a stampede
      delay = Math.min(delay * 2, 60_000);
    };
  }
  return {
    // The list of saved devices changed.
    update() {
      if (ws) announce();
      else open();
    },
    stop() {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    },
  };
}
