export const CHUNK = 64 * 1024;
export const HIGH_WATER = 4 * 1024 * 1024;
export const LOW_WATER = 1024 * 1024;
export const WINDOW = 16 * 1024 * 1024; // max bytes sent but not yet stored
export const ACK_EVERY = 1024 * 1024;
export const MAX_SIZE = 20 * 1024 ** 3;

type Channel = { bufferedAmount: number; send(data: string | ArrayBuffer): void };

export type Meta = { name: string; size: number; type: string };

// The other person controls every field, so check them all before showing a prompt.
export function parseMeta(m: any): Meta | null {
  const { name, size, type } = m ?? {};
  if (typeof name !== "string" || !name || name.length > 255) return null;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SIZE) return null;
  if (typeof type !== "string") return null;
  return {
    name,
    size,
    type: /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "application/octet-stream",
  };
}

export function createSender(
  file: Blob,
  ch: Channel,
  chunkSize: number,
  progress: (bytes: number) => void,
) {
  let acked = 0;
  let cancelled = false;
  let wake = () => {};

  return {
    wake: () => wake(),
    ack(bytes: number) { acked = bytes; wake(); },
    cancel() { cancelled = true; wake(); },
    async run() {
      let sent = 0;
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
) {
  let arrived = 0, stored = 0, lastAck = 0;
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
    async done() {
      await queue;
      if (stored !== size) throw new Error("File is incomplete");
      await sink.close();
      ch.send(JSON.stringify({ t: "saved" }));
    },
  };
}
