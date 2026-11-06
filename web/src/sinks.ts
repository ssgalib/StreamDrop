import type { Meta, Sink } from "./transfer";

const MEMORY_LIMIT = 512 * 1024 ** 2;
const OPFS_MAX_AGE = 24 * 60 * 60 * 1000;

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function memorySink(name: string, type: string): Sink {
  const parts: ArrayBuffer[] = [];
  return {
    write: async (data) => { parts.push(data); },
    close: async () => downloadBlob(new Blob(parts, { type }), name),
    abort: async () => { parts.length = 0; },
  };
}

export async function pickerSink(name: string): Promise<Sink> {
  // Typed as any to avoid a dev dependency for one non-standard API.
  const handle = await (window as any).showSaveFilePicker({ suggestedName: name });
  const out = await handle.createWritable();
  return {
    write: (data) => out.write(data),
    close: () => out.close(),
    abort: () => out.abort(),
  };
}

export async function opfsSink(name: string, type: string): Promise<Sink> {
  const root = await navigator.storage.getDirectory();
  const tempName = crypto.randomUUID(); // never use the peer's file name as a path
  const handle = await root.getFileHandle(tempName, { create: true });
  const out = await handle.createWritable();
  return {
    write: (data) => out.write(data),
    async close() {
      await out.close();
      const file = await handle.getFile();
      downloadBlob(new Blob([file], { type }), name);
    },
    async abort() {
      await out.abort();
      await root.removeEntry(tempName);
    },
  };
}

// Must be called straight from a click: showSaveFilePicker is invoked before the first await.
export async function chooseSink(meta: Meta): Promise<Sink> {
  if ("showSaveFilePicker" in window) return pickerSink(meta.name);
  if (navigator.storage && "getDirectory" in navigator.storage) {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    if (meta.size * 2 < quota - usage) return opfsSink(meta.name, meta.type);
  }
  if (meta.size <= MEMORY_LIMIT) return memorySink(meta.name, meta.type);
  throw new Error("This browser can't save a file this large. Try Chrome or Edge on a computer.");
}

// OPFS space isn't freed by downloading. Age (not "unused") is what protects a transfer in another tab.
export async function cleanOpfs() {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const [name, h] of (root as any).entries()) {
      if (h.kind === "file" && Date.now() - (await h.getFile()).lastModified > OPFS_MAX_AGE) {
        await root.removeEntry(name);
      }
    }
  } catch { /* OPFS unavailable or busy: nothing to clean */ }
}
