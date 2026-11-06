import type { Sink } from "./transfer";

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
