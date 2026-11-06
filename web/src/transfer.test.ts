import test from "node:test";
import assert from "node:assert/strict";
import { CHUNK, HIGH_WATER, WINDOW, MAX_SIZE, createReceiver, createSender, fingerprint, frame, framed, newTransferId, parseFrame, parseMeta, parseResume, parseResumeAt, type Sink } from "./transfer.ts";

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
  const ok = { name: "a.txt", size: 5, type: "text/plain", id: "A".repeat(26), fp: "b".repeat(64) };
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

const ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".slice(0, 26);
const FP = "a".repeat(64);

test("meta needs a well formed id and fingerprint, and a sane batch", () => {
  const ok = { name: "a.txt", size: 5, type: "text/plain", id: ID, fp: FP };
  assert.deepEqual(parseMeta(ok), ok);
  const bad = [
    { name: "a", size: 5, type: "t" }, { ...ok, id: undefined }, { ...ok, fp: undefined },
    { ...ok, id: ID.toLowerCase() }, { ...ok, id: ID + "A" }, { ...ok, id: "../" + ID.slice(3) },
    { ...ok, id: 5 }, { ...ok, fp: "zz" }, { ...ok, fp: FP.toUpperCase() }, { ...ok, fp: 7 },
  ];
  for (const m of bad) assert.equal(parseMeta(m), null, JSON.stringify(m));
  const batch = { id: ID, i: 0, n: 3 };
  assert.deepEqual(parseMeta({ ...ok, batch })?.batch, batch);
  for (const b of [{ ...batch, i: 3 }, { ...batch, i: -1 }, { ...batch, n: 0 }, { ...batch, n: 501 }, { ...batch, id: "x" }, { ...batch, i: 1.5 }, "x", { i: 0 }]) {
    assert.equal(parseMeta({ ...ok, batch: b }), null, JSON.stringify(b));
  }
});

test("frames carry the transfer id, and a bad header is refused", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]).buffer;
  const f = parseFrame(frame(ID, data));
  assert.equal(f?.id, ID);
  assert.deepEqual(new Uint8Array(f!.data), new Uint8Array(data));
  assert.equal(parseFrame(new Uint8Array(10).buffer), null, "too short");
  assert.equal(parseFrame(frame("a".repeat(26), data)), null, "lowercase is not an id");
  assert.equal(parseFrame(frame("../".padEnd(26, "A"), data)), null, "path characters are not an id");
  assert.equal(parseFrame(frame(ID, new ArrayBuffer(0)))?.data.byteLength, 0, "an empty payload is allowed");
});

test("framed() tags binary data and control messages with the id, on whichever channel is current", () => {
  const sent: (string | ArrayBuffer)[][] = [[], []];
  let which = 0;
  const ch = framed(() => ({ bufferedAmount: which * 10, send: (d) => void sent[which].push(d) }), ID);
  ch.send(new Uint8Array([9]).buffer);
  ch.send(JSON.stringify({ t: "ack", bytes: 5 }));
  which = 1; // a reconnect swapped the channel
  ch.send(JSON.stringify({ t: "done" }));
  assert.equal(ch.bufferedAmount, 10);
  assert.equal(parseFrame(sent[0][0] as ArrayBuffer)?.id, ID);
  assert.deepEqual(JSON.parse(sent[0][1] as string), { t: "ack", bytes: 5, id: ID });
  assert.deepEqual(JSON.parse(sent[1][0] as string), { t: "done", id: ID });
});

test("transfer ids are 26 base32 characters and differ", () => {
  const ids = new Set(Array.from({ length: 500 }, newTransferId));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^[A-Z2-7]{26}$/);
});

test("fingerprint: stable for the same file, changes with size, time, head or tail", async () => {
  const mk = (bytes: Uint8Array, lastModified = 1000) => Object.assign(new Blob([bytes]), { lastModified });
  const base = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 7) & 255);
  const fp = await fingerprint(mk(base));
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(await fingerprint(mk(base)), fp);
  assert.notEqual(await fingerprint(mk(base, 2000)), fp, "timestamp");
  assert.notEqual(await fingerprint(mk(base.subarray(1))), fp, "size");
  const head = base.slice(); head[10] ^= 1;
  assert.notEqual(await fingerprint(mk(head)), fp, "first MiB");
  const tail = base.slice(); tail[tail.length - 10] ^= 1;
  assert.notEqual(await fingerprint(mk(tail)), fp, "last MiB");
  const middle = base.slice(); middle[1536 * 1024] ^= 1;
  assert.equal(await fingerprint(mk(middle)), fp, "documented limit: a middle edit with the same size and time goes unnoticed");
  assert.match(await fingerprint(mk(new Uint8Array(0))), /^[0-9a-f]{64}$/, "empty file");
});

test("resume messages are validated", () => {
  assert.deepEqual(parseResume({ id: ID, fp: FP }), { id: ID, fp: FP });
  for (const m of [null, {}, { id: ID }, { id: "x", fp: FP }, { id: ID, fp: "x" }]) assert.equal(parseResume(m), null);
  assert.equal(parseResumeAt({ bytes: 0 }, 10), 0);
  assert.equal(parseResumeAt({ bytes: 10 }, 10), 10);
  for (const b of [-1, 11, 1.5, "5", null, NaN, Infinity]) assert.equal(parseResumeAt({ bytes: b }, 10), null, String(b));
  assert.equal(parseResumeAt(null, 10), null);
});

test("resume: sender from an offset and receiver from the same offset finish identical", async () => {
  const bytes = new Uint8Array(5 * CHUNK + 777).map((_, i) => (i * 13) & 255); // not a multiple of the chunk size
  const start = 2 * CHUNK + 5; // the receiver stopped mid-chunk-boundary
  const sch = fakeChannel(), rch = fakeChannel(), sink = fakeSink();
  sink.parts.push(bytes.slice(0, start).buffer); // what was stored before the interruption
  const errors: unknown[] = [];
  const rx = createReceiver(bytes.length, sink, rch, () => {}, (e) => errors.push(e), start);
  await createSender(new Blob([bytes]), sch, CHUNK, () => {}, start).run();
  for (const m of sch.sent) if (typeof m !== "string") rx.chunk(m);
  await rx.done();
  assert.deepEqual(errors, []);
  assert.deepEqual(Buffer.concat(sink.parts.map((p) => new Uint8Array(p))), Buffer.from(bytes));
});

test("resume at the very end: only 'done' is sent and the receiver accepts it", async () => {
  const bytes = new Uint8Array(3000).map((_, i) => i & 255);
  const sch = fakeChannel(), rch = fakeChannel(), sink = fakeSink();
  sink.parts.push(bytes.buffer.slice(0));
  const rx = createReceiver(bytes.length, sink, rch, () => {}, () => {}, bytes.length);
  await createSender(new Blob([bytes]), sch, CHUNK, () => {}, bytes.length).run();
  assert.equal(sch.sent.length, 1);
  assert.equal(JSON.parse(sch.sent[0] as string).t, "done");
  await rx.done();
  assert.equal(sink.closed, true);
});

test("receiver.flush() reports only bytes that were really written", async () => {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const sink = { ...fakeSink(), write: async () => { await gate; } };
  const rx = createReceiver(100, sink, fakeChannel(), () => {}, () => {}, 10);
  rx.chunk(new ArrayBuffer(30));
  let flushed: number | undefined;
  const p = rx.flush().then((n) => (flushed = n));
  await tick();
  assert.equal(flushed, undefined, "flush must wait for the pending write");
  release();
  await p;
  assert.equal(flushed, 40);
});

test("resumed sender still pauses at WINDOW measured from its start", async () => {
  const ch = fakeChannel();
  const start = 4 * CHUNK;
  const s = createSender(new Blob([new Uint8Array(start + WINDOW + CHUNK)]), ch, CHUNK, () => {}, start);
  const run = s.run();
  await tick();
  assert.equal(ch.sent.length, WINDOW / CHUNK, "WINDOW bytes after the offset, not after zero");
  s.ack(start + WINDOW);
  await run;
});

import { sortedPartNames } from "./sinks.ts";

test("parts sort by number, not by the order a directory lists them", () => {
  const listed = ["p000010", "p000002", "p000000", "p000011", "p000001", "junk", "p00001", "p000009", "p000003"];
  assert.deepEqual(sortedPartNames(listed), ["p000000", "p000001", "p000002", "p000003", "p000009", "p000010", "p000011"]);
  const many = Array.from({ length: 120 }, (_, i) => `p${String(i).padStart(6, "0")}`).reverse();
  assert.deepEqual(sortedPartNames(many), many.slice().reverse());
});

test("invalid ACKs cannot release the send window", async () => {
  const ch = fakeChannel();
  const s = createSender(new Blob([new Uint8Array(WINDOW + CHUNK)]), ch, CHUNK, () => {});
  const run = s.run();
  await tick();
  for (const bad of [NaN, Infinity, -1, 1.5, WINDOW + 1]) assert.equal(s.ack(bad), false);
  await tick();
  assert.equal(ch.sent.length, WINDOW / CHUNK);
  assert.equal(s.ack(CHUNK), true);
  assert.equal(s.ack(0), false);
  await run;
});

test("cancel during an asynchronous source read sends no late bytes", async () => {
  let release!: (b: ArrayBuffer) => void;
  const ch = fakeChannel();
  const source = { size: 1, slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>((r) => { release = r; }) }) } as unknown as Blob;
  const s = createSender(source, ch, CHUNK, () => {});
  const run = s.run();
  s.cancel();
  release(new ArrayBuffer(1));
  await run;
  assert.deepEqual(ch.sent, []);
});

test("oversized frames and impossible transport sizes are refused", async () => {
  assert.equal(parseFrame(frame(ID, new ArrayBuffer(CHUNK + 1))), null);
  for (const n of [0, -1, Infinity, CHUNK + 1]) {
    await assert.rejects(createSender(new Blob(["x"]), fakeChannel(), n, () => {}).run(), /message size/);
  }
});

test("receiver stops queued writes and never reports success after a disk failure", async () => {
  let writes = 0;
  const ch = fakeChannel();
  const sink = { ...fakeSink(), write: async () => { writes++; throw new Error("disk failed"); } };
  const errors: unknown[] = [];
  const rx = createReceiver(2, sink, ch, () => {}, (e) => errors.push(e));
  rx.chunk(new ArrayBuffer(1));
  rx.chunk(new ArrayBuffer(1));
  await assert.rejects(rx.done(), /disk failed/);
  rx.chunk(new ArrayBuffer(1));
  assert.equal(writes, 1);
  assert.equal(errors.length, 1);
  assert.equal(ch.sent.length, 0);
});

test("saved is sent only after the completion receipt commits", async () => {
  let commit!: () => void;
  const committed = new Promise<void>((resolve) => { commit = resolve; });
  const ch = fakeChannel();
  const sink = fakeSink();
  const rx = createReceiver(0, sink, ch, () => {}, () => {}, 0, () => committed);
  const done = rx.done();
  await tick();
  assert.equal(sink.closed, true);
  assert.equal(ch.sent.length, 0);
  commit();
  await done;
  assert.equal(JSON.parse(ch.sent[0] as string).t, "saved");
});

test("receive backlog is bounded across multiple files, not just per file", async () => {
  const budget = { pending: 0 };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const errors: unknown[] = [];
  const sink = { ...fakeSink(), write: async () => { await blocked; } };
  const a = createReceiver(WINDOW * 2, sink, fakeChannel(), () => {}, (e) => errors.push(e), 0, undefined, budget);
  const b = createReceiver(WINDOW, sink, fakeChannel(), () => {}, (e) => errors.push(e), 0, undefined, budget);
  for (let i = 0; i < WINDOW * 2 / CHUNK; i++) a.chunk(new ArrayBuffer(CHUNK));
  b.chunk(new ArrayBuffer(CHUNK));
  assert.equal(errors.length, 1);
  assert.equal(budget.pending, WINDOW * 2);
  release();
  await a.flush();
  assert.equal(budget.pending, 0);
});

test("duplicate done and late frames cannot reopen or finalize a receiver twice", async () => {
  const sink = fakeSink(), ch = fakeChannel();
  let closes = 0;
  const original = sink.close;
  sink.close = async () => { closes++; await original(); };
  const rx = createReceiver(1, sink, ch, () => {}, () => {});
  rx.chunk(new ArrayBuffer(1));
  const first = rx.done();
  rx.chunk(new ArrayBuffer(1));
  await Promise.all([first, rx.done()]);
  assert.equal(closes, 1);
  assert.equal(sink.parts.length, 1);
  assert.equal(ch.sent.length, 1);
});

test("zero-length frame floods do not queue disk writes", async () => {
  const sink = fakeSink();
  const budget = { pending: 0, frames: 0 };
  const rx = createReceiver(1, sink, fakeChannel(), () => {}, () => {}, 0, undefined, budget);
  for (let i = 0; i < 10000; i++) rx.chunk(new ArrayBuffer(0));
  await rx.flush();
  assert.equal(sink.parts.length, 0);
  assert.equal(budget.frames, 0);
});
