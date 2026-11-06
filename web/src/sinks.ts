import type { FileInfo, Sink } from "./transfer";

const MEMORY_LIMIT = 512 * 1024 ** 2;
const OPFS_MAX_AGE = 24 * 60 * 60 * 1000;
const PART = 64 * 1024 ** 2; // a part is only committed when closed, so this is the most a tab close can lose

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

// A writable stream only commits on close(), so a tab that closes mid-file loses everything in it.
// Writing closed parts of 64 MiB means everything but the open part survives a tab close or restart.
const partName = (i: number) => `p${String(i).padStart(6, "0")}`;
const PART_RE = /^p(\d{6})$/;

// Directory listings come back in any order, and joining parts out of order would corrupt the file.
export function sortedPartNames(names: string[]): string[] {
  return names.filter((n) => PART_RE.test(n)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

async function names(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const out: string[] = [];
  for await (const [name] of (dir as any).entries()) out.push(name);
  return out;
}

const partsDir = (id: string) => `resume-${id}`; // id is validated by parseMeta: never a path

function partsSink(
  dir: FileSystemDirectoryHandle,
  root: FileSystemDirectoryHandle,
  id: string,
  name: string,
  type: string,
  firstIndex: number,
): Sink {
  let index = firstIndex;
  let written = 0;
  let out: FileSystemWritableFileStream | undefined;
  let aborted = false;
  return {
    resumable: true,
    async write(data) {
      if (aborted) return; // a write that was already queued when the file was discarded
      if (!out) {
        out = await (await dir.getFileHandle(partName(index), { create: true })).createWritable();
        written = 0;
      }
      await out.write(data);
      written += data.byteLength;
      if (written >= PART) {
        await out.close();
        out = undefined;
        index++;
      }
    },
    async close() {
      await out?.close();
      out = undefined;
      const files: File[] = [];
      for (const n of sortedPartNames(await names(dir))) files.push(await (await dir.getFileHandle(n)).getFile());
      downloadBlob(new Blob(files, { type }), name); // a Blob of Files reads lazily: no 20 GiB in memory
    },
    async abort() {
      aborted = true;
      try { await out?.abort(); } catch { /* already closing or closed */ }
      out = undefined;
      // A part that is mid-close keeps its file locked for a moment, so removal can fail: retry.
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          await root.removeEntry(partsDir(id), { recursive: true });
          return;
        } catch (err) {
          if (err instanceof DOMException && err.name === "NotFoundError") return;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    },
  };
}

// Start fresh: any parts left under this id are discarded.
export async function opfsPartsSink(id: string, name: string, type: string): Promise<Sink> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(partsDir(id), { recursive: true }).catch(() => {});
  const dir = await root.getDirectoryHandle(partsDir(id), { create: true });
  return partsSink(dir, root, id, name, type, 0);
}

// Reopen after a reload: drop empty parts (the one that was open when the tab closed) and count the rest.
export async function openParts(id: string, name: string, type: string): Promise<{ sink: Sink; offset: number }> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(partsDir(id), { create: true });
  let offset = 0;
  let last = -1;
  for (const n of sortedPartNames(await names(dir))) {
    const size = (await (await dir.getFileHandle(n)).getFile()).size;
    if (size === 0) {
      await dir.removeEntry(n);
      continue;
    }
    offset += size;
    last = Number(n.slice(1));
  }
  return { sink: partsSink(dir, root, id, name, type, last + 1), offset };
}

// How many bytes a reload could resume from, without creating anything.
export async function partsOffset(id: string): Promise<number> {
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(partsDir(id));
    let offset = 0;
    for (const n of sortedPartNames(await names(dir))) offset += (await (await dir.getFileHandle(n)).getFile()).size;
    return offset;
  } catch {
    return 0;
  }
}

export async function discardParts(id: string) {
  try { await (await navigator.storage.getDirectory()).removeEntry(partsDir(id), { recursive: true }); } catch { /* none */ }
}

// Prefers closed OPFS parts (resumable) when the file has a transfer id and fits, then the save picker.
// The picker must be called soon after a click; the quota check before it is quick.
export async function chooseSink(meta: FileInfo & { id?: string }): Promise<Sink> {
  // Safari has OPFS but no createWritable() on the main thread: without it, fall through to the next option.
  const hasOpfs =
    !!navigator.storage && "getDirectory" in navigator.storage &&
    typeof FileSystemFileHandle !== "undefined" && "createWritable" in FileSystemFileHandle.prototype;
  let fits = false;
  if (hasOpfs) {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    fits = meta.size * 2 < quota - usage;
  }
  if (meta.id && fits) return opfsPartsSink(meta.id, meta.name, meta.type);
  if ("showSaveFilePicker" in window) return pickerSink(meta.name);
  if (fits) return opfsSink(meta.name, meta.type);
  if (meta.size <= MEMORY_LIMIT) return memorySink(meta.name, meta.type);
  throw new Error("This browser can't save a file this large. Try Chrome or Edge on a computer.");
}

// OPFS space isn't freed by downloading. Age (not "unused") is what protects a transfer in another tab.
export async function cleanOpfs() {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const [name, h] of (root as any).entries()) {
      let newest = 0;
      if (h.kind === "file") newest = (await h.getFile()).lastModified;
      else if (name.startsWith("resume-")) {
        for await (const [, f] of h.entries()) newest = Math.max(newest, (await f.getFile()).lastModified);
      }
      // newest is 0 for an empty directory: leave it, it may belong to a transfer that just started
      if (newest && Date.now() - newest > OPFS_MAX_AGE) await root.removeEntry(name, { recursive: true });
    }
  } catch { /* OPFS unavailable or busy: nothing to clean */ }
}
