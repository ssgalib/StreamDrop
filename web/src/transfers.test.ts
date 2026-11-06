import test from "node:test";
import assert from "node:assert/strict";
import { createTransfers, type Saved, type Transfers } from "./transfers.ts";
import { frame, newTransferId, type Meta, type Sink } from "./transfer.ts";

class FakeSink implements Sink {
  resumable = true;
  parts: Uint8Array[] = [];
  closed = false;
  aborted = false;
  failWrites: boolean;
  constructor(failWrites = false) {
    this.failWrites = failWrites;
  }
  async write(d: ArrayBuffer) {
    if (this.failWrites) throw new Error("disk is full");
    this.parts.push(new Uint8Array(d.slice(0)));
  }
  async close() { this.closed = true; }
  async abort() { this.aborted = true; }
  bytes() { return Buffer.concat(this.parts); }
}

type Side = {
  engine: Transfers;
  sinks: Map<string, FakeSink>;
  warnings: string[];
  saved: Saved[];
  chooseFails: Map<string, string>; // file name -> error name chooseSink should throw once
  failWrites: Set<string>; // file names whose sink fails on write
  frames: number; // data frames it received
  inbox: Promise<void>;
};

// Two engines joined by an in-memory channel that keeps order, can be cut, and drops what is in flight when cut.
function connect(slowMs = 0, durableQueue = false) {
  // slowMs delays each data frame, so a test can act while a file is still on its way
  // gen counts connections: a frame only arrives on the connection it was sent on, as with a real channel
  const link = {
    up: true,
    gen: 0,
    cut() { this.up = false; this.gen++; },
    restore() { this.up = true; },
  };
  const make = (): Side => ({
    engine: undefined as unknown as Transfers, sinks: new Map(), warnings: [], saved: [],
    chooseFails: new Map(), failWrites: new Set(), frames: 0, inbox: Promise.resolve(),
  });
  const a = make(), b = make();
  const wire = (me: Side, peer: Side) => {
    const ch = {
      bufferedAmount: 0,
      send(d: string | ArrayBuffer) {
        if (!link.up) throw new Error("channel closed");
        const gen = link.gen;
        peer.inbox = peer.inbox.then(async () => {
          if (slowMs && typeof d !== "string") await new Promise((r) => setTimeout(r, slowMs));
          if (!link.up || link.gen !== gen) return; // lost in flight
          if (typeof d !== "string") peer.frames++;
          await peer.engine.onMessage(d);
        });
      },
    };
    me.engine = createTransfers({
      durableQueue,
      send: (m) => ch.send(JSON.stringify(m)),
      channel: () => ch,
      channelOpen: () => link.up,
      maxMessage: () => 262144,
      chooseSink: async (meta: Meta) => {
        const err = me.chooseFails.get(meta.name);
        if (err) throw Object.assign(new Error(err), { name: err }); // keeps failing until the test "clicks"
        const s = new FakeSink(me.failWrites.has(meta.name));
        me.sinks.set(meta.id, s);
        return s;
      },
      save: (r) => { me.saved = r; },
      changed: () => {},
      warn: (t) => me.warnings.push(t),
    });
  };
  wire(a, b);
  wire(b, a);
  return { a, b, link };
}

const until = async (cond: () => boolean, what: string, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const file = (name: string, size: number, seed = 1) =>
  new File([new Uint8Array(size).map((_, i) => (i * seed + 7) & 255)], name, { lastModified: 1000 });
const expected = (size: number, seed = 1) => Buffer.from(new Uint8Array(size).map((_, i) => (i * seed + 7) & 255));
const byName = (s: Side, name: string) => s.engine.items().find((i) => i.name === name)!;
const sinkOf = (s: Side, name: string) => s.sinks.get(byName(s, name).id)!;

test("files offered together: the other side sees them all, accepts all at once, and they arrive identical", async () => {
  const { a, b } = connect();
  const sizes: [string, number][] = [["empty.bin", 0], ["small.bin", 100_000], ["odd.bin", 300_001]];
  await a.engine.offer(sizes.map(([n, s]) => file(n, s)));
  await until(() => b.engine.items().length === 3, "three offers");
  assert.ok(b.engine.items().every((i) => i.state === "offered" && i.dir === "receive"));
  await b.engine.acceptAll();
  await until(() => a.engine.items().every((i) => i.state === "done"), "all sent");
  await until(() => b.engine.items().every((i) => i.state === "done"), "all received");
  for (const [n, s] of sizes) {
    assert.ok(sinkOf(b, n).bytes().equals(expected(s)), `${n} differs`);
    assert.ok(sinkOf(b, n).closed);
  }
  assert.deepEqual(a.saved, []); // nothing left to resume
  assert.deepEqual(b.saved, []);
});

test("both devices send at the same time and nothing gets mixed up", async () => {
  const { a, b } = connect();
  await Promise.all([a.engine.offer([file("from-a.bin", 700_000, 3)]), b.engine.offer([file("from-b.bin", 500_000, 5)])]);
  await until(() => a.engine.items().some((i) => i.dir === "receive") && b.engine.items().some((i) => i.dir === "receive"), "both offers");
  await Promise.all([a.engine.acceptAll(), b.engine.acceptAll()]);
  await until(() => [...a.engine.items(), ...b.engine.items()].every((i) => i.state === "done"), "both directions done");
  assert.ok(sinkOf(b, "from-a.bin").bytes().equals(expected(700_000, 3)));
  assert.ok(sinkOf(a, "from-b.bin").bytes().equals(expected(500_000, 5)));
});

test("declining one file leaves the others alone", async () => {
  const { a, b } = connect();
  await a.engine.offer([file("one.bin", 1000), file("two.bin", 2000), file("three.bin", 3000)]);
  await until(() => b.engine.items().length === 3, "offers");
  b.engine.decline(byName(b, "two.bin").id);
  await b.engine.accept(byName(b, "one.bin").id);
  await b.engine.accept(byName(b, "three.bin").id);
  await until(() => a.engine.items().every((i) => i.state === "done" || i.state === "declined"), "settled");
  assert.equal(byName(a, "two.bin").state, "declined");
  assert.equal(byName(a, "one.bin").state, "done");
  assert.equal(byName(a, "three.bin").state, "done");
});

test("one outgoing file streams at a time; the rest wait their turn", async () => {
  const { a, b } = connect();
  await a.engine.offer([file("first.bin", 2_000_000), file("second.bin", 2_000_000), file("third.bin", 2_000_000)]);
  await until(() => b.engine.items().length === 3, "offers");
  await b.engine.acceptAll();
  let maxActive = 0;
  while (!a.engine.items().every((i) => i.state === "done")) {
    maxActive = Math.max(maxActive, a.engine.items().filter((i) => i.state === "active").length);
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.equal(maxActive, 1);
  for (const n of ["first.bin", "second.bin", "third.bin"]) assert.ok(sinkOf(b, n).bytes().equals(expected(2_000_000)));
});

test("sender cancels mid-way: both sides stop, the partial file is dropped, late chunks are ignored", async () => {
  const { a, b } = connect(2);
  await a.engine.offer([file("big.bin", 20_000_000)]);
  await until(() => b.engine.items().length === 1, "offer");
  await b.engine.acceptAll();
  await until(() => byName(b, "big.bin").bytes > 1_000_000, "some data");
  a.engine.cancel(byName(a, "big.bin").id);
  await until(() => byName(b, "big.bin").state === "cancelled", "receiver told");
  assert.equal(byName(a, "big.bin").state, "cancelled");
  assert.ok(sinkOf(b, "big.bin").aborted);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(b.warnings.length, 0);
});

test("receiver cancels mid-way: the sender stops and says so", async () => {
  const { a, b } = connect(2);
  await a.engine.offer([file("big.bin", 20_000_000)]);
  await until(() => b.engine.items().length === 1, "offer");
  await b.engine.acceptAll();
  await until(() => byName(b, "big.bin").bytes > 1_000_000, "some data");
  b.engine.cancel(byName(b, "big.bin").id);
  await until(() => byName(a, "big.bin").state === "cancelled", "sender told");
  assert.ok(sinkOf(b, "big.bin").aborted);
});

test("accept all covers the rest of the batch: files already listed, and ones that arrive later", async () => {
  const { a, b } = connect();
  await a.engine.offer([file("a1.bin", 1000), file("a2.bin", 1000)]);
  await until(() => b.engine.items().length === 2, "offers");
  await b.engine.accept(byName(b, "a1.bin").id, true); // "accept all" ticked on one of them
  await until(() => a.engine.items().every((i) => i.state === "done"), "whole batch done without a second click");

  // a late arrival with the same batch id is taken without asking
  const batch = byName(b, "a1.bin").batch!;
  const late = { t: "meta", id: newTransferId(), name: "late.bin", size: 10, type: "a/b", fp: "c".repeat(64), batch: { ...batch, i: 1, n: 3 } };
  await b.engine.onMessage(JSON.stringify(late));
  await until(() => byName(b, "late.bin").state === "waiting", "late file accepted by itself");
  // while another batch still waits for a decision
  const other = { ...late, id: newTransferId(), name: "other.bin", batch: { id: newTransferId(), i: 0, n: 1 } };
  await b.engine.onMessage(JSON.stringify(other));
  assert.equal(byName(b, "other.bin").state, "offered");
});

test("a save location that needs a click is retried when the person clicks", async () => {
  const { a, b } = connect();
  b.chooseFails.set("second.bin", "SecurityError");
  await a.engine.offer([file("first.bin", 1000), file("second.bin", 1000)]);
  await until(() => b.engine.items().length === 2, "offers");
  await b.engine.acceptAll();
  const second = byName(b, "second.bin");
  assert.equal(second.state, "offered");
  assert.equal(second.needsClick, true);
  b.chooseFails.delete("second.bin"); // the person clicks: the browser now allows the picker
  await b.engine.accept(second.id);
  await until(() => a.engine.items().every((i) => i.state === "done"), "both done");
});

test("a failing disk fails only that file", async () => {
  const { a, b } = connect();
  b.failWrites.add("bad.bin");
  await a.engine.offer([file("bad.bin", 100_000), file("good.bin", 100_000)]);
  await until(() => b.engine.items().length === 2, "offers");
  await b.engine.acceptAll();
  await until(() => byName(a, "good.bin").state === "done", "good one finishes");
  await until(() => byName(a, "bad.bin").state === "cancelled" || byName(a, "bad.bin").state === "failed", "bad one stops");
  assert.equal(byName(b, "bad.bin").state, "failed");
  assert.match(byName(b, "bad.bin").note, /disk is full/);
  assert.ok(sinkOf(b, "bad.bin").aborted);
});

test("connection drops mid-file: both sides pause, reconnect, and carry on from the exact byte", async () => {
  const { a, b, link } = connect(2);
  const SIZE = 12_000_000 + 345;
  await a.engine.offer([file("big.bin", SIZE, 11), file("queued.bin", 400_000, 13)]);
  await until(() => b.engine.items().length === 2, "offers");
  await b.engine.acceptAll();
  await until(() => byName(b, "big.bin").bytes > SIZE * 0.4, "40% received");

  link.cut(); // the network goes away; chunks in flight are lost
  await Promise.all([a.engine.onLost(), b.engine.onLost()]);
  assert.equal(byName(a, "big.bin").state, "paused");
  assert.equal(byName(b, "big.bin").state, "paused");
  const offset = byName(b, "big.bin").bytes;
  assert.ok(offset > 0 && offset < SIZE);
  assert.equal(sinkOf(b, "big.bin").bytes().length, offset, "the receiver's offset is exactly what it stored");

  link.restore(); // a new connection
  b.frames = 0;
  a.engine.onOpen(true);
  b.engine.onOpen(true);
  await until(() => [...a.engine.items(), ...b.engine.items()].every((i) => i.state === "done"), "everything finished");
  assert.ok(sinkOf(b, "big.bin").bytes().equals(expected(SIZE, 11)), "big.bin is identical");
  assert.ok(sinkOf(b, "queued.bin").bytes().equals(expected(400_000, 13)), "the queued file is identical too");
  const resentBig = (SIZE - offset) / 65536;
  const resentQueued = Math.ceil(400_000 / 65536);
  assert.ok(b.frames <= Math.ceil(resentBig) + resentQueued + 2, `only the missing part was resent (${b.frames} frames)`);
});

test("offers that were never accepted are announced again after a reconnect, without duplicates", async () => {
  const { a, b, link } = connect();
  await a.engine.offer([file("waiting.bin", 5000)]);
  await until(() => b.engine.items().length === 1, "offer");
  link.cut();
  await Promise.all([a.engine.onLost(), b.engine.onLost()]);
  link.restore();
  a.engine.onOpen(true);
  b.engine.onOpen(true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(b.engine.items().length, 1);
  await b.engine.acceptAll();
  await until(() => byName(a, "waiting.bin").state === "done", "done");
});

test("resume is refused for a file the receiver no longer has, or for a different file", async () => {
  const { a, b, link } = connect(2);
  await a.engine.offer([file("big.bin", 8_000_000)]);
  await until(() => b.engine.items().length === 1, "offer");
  await b.engine.acceptAll();
  await until(() => byName(b, "big.bin").bytes > 1_000_000, "some data");
  link.cut();
  await Promise.all([a.engine.onLost(), b.engine.onLost()]);
  link.restore();
  // a resume claiming a different fingerprint is turned away
  const id = byName(a, "big.bin").id;
  await b.engine.onMessage(JSON.stringify({ t: "resume", id, fp: "f".repeat(64) }));
  assert.equal(byName(b, "big.bin").state, "paused", "a wrong fingerprint must not restart it");
  // the receiver discards its copy; the sender then learns it must start over
  b.engine.cancel(id);
  a.engine.onOpen(true);
  await until(() => byName(a, "big.bin").state === "failed" || byName(a, "big.bin").state === "cancelled", "sender told");
});

test("saved records list only what a reload could resume, and clear when the file is done", async () => {
  const { a, b } = connect(2);
  await a.engine.offer([file("keep.bin", 6_000_000)]);
  await until(() => b.engine.items().length === 1, "offer");
  assert.deepEqual(b.saved, [], "an unanswered offer is not saved");
  await b.engine.acceptAll();
  await until(() => byName(b, "keep.bin").state === "active", "receiving");
  assert.equal(b.saved.length, 1);
  assert.equal(b.saved[0].dir, "receive");
  assert.equal(a.saved.length, 1);
  assert.equal(a.saved[0].dir, "send");
  await until(() => byName(b, "keep.bin").state === "done", "done");
  assert.deepEqual(b.saved, []);
  assert.deepEqual(a.saved, []);
});

test("nonsense from the other side is ignored or refused, never trusted", async () => {
  const { a, b } = connect();
  const id = newTransferId();
  const ok = { t: "meta", id, name: "x.bin", size: 5, type: "a/b", fp: "a".repeat(64) };
  for (const bad of [
    { ...ok, name: "n".repeat(300) }, { ...ok, size: -1 }, { ...ok, fp: "nope" }, { ...ok, id: "short" }, "not json{",
  ]) await b.engine.onMessage(typeof bad === "string" ? bad : JSON.stringify(bad));
  assert.equal(b.engine.items().length, 0);
  assert.ok(b.warnings.length >= 4);

  await b.engine.onMessage(JSON.stringify(ok));
  await b.engine.onMessage(JSON.stringify(ok)); // a repeat
  assert.equal(b.engine.items().length, 1);
  // data, "done" and "accept" for an offer that was never accepted do nothing
  await b.engine.onMessage(frame(id, new ArrayBuffer(5)));
  await b.engine.onMessage(JSON.stringify({ t: "done", id }));
  await b.engine.onMessage(JSON.stringify({ t: "accept", id }));
  await b.engine.onMessage(JSON.stringify({ t: "ack", id, bytes: 1 }));
  assert.equal(b.engine.items()[0].state, "offered");
  // and for ids it has never heard of
  const stranger = newTransferId();
  for (const m of [{ t: "accept", id: stranger }, { t: "done", id: stranger }, { t: "cancel", id: stranger }, { t: "saved", id: stranger }, { t: "resume-at", id: stranger, bytes: 0 }, { t: "who", id: stranger }, {}, null]) {
    await b.engine.onMessage(JSON.stringify(m));
  }
  await b.engine.onMessage(frame(stranger, new ArrayBuffer(10)));
  await b.engine.onMessage(new ArrayBuffer(3));
  assert.equal(b.engine.items().length, 1);
  assert.equal(a.engine.items().length, 0);
});

test("too many unanswered offers are refused", async () => {
  const { a, b } = connect();
  for (let i = 0; i < 500; i++) {
    await b.engine.onMessage(JSON.stringify({ t: "meta", id: newTransferId(), name: `f${i}`, size: 1, type: "a/b", fp: "a".repeat(64) }));
  }
  assert.equal(b.engine.items().length, 500);
  await b.engine.onMessage(JSON.stringify({ t: "meta", id: newTransferId(), name: "one-too-many", size: 1, type: "a/b", fp: "a".repeat(64) }));
  assert.equal(b.engine.items().length, 500);
  assert.equal(a.engine.items().length, 0);
});

test("a batch of 500 reaches the other device, at most 100 unanswered at a time", async () => {
  const { a, b } = connect();
  await a.engine.offer(Array.from({ length: 500 }, (_, i) => file(`f${i}.bin`, 1)));
  await until(() => b.engine.items().length === 100, "first hundred");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(b.engine.items().length, 100, "old pages refuse more than this");
  await b.engine.acceptAll();
  await until(() => b.engine.items().length === 500 && b.engine.items().every((i) => i.state === "done"), "all 500");
  assert.ok(a.engine.items().every((i) => i.state === "done"));
});

test("a file that arrived but whose saved message was lost still ends as sent", async () => {
  const { a, b } = connect();
  await a.engine.offer([file("lost-saved.bin", 1000)]);
  await until(() => b.engine.items().length === 1, "offered");
  await b.engine.accept(b.engine.items()[0].id);
  await until(() => byName(b, "lost-saved.bin").state === "done", "received");
  // the sender never heard: put it back where a drop would have left it
  const it = a.engine.items()[0];
  it.state = "paused";
  a.engine.onOpen(true);
  await until(() => byName(a, "lost-saved.bin").state === "done", "reported as sent");
  assert.equal(byName(a, "lost-saved.bin").note, "");
});

test("oversized or oddly named files are refused locally and never announced", async () => {
  const { a, b } = connect();
  await a.engine.offer([file("x".repeat(300), 10), file("fine.bin", 10)]);
  await until(() => byName(a, "fine.bin").state === "offered", "fine one announced");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(b.engine.items().length, 1);
  assert.equal(a.engine.items().find((i) => i.name.length === 300)!.state, "failed");
});

test("Decline all covers the later offers of a 500-file batch", async () => {
  const { a, b } = connect();
  await a.engine.offer(Array.from({ length: 500 }, (_, i) => file(`decline${i}`, 1)));
  await until(() => b.engine.items().length === 100, "first offers");
  b.engine.declineAll();
  await until(() => a.engine.items().every((i) => i.state === "declined"), "whole batch declined");
  assert.equal(b.engine.items().length, 500);
  assert.ok(b.engine.items().every((i) => i.state === "declined"));
});

test("app journal keeps unanswered offers with batch and folder metadata", async () => {
  const { a, b } = connect(0, true);
  const f = Object.assign(file("queued.bin", 5), { rel: "album/sub" });
  await a.engine.offer([f]);
  await until(() => b.engine.items().length === 1, "offer");
  for (const side of [a, b]) {
    assert.equal(side.saved.length, 1);
    assert.equal(side.saved[0].state, "offered");
    assert.equal(side.saved[0].rel, "album/sub");
    assert.equal(side.saved[0].batch?.n, 1);
  }
});

test("clearing history and restarting the receiver retain completion receipts", async () => {
  const { a, b } = connect(0, true);
  await a.engine.offer([file("receipt.bin", 20)]);
  await until(() => b.engine.items().length === 1, "offer");
  await b.engine.acceptAll();
  await until(() => a.engine.items()[0].state === "done", "sent");
  b.engine.clearFinished();
  assert.equal(b.engine.items().length, 0);
  const receipt = b.saved.find((it) => it.state === "done")!;
  assert.ok(receipt);
  let reply: unknown;
  const fresh = createTransfers({
    durableQueue: true, send: (m) => { reply = m; },
    channel: () => ({ bufferedAmount: 0, send: () => {} }), channelOpen: () => true,
    maxMessage: () => 65562, chooseSink: async () => { throw new Error("must not create another file"); },
    save: () => {}, changed: () => {}, warn: () => {},
  });
  fresh.restore(receipt, {});
  await fresh.onMessage(JSON.stringify({ t: "resume", id: receipt.id, fp: receipt.fp }));
  assert.deepEqual(reply, { t: "saved", id: receipt.id });
  assert.equal(fresh.items().length, 0);
});

function recoveryEngine(sink?: Sink) {
  const sent: any[] = [], snapshots: Saved[][] = [], warnings: string[] = [];
  let commit: (() => Promise<void>) | undefined;
  const engine = createTransfers({
    durableQueue: true, send: (m) => sent.push(m),
    channel: () => ({ bufferedAmount: 0, send: (m) => sent.push(typeof m === 'string' ? JSON.parse(m) : m) }),
    channelOpen: () => true, maxMessage: () => 65562,
    chooseSink: async () => { if (sink) return sink; throw new Error('unexpected new sink'); },
    save: (items) => { snapshots.push(structuredClone(items)); return commit?.(); },
    changed: () => {}, warn: (text) => warnings.push(text),
  });
  const saved: Saved = { id: newTransferId(), dir: 'receive', name: 'kept.bin', size: 5, type: 'application/octet-stream', fp: 'a'.repeat(64), state: 'paused', root: '/chosen/folder' };
  return { engine, saved, sent, snapshots, warnings, setCommit: (fn?: () => Promise<void>) => { commit = fn; } };
}

test('cancellation commits before notification or cleanup and survives restart and clearing history', async () => {
  const x = recoveryEngine(), sink = new FakeSink();
  x.engine.restore(x.saved, { sink, offset: 2 });
  let release!: () => void;
  x.setCommit(() => new Promise<void>((resolve) => { release = resolve; }));
  const cancelled = x.engine.cancel(x.saved.id);
  assert.equal(x.snapshots.at(-1)![0].state, 'cancelled');
  assert.equal(x.snapshots.at(-1)![0].root, '/chosen/folder');
  assert.equal(sink.aborted, false);
  assert.deepEqual(x.sent, []);
  release();
  x.setCommit();
  assert.equal(await cancelled, true);
  assert.equal(sink.aborted, true);
  assert.deepEqual(x.sent, [{ t: 'cancel', id: x.saved.id }]);
  const fresh = recoveryEngine();
  fresh.engine.restore(x.snapshots.at(-1)![0], {});
  fresh.engine.clearFinished();
  await fresh.engine.onMessage(JSON.stringify({ t: 'resume', id: x.saved.id, fp: x.saved.fp }));
  await fresh.engine.onMessage(JSON.stringify({ t: 'meta', ...x.saved }));
  await new Promise((r) => setImmediate(r));
  assert.ok(fresh.sent.every((m) => m.t === 'cancel' && m.id === x.saved.id));
  assert.equal(fresh.engine.items().length, 0);
});

test('failed cancellation commit preserves the partial and can be retried', async () => {
  const x = recoveryEngine(), sink = new FakeSink();
  x.engine.restore(x.saved, { sink, offset: 2 });
  x.setCommit(async () => { throw new Error('disk full'); });
  assert.equal(await x.engine.cancel(x.saved.id), false);
  assert.equal(sink.aborted, false);
  assert.deepEqual(x.sent, []);
  assert.equal(x.engine.hasUnfinished(), true);
  x.setCommit();
  assert.equal(await x.engine.cancel(x.saved.id), true);
  assert.equal(sink.aborted, true);
});

test('cancellation supersedes a stale paused journal after restoration', async () => {
  const x = recoveryEngine(), sink = new FakeSink();
  x.engine.restore(x.saved, { sink, offset: 2 });
  x.engine.restore({ ...x.saved, state: 'cancelled' }, {});
  await until(() => sink.aborted, 'stale partial cleanup');
  x.engine.onOpen(true);
  await new Promise((r) => setImmediate(r));
  assert.equal(x.engine.hasUnfinished(), false);
  assert.ok(x.sent.every((m) => m.t === 'cancel'));
});

test('restoring a queue persists one complete snapshot with all files and outcomes', async () => {
  const x = recoveryEngine();
  const other = { ...x.saved, id: newTransferId(), dir: 'send' as const, path: '/chosen/source' };
  await x.engine.restoreAll([
    { saved: x.saved, sink: new FakeSink(), offset: 2 },
    { saved: other },
    { saved: { ...x.saved, id: newTransferId(), state: 'cancelled' } },
  ]);
  assert.equal(x.snapshots.length, 1);
  assert.equal(x.snapshots[0].length, 3);
  assert.equal(x.snapshots[0].find((i) => i.id === other.id)?.path, '/chosen/source');
});

test('keeping a transfer drains writes before checkpointing and can resume on the same channel', async () => {
  const x = recoveryEngine(), sink = new FakeSink();
  let checkpointed = false;
  sink.checkpoint = async () => { checkpointed = true; };
  x.engine.restore(x.saved, { sink, offset: 2 });
  await x.engine.onMessage(JSON.stringify({ t: 'resume', id: x.saved.id, fp: x.saved.fp }));
  await x.engine.onMessage(frame(x.saved.id, new Uint8Array([1]).buffer));
  await x.engine.onLost();
  assert.equal(checkpointed, true);
  assert.equal(sink.aborted, false);
  x.engine.onOpen(true);
  await x.engine.onMessage(JSON.stringify({ t: 'resume', id: x.saved.id, fp: x.saved.fp }));
  assert.deepEqual(x.sent.at(-1), { t: 'resume-at', id: x.saved.id, bytes: 3 });
});

test('cancel all waits for cancellations already committing', async () => {
  const x = recoveryEngine(), sink = new FakeSink();
  x.engine.restore(x.saved, { sink, offset: 2 });
  let release!: () => void;
  x.setCommit(() => new Promise<void>((resolve) => { release = resolve; }));
  const one = x.engine.cancel(x.saved.id);
  let finished = false;
  const all = x.engine.cancelAll().then((ok) => { finished = true; return ok; });
  await new Promise((r) => setImmediate(r));
  assert.equal(finished, false);
  x.setCommit(); release();
  assert.equal(await one, true);
  assert.equal(await all, true);
});

test('cancellation waits for an in-flight finalization and cannot send saved afterwards', async () => {
  const sink = new FakeSink(), x = recoveryEngine(sink);
  let release!: () => void, closing = false;
  sink.close = async () => { closing = true; await new Promise<void>((resolve) => { release = resolve; }); };
  await x.engine.onMessage(JSON.stringify({ t: 'meta', ...x.saved }));
  await x.engine.accept(x.saved.id);
  await x.engine.onMessage(frame(x.saved.id, new Uint8Array([1, 2, 3, 4, 5]).buffer));
  await x.engine.onMessage(JSON.stringify({ t: 'done', id: x.saved.id }));
  await until(() => closing, 'sink finishing');
  const cancelled = x.engine.cancel(x.saved.id);
  await new Promise((r) => setImmediate(r));
  assert.equal(sink.aborted, false, 'cleanup must not race the finalizer');
  release();
  assert.equal(await cancelled, true);
  assert.equal(sink.aborted, true);
  assert.ok(!x.sent.some((m) => m.t === 'saved'));
  assert.equal(x.snapshots.at(-1)![0].state, 'cancelled');
});

test('a completed receipt answers a replayed offer without creating another destination', async () => {
  const x = recoveryEngine();
  x.engine.restore({ ...x.saved, state: 'done' }, {});
  await x.engine.onMessage(JSON.stringify({ t: 'meta', ...x.saved }));
  assert.deepEqual(x.sent, [{ t: 'saved', id: x.saved.id }]);
  assert.equal(x.engine.items().length, 0);
  await x.engine.onMessage(JSON.stringify({ t: 'meta', ...x.saved, fp: 'b'.repeat(64) }));
  assert.equal(x.sent.at(-1).t, 'reject');
});
