import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  b32decode, b64u, concat, createGate, hkdf, hmac, pairProofKey, parseInvite, proofInput, sdpFingerprint, transcript,
  type Fingerprints, type GateOptions,
} from "./auth.ts";
import { b32, newTransferId } from "./transfer.ts";

const v = JSON.parse(readFileSync(new URL("../../docs/vectors.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

test("base32 round trip, and ids are 26 characters", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  assert.equal(b32(bytes).length, 26);
  assert.deepEqual(b32decode(b32(bytes)), bytes);
  assert.equal(b32(new TextEncoder().encode("foobar")), "MZXW6YTBOI"); // RFC 4648 test vector
  assert.match(newTransferId(), /^[A-Z2-7]{26}$/);
});

test("the shared vectors match this code", async () => {
  const f = { fo: unhex(v.inputs.fo), fa: unhex(v.inputs.fa) };
  const no = unb64(v.inputs.no), na = unb64(v.inputs.na);
  const key = await pairProofKey(v.inputs.p);
  assert.equal(hex(key), v.pairProofKey);

  const tPair = transcript("pair", f, no, na);
  assert.equal(hex(tPair), v.pair.transcript);
  assert.equal(b64u(await hmac(key, proofInput("offer", tPair))), v.pair.offerProof);
  assert.equal(b64u(await hmac(key, proofInput("answer", tPair))), v.pair.answerProof);
});

test("an SDP has exactly one sha-256 fingerprint or none is accepted", () => {
  const fp = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0").toUpperCase()).join(":");
  const other = fp.replace("00", "FF");
  const line = (algo: string, f: string) => `a=fingerprint:${algo} ${f}\r\n`;
  assert.deepEqual(sdpFingerprint(`v=0\r\n${line("sha-256", fp)}a=x\r\n`), Uint8Array.from({ length: 32 }, (_, i) => i));
  assert.ok(sdpFingerprint(line("sha-256", fp) + line("SHA-256", fp.toLowerCase())), "the same one twice is one");
  assert.equal(sdpFingerprint(line("sha-256", fp) + line("sha-256", other)), null);
  assert.equal(sdpFingerprint(line("sha-1", "AA:BB")), null);
  assert.equal(sdpFingerprint(line("sha-256", fp) + line("sha-1", "AA:BB")), null);
  assert.equal(sdpFingerprint(line("sha-256", "AA:BB")), null);
  assert.equal(sdpFingerprint("v=0\r\n"), null);
  assert.equal(sdpFingerprint(undefined), null);
});

test("an invite never lets the key reach what is sent to the server", () => {
  const t = "A".repeat(26), p = "B".repeat(26);
  assert.deepEqual(parseInvite(t), { token: t });
  assert.deepEqual(parseInvite(`${t}.${p}`), { token: t, p });
  assert.deepEqual(parseInvite(`  https://example.com/#${t}.${p}\n`), { token: t, p });
  assert.deepEqual(parseInvite(`${t}.short`), { token: t }, "a damaged key is still cut off");
  assert.deepEqual(parseInvite("not-a-real-code"), { token: "not-a-real-code" });
});

// Two gates joined by an ordered in-memory channel.
type End = { passed?: boolean; failed?: string; delivered: (string | ArrayBuffer)[]; sent: any[] };
type Opts = Partial<Pick<GateOptions, "key" | "required" | "mode">> & { fingerprints?: Fingerprints | null };
const F: Fingerprints = { fo: new Uint8Array(32).fill(1), fa: new Uint8Array(32).fill(2) };

function ends(offer: Opts, answer: Opts, tamper: (m: any) => any = (m) => m) {
  const make = (role: "offer" | "answer", o: Opts, end: End, to: () => ReturnType<typeof createGate>) =>
    createGate({
      role, mode: o.mode ?? "pair", key: o.key, required: o.required ?? false,
      fingerprints: () => (o.fingerprints === undefined ? F : o.fingerprints),
      send(m) {
        end.sent.push(m);
        const d = JSON.stringify(tamper(m));
        setTimeout(() => to().message(d)); // arrives later, like a real channel
      },
      deliver: (d) => end.delivered.push(d),
      passed: (ok) => { end.passed = ok; },
      failed: (r) => { end.failed = r; },
    });
  const a: End = { delivered: [], sent: [] }, b: End = { delivered: [], sent: [] };
  const ga = make("offer", offer, a, () => gb), gb = make("answer", answer, b, () => ga);
  ga.start();
  gb.start();
  return { a, b, ga, gb };
}

async function settled(...es: End[]) {
  for (let i = 0; i < 300 && es.some((e) => e.passed === undefined && !e.failed); i++) await new Promise((r) => setTimeout(r, 5));
}

const P = newTransferId();

test("both devices holding the key verify each other", async () => {
  const key = pairProofKey(P);
  const { a, b, ga, gb } = ends({ key }, { key, required: true });
  await settled(a, b);
  assert.equal(a.passed, true);
  assert.equal(b.passed, true);
  ga.close(); gb.close();
});

test("the wrong key fails on both sides", async () => {
  const { a, b, ga, gb } = ends({ key: pairProofKey(P) }, { key: pairProofKey(newTransferId()), required: true });
  await settled(a, b);
  assert.equal(a.failed, "auth");
  assert.equal(b.failed, "auth");
  assert.equal(a.passed, undefined);
  ga.close(); gb.close();
});

test("someone in the middle fails: each side sees different fingerprints", async () => {
  const key = pairProofKey(P);
  const { a, b, ga, gb } = ends({ key }, { key, required: true, fingerprints: { fo: new Uint8Array(32).fill(9), fa: F.fa } });
  await settled(a, b);
  assert.equal(a.failed, "auth");
  assert.equal(b.failed, "auth");
  ga.close(); gb.close();
});

test("a proof can't be reflected back at the device that made it", async () => {
  const key = pairProofKey(P);
  const seen: string[] = [];
  const { a, b, ga, gb } = ends({ key }, { key }, (m) => {
    if (m.t !== "auth-p") return m;
    seen.push(m.p);
    return seen.length === 2 ? { ...m, p: seen[0] } : m; // answer the first proof with itself
  });
  await settled(a, b);
  assert.ok(a.failed === "auth" || b.failed === "auth");
  ga.close(); gb.close();
});

test("a typed code has no key: the connection works but is not verified", async () => {
  const { a, b, ga, gb } = ends({ key: pairProofKey(P) }, {});
  await settled(a, b);
  assert.equal(a.passed, false);
  assert.equal(b.passed, false);
  ga.close(); gb.close();
});

test("a link's key can't be dropped by someone in the middle", async () => {
  const { a, b, ga, gb } = ends({}, { key: pairProofKey(P), required: true }); // the other side claims to have no key
  await settled(b);
  assert.equal(b.failed, "auth");
  ga.close(); gb.close();
});

test("a saved connection refuses anything but its own mode", async () => {
  const key = pairProofKey(P);
  const { a, b, ga, gb } = ends({ key, mode: "saved", required: true }, { key, mode: "pair", required: true });
  await settled(a, b);
  assert.equal(a.failed, "auth");
  assert.equal(b.failed, "auth");
  ga.close(); gb.close();
});

test("a side with no usable fingerprints fails", async () => {
  const key = pairProofKey(P);
  const { a, b, ga, gb } = ends({ key, fingerprints: null }, { key });
  await settled(a);
  assert.equal(a.failed, "auth");
  ga.close(); gb.close();
});

// One gate driven by hand, standing in for whatever the other side does.
function solo(o: Opts = {}) {
  const e: End = { delivered: [], sent: [] };
  const g = createGate({
    role: "answer", mode: "pair", key: o.key, required: o.required ?? false, fingerprints: () => F,
    send: (m) => e.sent.push(m), deliver: (d) => e.delivered.push(d),
    passed: (ok) => { e.passed = ok; }, failed: (r) => { e.failed = r; },
  });
  g.start();
  return { e, g };
}
const hello = JSON.stringify({ t: "hello", v: 2, min: 1, caps: ["pair"] });
const flush = () => new Promise((r) => setTimeout(r, 20));

test("a version 1 peer is recognised by its first message, which still arrives", async () => {
  const { e, g } = solo();
  const session = JSON.stringify({ t: "session", id: newTransferId() });
  g.message(session);
  await flush();
  assert.equal(e.passed, false);
  assert.deepEqual(e.delivered, [session]);
  g.close();
});

test("a version 1 peer is refused when a proof is required", async () => {
  const { e, g } = solo({ key: pairProofKey(P), required: true });
  g.message(JSON.stringify({ t: "meta" }));
  await flush();
  assert.equal(e.failed, "auth");
  assert.deepEqual(e.delivered, []);
  g.close();
});

test("nothing reaches the engine before the proof, and it arrives in order afterwards", async () => {
  const key = pairProofKey(P);
  const { e, g } = solo({ key, required: true });
  g.message(hello);
  await flush();
  const n = e.sent.find((m) => m.t === "auth-n");
  assert.ok(n);

  const theirs = crypto.getRandomValues(new Uint8Array(32));
  g.message(JSON.stringify({ t: "auth-n", mode: "pair", n: b64u(theirs) }));
  g.message(JSON.stringify({ t: "meta", n: 1 }));
  g.message(new ArrayBuffer(8));
  await flush();
  assert.deepEqual(e.delivered, [], "held back");

  const t = transcript("pair", F, theirs, unb64(n.n)); // this gate is the answerer
  g.message(JSON.stringify({ t: "auth-p", p: b64u(await hmac(await key, proofInput("offer", t))) }));
  await flush();
  assert.equal(e.passed, true);
  assert.equal(e.delivered.length, 2);
  assert.equal(e.delivered[0], JSON.stringify({ t: "meta", n: 1 }));
  g.close();
});

test("too much held back ends the attempt", async () => {
  const { e, g } = solo({ key: pairProofKey(P), required: true });
  g.message(hello);
  for (let i = 0; i < 300; i++) g.message(JSON.stringify({ t: "x" }));
  await flush();
  assert.equal(e.failed, "auth");
  g.close();
});

test("a peer too old or too new asks for an update, and a broken hello is refused", async () => {
  for (const [msg, want] of [
    [{ t: "hello", v: 0, min: 0, caps: [] }, "upgrade"],
    [{ t: "hello", v: 9, min: 9, caps: [] }, "upgrade"],
    [{ t: "hello", v: "2", min: 1, caps: [] }, "auth"],
    [{ t: "hello", v: 2, min: 1 }, "auth"],
  ] as const) {
    const { e, g } = solo();
    g.message(JSON.stringify(msg));
    await flush();
    assert.equal(e.failed, want);
    assert.equal(e.sent.at(-1).t, "bye");
    assert.equal(e.sent.at(-1).reason, want);
    g.close();
  }
});

test("malformed nonces and proofs are refused", async () => {
  for (const bad of [
    { t: "auth-n", mode: "pair", n: "short" },
    { t: "auth-n", mode: "pair", n: 7 },
    { t: "auth-n", mode: "pair", n: "!".repeat(43) },
    { t: "auth-p", p: "x" },
  ]) {
    const { e, g } = solo({ key: pairProofKey(P), required: true });
    g.message(hello);
    g.message(JSON.stringify(bad));
    await flush();
    assert.equal(e.failed, "auth", JSON.stringify(bad));
    g.close();
  }
});

test("control messages start with t, which old pages depend on", () => {
  const { e, g } = solo();
  assert.ok(JSON.stringify(e.sent[0]).startsWith('{"t":"hello"'));
  g.close();
});

test("hkdf matches RFC 5869 test case 3 (no salt, no info)", async () => {
  const okm = await hkdf(new Uint8Array(22).fill(0x0b), "");
  assert.equal(hex(okm), "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d");
  assert.equal(concat(new Uint8Array(1), new Uint8Array(2)).length, 3);
});


test("gate bounds callbacks before asynchronous proof processing", async () => {
  const { e, g } = solo({ required: true, key: pairProofKey(P) });
  for (let i = 0; i < 257; i++) g.message(new ArrayBuffer(1));
  assert.equal(e.failed, "auth");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(e.delivered.length, 0);
  g.close();
});

test("gate rejects oversized control and binary messages before parsing or delivery", () => {
  for (const data of ["a".repeat(32769), "名".repeat(11000), new ArrayBuffer(65536 + 27)]) {
    const { e, g } = solo({ required: true, key: pairProofKey(P) });
    g.message(data);
    assert.equal(e.failed, "auth");
    assert.deepEqual(e.delivered, []);
    g.close();
  }
});
