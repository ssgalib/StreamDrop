export const CHUNK = 64 * 1024;
export const HIGH_WATER = 4 * 1024 * 1024;
export const LOW_WATER = 1024 * 1024;
export const WINDOW = 16 * 1024 * 1024; // max bytes sent but not yet stored
export const ACK_EVERY = 1024 * 1024;
export const MAX_SIZE = 20 * 1024 ** 3;

export type Channel = { bufferedAmount: number; send(data: string | ArrayBuffer): void };

// id names the transfer on the wire; fp (a fingerprint of the file) lets it be resumed. Both are required.
// batch ties together the files picked at the same time, so the receiver can accept them all at once.
export type Batch = { id: string; i: number; n: number };
export type Meta = { name: string; size: number; type: string; id: string; fp: string; batch?: Batch };

const ID_RE = /^[A-Z2-7]{26}$/; // same shape as the server's room ids
const FP_RE = /^[0-9a-f]{64}$/;
export const MAX_FILES = 500;
export const isId = (s: unknown): s is string => typeof s === "string" && ID_RE.test(s);

export type FileInfo = { name: string; size: number; type: string };

// The other person controls every field, so check them all before showing a prompt.
export function parseFileInfo(m: any): FileInfo | null {
  const { name, size, type } = m ?? {};
  if (typeof name !== "string" || !name || name.length > 255) return null;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SIZE) return null;
  if (typeof type !== "string") return null;
  return { name, size, type: /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "application/octet-stream" };
}

export function parseMeta(m: any): Meta | null {
  const info = parseFileInfo(m);
  const { id, fp, batch } = m ?? {};
  if (!info) return null;
  if (typeof id !== "string" || !ID_RE.test(id) || typeof fp !== "string" || !FP_RE.test(fp)) return null;
  let b: Batch | undefined;
  if (batch !== undefined) {
    const { id: bid, i, n } = batch ?? {};
    if (typeof bid !== "string" || !ID_RE.test(bid) || !Number.isSafeInteger(i) || !Number.isSafeInteger(n)) return null;
    if (n < 1 || n > MAX_FILES || i < 0 || i >= n) return null;
    b = { id: bid, i, n };
  }
  return { ...info, id, fp, ...(b && { batch: b }) };
}

// Several transfers share one DataChannel, so every chunk starts with the 26-character id of its transfer.
export const ID_LEN = 26;

export function frame(id: string, data: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(ID_LEN + data.byteLength);
  out.set(new TextEncoder().encode(id));
  out.set(new Uint8Array(data), ID_LEN);
  return out.buffer;
}

export function parseFrame(buf: ArrayBuffer): { id: string; data: ArrayBuffer } | null {
  if (buf.byteLength < ID_LEN) return null;
  const id = new TextDecoder().decode(new Uint8Array(buf, 0, ID_LEN));
  return ID_RE.test(id) ? { id, data: buf.slice(ID_LEN) } : null;
}

// A channel that tags everything it sends with a transfer id. It asks for the current channel on every
// call, so a transfer that outlives a reconnect keeps working on the new connection.
export function framed(get: () => Channel, id: string): Channel {
  return {
    get bufferedAmount() { return get().bufferedAmount; },
    send(data) {
      get().send(typeof data === "string" ? JSON.stringify({ ...JSON.parse(data), id }) : frame(id, data));
    },
  };
}

// 128 random bits as 26 base32 characters, the form the server accepts for a transfer id.
export function newTransferId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out + alphabet[(value << (5 - bits)) & 31]; // 128 bits leave 3 over: pad to the 26th character
}

// Size, timestamp and the first and last MiB. Hashing a whole 20 GiB file would take too long, so an
// edit in the middle that keeps the same size and timestamp goes undetected (very unlikely).
export async function fingerprint(file: Blob & { lastModified?: number }) {
  const MiB = 1024 * 1024;
  const head = new Uint8Array(await file.slice(0, MiB).arrayBuffer());
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - MiB)).arrayBuffer());
  const label = new TextEncoder().encode(`${file.size}:${file.lastModified ?? 0}:`);
  const all = new Uint8Array(label.length + head.length + tail.length);
  all.set(label);
  all.set(head, label.length);
  all.set(tail, label.length + head.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseResume(m: any): { id: string; fp: string } | null {
  const { id, fp } = m ?? {};
  return typeof id === "string" && ID_RE.test(id) && typeof fp === "string" && FP_RE.test(fp) ? { id, fp } : null;
}

export function parseResumeAt(m: any, size: number): number | null {
  const bytes = m?.bytes;
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= size ? bytes : null;
}

export function createSender(
  file: Blob,
  ch: Channel,
  chunkSize: number,
  progress: (bytes: number) => void,
  start = 0, // resume: the receiver already has this many bytes
) {
  let acked = start;
  let cancelled = false;
  let wake = () => {};

  return {
    wake: () => wake(),
    ack(bytes: number) { acked = bytes; wake(); },
    cancel() { cancelled = true; wake(); },
    async run() {
      let sent = start;
      while (sent < file.size && !cancelled) {
        if (sent - acked >= WINDOW || ch.bufferedAmount > HIGH_WATER) {
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        // slice() reads only this piece, so a 20 GiB file never sits in memory.
        ch.send(await file.slice(sent, sent + chunkSize).arrayBuffer());
        sent = Math.min(sent + chunkSize, file.size);
        progress(sent);
      }
      if (!cancelled) ch.send(JSON.stringify({ t: "done" }));
    },
  };
}

export type Sink = {
  resumable?: boolean; // partial data survives closing the tab
  write(data: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};

export function createReceiver(
  size: number,
  sink: Sink,
  ch: Channel,
  progress: (bytes: number) => void,
  fail: (err: unknown) => void,
  start = 0, // resume: the sink already holds this many bytes
) {
  let arrived = start, stored = start, lastAck = start;
  let queue = Promise.resolve(); // keeps writes in order

  return {
    chunk(data: ArrayBuffer) {
      arrived += data.byteLength;
      // A correct sender can't trigger either check, so this one is misbehaving.
      if (arrived > size || arrived - stored > 2 * WINDOW) {
        fail(new Error("Sender broke the protocol"));
        return;
      }
      queue = queue.then(async () => {
        await sink.write(data);
        stored += data.byteLength;
        progress(stored);
        if (stored - lastAck >= ACK_EVERY) {
          lastAck = stored;
          ch.send(JSON.stringify({ t: "ack", bytes: stored }));
        }
      }).catch(fail);
    },
    // Waits for queued writes, then says how many bytes are really stored: the offset to resume from.
    async flush() {
      await queue;
      return stored;
    },
    async done() {
      await queue;
      if (stored !== size) throw new Error("File is incomplete");
      await sink.close();
      ch.send(JSON.stringify({ t: "saved" }));
    },
  };
}
