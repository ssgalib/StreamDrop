import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { b64u, hmac, proofInput, transcript, type Fingerprints } from "./auth.ts";
import { confirmInput, createListener, createPairing, deriveK, parseName, savedKeys } from "./saved.ts";
import { newTransferId, parseMeta } from "./transfer.ts";

const v = JSON.parse(readFileSync(new URL("../../docs/vectors.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const F: Fingerprints = { fo: unhex(v.inputs.fo), fa: unhex(v.inputs.fa) };

test("the shared vectors for saved connections match this code", async () => {
  const k = await deriveK(v.inputs.p, unb64(v.inputs.ro), unb64(v.inputs.ra), F);
  assert.equal(hex(k), v.k);
  const { roomId, ka } = await savedKeys(k);
  assert.equal(roomId, v.roomId);
  assert.equal(hex(ka), v.ka);
  assert.equal(b64u(await hmac(ka, confirmInput("offer"))), v.confirm.offer);
  assert.equal(b64u(await hmac(ka, confirmInput("answer"))), v.confirm.answer);
  const t = transcript("saved", F, unb64(v.inputs.no), unb64(v.inputs.na));
  assert.equal(hex(t), v.saved.transcript);
  assert.equal(b64u(await hmac(ka, proofInput("offer", t))), v.saved.offerProof);
  assert.equal(b64u(await hmac(ka, proofInput("answer", t))), v.saved.answerProof);
});

test("the room id says nothing about the key: it is 26 base32 characters and differs from every secret", async () => {
  const k = crypto.getRandomValues(new Uint8Array(32));
  const { roomId, ka } = await savedKeys(k);
  assert.match(roomId, /^[A-Z2-7]{26}$/);
  assert.notEqual(hex(ka), hex(k));
});

const P = newTransferId();

function pair(tamper: (m: any) => any = (m) => m, fb: Fingerprints = F) {
  const got: { a?: Uint8Array; b?: Uint8Array; failed: string[] } = { failed: [] };
  const a = createPairing({
    role: "offer", p: P, fingerprints: () => F, send: (m) => queueMicrotask(() => b.message(tamper(m))),
    saved: (k) => { got.a = k; }, failed: () => got.failed.push("a"),
  });
  const b = createPairing({
    role: "answer", p: P, fingerprints: () => fb, send: (m) => queueMicrotask(() => a.message(tamper(m))),
    saved: (k) => { got.b = k; }, failed: () => got.failed.push("b"),
  });
  return { a, b, got };
}
const flush = () => new Promise((r) => setTimeout(r, 30));

test("both devices tapping Save end with the same key", async () => {
  const { a, b, got } = pair();
  a.save();
  await flush();
  assert.equal(got.a, undefined, "nothing is saved until both have tapped");
  assert.ok(b.asked);
  b.save();
  await flush();
  assert.ok(got.a && got.b);
  assert.equal(hex(got.a), hex(got.b));
  assert.deepEqual(got.failed, []);
});

test("tapping Save at the same moment works too", async () => {
  const { a, b, got } = pair();
  a.save();
  b.save();
  await flush();
  assert.equal(hex(got.a!), hex(got.b!));
});

test("devices that derive different keys save nothing", async () => {
  const { a, b, got } = pair((m) => m, { fo: new Uint8Array(32).fill(7), fa: F.fa });
  a.save();
  b.save();
  await flush();
  assert.equal(got.a, undefined);
  assert.equal(got.b, undefined);
  assert.ok(got.failed.length);
});

test("a confirmation can't be reflected", async () => {
  const sent: any[] = [];
  const got: { k?: Uint8Array; failed?: boolean } = {};
  const a = createPairing({
    role: "offer", p: P, fingerprints: () => F, send: (m) => sent.push(m), saved: (k) => { got.k = k; }, failed: () => { got.failed = true; },
  });
  a.save();
  a.message({ t: "pair-key", r: b64u(new Uint8Array(32).fill(1)) });
  await flush();
  a.message({ t: "pair-ok", c: sent.find((m) => m.t === "pair-ok").c }); // its own, sent back
  await flush();
  assert.equal(got.k, undefined);
  assert.equal(got.failed, true);
});

test("malformed or repeated pairing messages fail, and other messages pass through", async () => {
  for (const bad of [{ t: "pair-key", r: "short" }, { t: "pair-key", r: 5 }, { t: "pair-ok", c: "!" }]) {
    let failed = false;
    const a = createPairing({ role: "offer", p: P, fingerprints: () => F, send() {}, saved() {}, failed: () => { failed = true; } });
    assert.equal(a.message(bad), true);
    await flush();
    assert.ok(failed, JSON.stringify(bad));
  }
  const a = createPairing({ role: "offer", p: P, fingerprints: () => F, send() {}, saved() {}, failed() {} });
  assert.equal(a.message({ t: "meta" }), false);
});

test("a device's name is cleaned and capped", () => {
  assert.equal(parseName({ name: "  Laptop‮\u0000  " }), "Laptop");
  assert.equal(parseName({ name: "x".repeat(100) })?.length, 64);
  assert.equal(parseName({ name: "\u0000" }), null);
  assert.equal(parseName({ name: 5 }), null);
  assert.equal(parseName(null), null);
});

test("a folder path survives validation only as a short string", () => {
  const m = { id: newTransferId(), name: "a", size: 1, type: "", fp: "a".repeat(64) };
  assert.equal(parseMeta({ ...m, rel: "a/b" })?.rel, "a/b");
  assert.equal(parseMeta({ ...m, rel: 5 })?.rel, undefined);
  assert.equal(parseMeta({ ...m, rel: "x".repeat(1025) })?.rel, undefined);
  assert.equal(parseMeta(m)?.rel, undefined);
});

class FakeSocket {
  readyState = WebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: () => void;
  send(s: string) { this.sent.push(s); }
  close() { this.closed = true; }
}

test("the listener announces its ids, passes on rings and ignores the rest", () => {
  const sockets: FakeSocket[] = [];
  const rings: string[] = [];
  let ids: string[] = [];
  const l = createListener("ws://x", () => ids, (id) => rings.push(id), () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s as unknown as WebSocket;
  });
  l.update();
  assert.equal(sockets.length, 0, "no saved devices, no socket");

  ids = ["A"];
  l.update();
  sockets[0].onopen!();
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), { type: "listen", ids: ["A"] });

  ids = ["A", "B"];
  l.update();
  assert.equal(sockets.length, 1, "the same socket");
  assert.deepEqual(JSON.parse(sockets[0].sent[1]).ids, ["A", "B"]);

  sockets[0].onmessage!({ data: '{"type":"ring","token":"A"}' });
  sockets[0].onmessage!({ data: '{"type":"error","code":"x"}' });
  sockets[0].onmessage!({ data: "not json" });
  assert.deepEqual(rings, ["A"]);
  l.stop();
  assert.ok(sockets[0].closed);
});

test("the listener comes back after its socket closes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets: FakeSocket[] = [];
  const l = createListener("ws://x", () => ["A"], () => {}, () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s as unknown as WebSocket;
  });
  l.update();
  sockets[0].onclose!();
  t.mock.timers.tick(2100);
  assert.equal(sockets.length, 2);
  l.stop();
  sockets[1].onclose!();
  t.mock.timers.tick(120_000);
  assert.equal(sockets.length, 2, "stopped means stopped");
});
