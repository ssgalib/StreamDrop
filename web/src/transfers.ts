import {
  CHUNK, ID_LEN, MAX_FILES, MAX_SIZE, createReceiver, createSender, fingerprint, framed, newTransferId,
  parseFrame, parseMeta, parseResume, parseResumeAt, type Batch, type Channel, type Meta, type Sink,
} from "./transfer.ts";

// The transfer engine: every file moving between the two devices, in either direction. No page code
// here, so two engines can be wired together in a test. The page draws what items() returns.
//
//  send:    offered -> waiting (they accepted; one outgoing file streams at a time) -> active -> done
//  receive: offered (waiting for you) -> waiting (you accepted) -> active -> done
//  any:     paused when the connection drops mid-file, declined, cancelled, failed
export type Dir = "send" | "receive";
export type State = "offered" | "waiting" | "active" | "paused" | "done" | "declined" | "cancelled" | "failed";

export type Item = {
  readonly id: string;
  readonly dir: Dir;
  readonly name: string;
  readonly size: number;
  readonly type: string;
  state: State;
  bytes: number; // sent or stored so far
  speed: number; // bytes per second over the last 5 s
  note: string; // why it ended, or what it needs
  needsClick: boolean; // receive: a save location needs a click
  batch?: Batch;
};

// What a page reload needs to carry on with a file.
export type Saved = { id: string; dir: Dir; name: string; size: number; type: string; fp: string };

type Live = Item & {
  fp: string;
  announced?: boolean; // the other device has been told about this file
  file?: File;
  sender?: ReturnType<typeof createSender>;
  receiver?: ReturnType<typeof createReceiver>;
  sink?: Sink;
  resumeOffset: number;
  samples: [number, number][];
};

export type Env = {
  send(msg: object): void; // a control message; throws if the channel is closed
  channel(): Channel; // the current DataChannel (changes after a reconnect)
  channelOpen(): boolean;
  maxMessage(): number | undefined;
  chooseSink(meta: Meta): Promise<Sink>; // may throw AbortError, or SecurityError when it needs a click
  save(records: Saved[]): void; // persist what a reload could resume
  changed(): void; // something to redraw
  warn(text: string): void; // something the person should read
};

const MAX_PENDING = MAX_FILES;
const MAX_UNANSWERED = 100; // pages from before version 2 refuse offers past this many

export function createTransfers(env: Env) {
  const items = new Map<string, Live>();
  const autoBatches = new Set<string>(); // batches the person already said "accept all" to

  const unfinished = (it: Live) => ["offered", "waiting", "active", "paused"].includes(it.state);
  const say = (msg: object) => {
    try { env.send(msg); } catch { /* channel is gone: the connection reports it and everything pauses */ }
  };
  const metaMsg = (it: Live) => ({
    t: "meta", id: it.id, name: it.name, size: it.size, type: it.type, fp: it.fp, ...(it.batch && { batch: it.batch }),
  });
  const metaOf = (it: Live): Meta => ({ id: it.id, name: it.name, size: it.size, type: it.type, fp: it.fp });

  function persist() {
    const records: Saved[] = [];
    for (const it of items.values()) {
      const resumable = it.dir === "send" ? true : !!it.sink?.resumable;
      if (resumable && ["waiting", "active", "paused"].includes(it.state)) {
        records.push({ id: it.id, dir: it.dir, name: it.name, size: it.size, type: it.type, fp: it.fp });
      }
    }
    env.save(records);
  }

  function changed() {
    persist();
    env.changed();
  }

  function make(base: Omit<Live, "bytes" | "speed" | "note" | "needsClick" | "resumeOffset" | "samples">): Live {
    const it: Live = { ...base, bytes: 0, speed: 0, note: "", needsClick: false, resumeOffset: 0, samples: [] };
    items.set(it.id, it);
    return it;
  }

  function progress(it: Live, n: number) {
    const now = performance.now();
    if (n === 0) it.samples = [];
    it.samples.push([now, n]);
    while (it.samples.length > 1 && now - it.samples[0][0] > 5000) it.samples.shift();
    const [t0, b0] = it.samples[0];
    it.speed = now > t0 ? ((n - b0) * 1000) / (now - t0) : 0;
    it.bytes = n;
    env.changed();
  }

  // Tells the other device about the next files, keeping at most MAX_UNANSWERED waiting for an answer.
  function announce() {
    const offered = [...items.values()].filter((i) => i.dir === "send" && i.state === "offered");
    let open = offered.filter((i) => i.announced).length;
    for (const it of offered) {
      if (open >= MAX_UNANSWERED) return;
      if (it.announced || !it.fp) continue;
      it.announced = true;
      say(metaMsg(it));
      open++;
    }
  }

  // One outgoing file streams at a time; the rest wait their turn. Incoming files can arrive meanwhile.
  function pump() {
    if ([...items.values()].some((i) => i.dir === "send" && i.state === "active")) return;
    const next = [...items.values()].find((i) => i.dir === "send" && i.state === "waiting");
    if (next) startSending(next, 0);
  }

  function startSending(it: Live, from: number) {
    it.state = "active";
    it.bytes = from;
    it.samples = [];
    const chunk = Math.min(CHUNK, (env.maxMessage() ?? CHUNK + ID_LEN) - ID_LEN);
    it.sender = createSender(it.file!, framed(() => env.channel(), it.id), chunk, (n) => progress(it, n), from);
    it.sender.run().catch((err) => failItem(it, err));
    changed();
  }

  function finish(it: Live, state: State, note = "") {
    it.state = state;
    it.note = note;
    if (state === "done") it.bytes = it.size;
    it.sender?.cancel();
    it.sender = it.receiver = undefined;
    if (state !== "done") void it.sink?.abort();
    it.sink = undefined;
    it.file = state === "done" ? it.file : undefined;
    changed();
    announce();
    pump();
  }

  function failItem(it: Live, err: unknown) {
    // A send or write that fails because the channel died is a lost connection, not a failed file:
    // the connection reports it and everything pauses. Ignore it here.
    if (!env.channelOpen() || it.state === "paused" || !unfinished(it)) return;
    say({ t: "cancel", id: it.id });
    finish(it, "failed", err instanceof Error && err.name === "QuotaExceededError" ? "Not enough disk space" : err instanceof Error ? err.message : String(err));
  }

  const engine = {
    persist,
    items: () => [...items.values()] as Item[],
    hasUnfinished: () => [...items.values()].some(unfinished),
    activeCount: () => [...items.values()].filter((i) => i.state === "active").length,

    // Offer files to the other device. They show up at once and are announced as their fingerprints are ready.
    async offer(files: File[]) {
      if (files.length > MAX_FILES) return env.warn(`Pick at most ${MAX_FILES} files at a time.`);
      const batch = newTransferId();
      const made: [Live, File][] = [];
      files.forEach((file, i) => {
        const it = make({
          id: newTransferId(), dir: "send", name: file.name, size: file.size, type: file.type, state: "offered", fp: "",
          batch: { id: batch, i, n: files.length },
        });
        if (file.size > MAX_SIZE) finish(it, "failed", "Larger than the 20 GiB limit");
        else if (!file.name || file.name.length > 255) finish(it, "failed", "The file name is too long");
        else {
          it.file = file;
          made.push([it, file]);
        }
      });
      changed();
      for (const [it, file] of made) {
        const fp = await fingerprint(file);
        if (it.state !== "offered") continue; // cancelled while hashing
        it.fp = fp;
        announce();
      }
    },

    // Accept an offer. Must be called straight from a click: the save picker needs it.
    async accept(id: string, all = false) {
      const it = items.get(id);
      if (!it || it.dir !== "receive" || it.state !== "offered") return;
      if (all && it.batch) autoBatches.add(it.batch.id);
      let sink: Sink;
      try {
        sink = await env.chooseSink(metaOf(it));
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name === "AbortError") return; // picker cancelled: stay on the offer
        if (name === "SecurityError" || name === "NotAllowedError") {
          it.needsClick = true; // e.g. the second of many files and the browser wants a click for each
          changed();
          return;
        }
        say({ t: "reject", id, reason: err instanceof Error ? err.message : String(err) });
        return finish(it, "failed", err instanceof Error ? err.message : String(err));
      }
      if (items.get(id) !== it || it.state !== "offered") return void sink.abort(); // changed while the picker was open
      it.sink = sink;
      it.needsClick = false;
      it.receiver = createReceiver(it.size, sink, framed(() => env.channel(), id), (n) => progress(it, n), (e) => failItem(it, e));
      it.state = "waiting";
      changed();
      say({ t: "accept", id });
      // "Accept all": the rest of this batch that is already listed, too. Each may need its own click for a save location.
      if (all && it.batch) {
        for (const other of [...items.values()]) {
          if (other.dir === "receive" && other.state === "offered" && other.batch?.id === it.batch.id) await engine.accept(other.id, false);
        }
      }
    },

    async acceptAll() {
      for (const it of [...items.values()]) if (it.dir === "receive" && it.state === "offered") await engine.accept(it.id, true);
    },

    decline(id: string) {
      const it = items.get(id);
      if (!it || it.dir !== "receive" || it.state !== "offered") return;
      say({ t: "reject", id, reason: "declined" });
      finish(it, "declined");
    },

    declineAll() {
      for (const it of [...items.values()]) if (it.dir === "receive" && it.state === "offered") engine.decline(it.id);
    },

    cancel(id: string) {
      const it = items.get(id);
      if (!it || !unfinished(it)) return;
      say({ t: "cancel", id });
      finish(it, "cancelled");
    },

    cancelAll() {
      for (const it of [...items.values()]) if (unfinished(it)) engine.cancel(it.id);
    },

    clearFinished() {
      for (const [id, it] of items) if (!unfinished(it)) items.delete(id);
      env.changed();
    },

    // The send buffer drained: let every sender that was waiting for room carry on.
    onLow() {
      for (const it of items.values()) it.sender?.wake();
    },

    // The connection dropped. Files that were moving pause with their exact offsets; the rest wait as they are.
    async onLost() {
      const flushes: Promise<void>[] = [];
      for (const it of items.values()) {
        if (it.state !== "active") continue;
        it.state = "paused";
        if (it.dir === "send") {
          it.sender?.cancel();
          it.sender = undefined;
        } else {
          const r = it.receiver;
          it.receiver = undefined;
          // queued writes still land, so the offset we report is exact
          flushes.push(r ? r.flush().then((n) => { it.resumeOffset = it.bytes = n; }) : Promise.resolve());
        }
      }
      changed();
      await Promise.all(flushes);
    },

    // The DataChannel opened. After a reconnect, pick up wherever each file was. Everything here is
    // idempotent: the other side ignores what it already knows.
    onOpen(reconnected: boolean) {
      if (!reconnected) return;
      for (const it of items.values()) {
        if (it.dir === "send") {
          if (it.state === "paused") say({ t: "resume", id: it.id, fp: it.fp });
          else if (it.state === "offered" && it.announced) say(metaMsg(it));
        } else if (it.state === "waiting") say({ t: "accept", id: it.id });
      }
    },

    // After a page reload: carry on with a file this device was receiving or sending.
    restore(saved: Saved, extra: { sink?: Sink; offset?: number; file?: File }) {
      const it = make({ ...saved, state: "paused", file: extra.file, sink: extra.sink });
      it.bytes = it.resumeOffset = extra.offset ?? 0;
      changed();
    },

    async onMessage(data: string | ArrayBuffer) {
      if (typeof data !== "string") return onFrame(data);
      let msg: any;
      try { msg = JSON.parse(data); } catch { return; }
      const it = typeof msg?.id === "string" ? items.get(msg.id) : undefined;
      switch (msg?.t) {
        case "meta": return onMeta(msg);
        case "accept":
          if (it?.dir === "send" && it.state === "offered") {
            it.state = "waiting";
            changed();
            announce();
            pump();
          }
          return;
        case "reject":
          if (it?.dir !== "send") return;
          if (it.state === "paused") return finish(it, "failed", "The other device no longer has this file's progress. Send it again to start over.");
          if (it.state === "offered" || it.state === "waiting") {
            const reason = typeof msg.reason === "string" ? msg.reason.slice(0, 200) : "";
            return finish(it, "declined", reason && reason !== "declined" ? `The other device can't take it: ${reason}` : "");
          }
          return;
        case "ack":
          if (it?.dir === "send" && typeof msg.bytes === "number") it.sender?.ack(msg.bytes);
          return;
        case "done":
          if (it?.dir === "receive" && it.receiver && (it.state === "active" || it.state === "waiting")) {
            it.state = "active";
            it.note = "Finalizing…";
            changed();
            it.receiver.done().then(() => finish(it, "done"), (e) => failItem(it, e));
          }
          return;
        case "saved":
          if (it?.dir === "send" && (it.state === "active" || it.state === "paused")) finish(it, "done");
          return;
        case "cancel":
          if (it && unfinished(it)) finish(it, "cancelled", "The other device cancelled it");
          return;
        case "resume": return onResume(msg);
        case "resume-at":
          if (it?.dir === "send" && it.state === "paused" && it.file) {
            const bytes = parseResumeAt(msg, it.size);
            if (bytes !== null) startSending(it, bytes);
          }
          return;
      }
    },
  };
  return engine;

  function onMeta(msg: any) {
    const m = parseMeta(msg);
    if (!m) {
      env.warn("The other device sent an offer this page can't read.");
      if (typeof msg?.id === "string") say({ t: "reject", id: msg.id, reason: "invalid" });
      return;
    }
    if (items.has(m.id)) return; // repeated after a reconnect
    if ([...items.values()].filter((i) => i.dir === "receive" && i.state === "offered").length >= MAX_PENDING) {
      say({ t: "reject", id: m.id, reason: "too many offers" });
      return;
    }
    const it = make({ ...m, dir: "receive", state: "offered" });
    changed();
    // The person already said "accept all" to this batch: take the rest without asking again.
    if (m.batch && autoBatches.has(m.batch.id)) void engine.accept(it.id, true);
  }

  function onFrame(buf: ArrayBuffer) {
    const f = parseFrame(buf);
    const it = f && items.get(f.id);
    // Data for a file we cancelled, never accepted or don't know is dropped: chunks can still be in flight.
    if (!f || !it || it.dir !== "receive" || !it.receiver || (it.state !== "waiting" && it.state !== "active")) return;
    if (it.state === "waiting") {
      it.state = "active";
      changed();
    }
    it.receiver.chunk(f.data);
  }

  async function onResume(msg: any) {
    const it = typeof msg?.id === "string" ? items.get(msg.id) : undefined;
    const r = parseResume(msg);
    // It arrived, but the "saved" that said so was lost in the drop.
    if (it?.dir === "receive" && it.state === "done" && r?.fp === it.fp) return say({ t: "saved", id: it.id });
    // The sender came back. We can only continue what we kept, and only for the same file.
    if (!it || it.dir !== "receive" || !it.sink || !r || r.fp !== it.fp || !["paused", "waiting", "active"].includes(it.state)) {
      say({ t: "reject", id: typeof msg?.id === "string" ? msg.id : undefined, reason: "unknown" });
      return;
    }
    if (it.receiver) {
      // We hadn't noticed the old connection die yet: settle what arrived, then carry on from there.
      it.resumeOffset = await it.receiver.flush();
      it.receiver = undefined;
    }
    it.bytes = it.resumeOffset;
    it.samples = [];
    it.receiver = createReceiver(it.size, it.sink, framed(() => env.channel(), it.id), (n) => progress(it, n), (e) => failItem(it, e), it.resumeOffset);
    it.state = "waiting";
    changed();
    say({ t: "resume-at", id: it.id, bytes: it.resumeOffset });
  }
}

export type Transfers = ReturnType<typeof createTransfers>;
