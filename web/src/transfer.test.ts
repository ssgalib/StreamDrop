import test from "node:test";
import assert from "node:assert/strict";
import { CHUNK, HIGH_WATER, WINDOW, MAX_SIZE, createReceiver, createSender, parseMeta, type Sink } from "./transfer.ts";

const tick = () => new Promise((r) => setImmediate(r));

function fakeChannel() {
  const sent: (string | ArrayBuffer)[] = [];
  return { bufferedAmount: 0, sent, send: (d: string | ArrayBuffer) => void sent.push(d) };
}

function fakeSink() {
  const parts: ArrayBuffer[] = [];
  const sink: Sink & { parts: ArrayBuffer[]; closed: boolean } = {
    parts, closed: false,
    write: async (d) => void parts.push(d),
    close: async () => void (sink.closed = true),
    abort: async () => {},
  };
  return sink;
}

async function roundTrip(bytes: Uint8Array) {
  const sch = fakeChannel(), rch = fakeChannel(), sink = fakeSink();
  const errors: unknown[] = [];
  const rx = createReceiver(bytes.length, sink, rch, () => {}, (e) => errors.push(e));
  await createSender(new Blob([bytes]), sch, CHUNK, () => {}).run();
  for (const m of sch.sent) {
    if (typeof m !== "string") rx.chunk(m);
    else assert.equal(JSON.parse(m).t, "done");
  }
  await rx.done();
  assert.deepEqual(errors, []);
  assert.equal(JSON.parse(rch.sent.at(-1) as string).t, "saved");
  return Buffer.concat(sink.parts.map((p) => new Uint8Array(p)));
}

test("file that isn't a multiple of the chunk size arrives identical", async () => {
  const bytes = new Uint8Array(3 * CHUNK + 123).map((_, i) => (i * 31) & 255);
  assert.deepEqual(await roundTrip(bytes), Buffer.from(bytes));
});

test("zero-byte file finishes", async () => {
  assert.equal((await roundTrip(new Uint8Array(0))).length, 0);
});

test("sender pauses at WINDOW and continues after ack", async () => {
  const ch = fakeChannel();
  const s = createSender(new Blob([new Uint8Array(WINDOW + 2 * CHUNK)]), ch, CHUNK, () => {});
  let finished = false;
  const run = s.run().then(() => (finished = true));
  await tick();
  assert.equal(ch.sent.length, WINDOW / CHUNK);
  assert.equal(finished, false);
  s.ack(WINDOW);
  await run;
  assert.equal(JSON.parse(ch.sent.at(-1) as string).t, "done");
});

test("sender pauses at HIGH_WATER and continues after wake", async () => {
  const ch = fakeChannel();
  ch.bufferedAmount = HIGH_WATER + 1;
  const s = createSender(new Blob([new Uint8Array(3 * CHUNK)]), ch, CHUNK, () => {});
  const run = s.run();
  await tick();
  assert.equal(ch.sent.length, 0);
  ch.bufferedAmount = 0;
  s.wake();
  await run;
  assert.equal(ch.sent.length, 4); // 3 chunks + done
});

test("cancel stops the send loop and done isn't sent", async () => {
  const ch = fakeChannel();
  ch.bufferedAmount = HIGH_WATER + 1;
  const s = createSender(new Blob([new Uint8Array(3 * CHUNK)]), ch, CHUNK, () => {});
  const run = s.run();
  await tick();
  s.cancel();
  await run;
  assert.equal(ch.sent.length, 0);
});

test("more bytes than size calls fail", () => {
  const errors: unknown[] = [];
  createReceiver(10, fakeSink(), fakeChannel(), () => {}, (e) => errors.push(e)).chunk(new ArrayBuffer(11));
  assert.equal(errors.length, 1);
});

test("done() with missing bytes throws", async () => {
  const rx = createReceiver(10, fakeSink(), fakeChannel(), () => {}, () => {});
  rx.chunk(new ArrayBuffer(4));
  await assert.rejects(rx.done(), /incomplete/);
});

test("failing sink.write calls fail", async () => {
  const errors: unknown[] = [];
  const sink = { ...fakeSink(), write: async () => { throw new Error("disk full"); } };
  const rx = createReceiver(10, sink, fakeChannel(), () => {}, (e) => errors.push(e));
  rx.chunk(new ArrayBuffer(4));
  await rx.done().catch(() => {});
  assert.equal(errors.length, 1);
});

test("invalid meta fields are rejected", () => {
  const ok = { name: "a.txt", size: 5, type: "text/plain" };
  assert.deepEqual(parseMeta(ok), ok);
  const bad = [
    null, "x",
    { ...ok, name: "" }, { ...ok, name: 5 }, { ...ok, name: "a".repeat(256) },
    { ...ok, size: -1 }, { ...ok, size: 1.5 }, { ...ok, size: "5" }, { ...ok, size: MAX_SIZE + 1 },
    { ...ok, size: Number.MAX_SAFE_INTEGER + 1 }, { ...ok, type: 5 },
  ];
  for (const m of bad) assert.equal(parseMeta(m), null, JSON.stringify(m));
  assert.equal(parseMeta({ ...ok, type: "evil<script>" })!.type, "application/octet-stream");
});
