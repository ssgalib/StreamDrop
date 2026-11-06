import { parseFileInfo, type FileInfo, type Sink } from "./transfer.ts";

// Stored mode: the file is encrypted here, in 8 MiB chunks, before it leaves the browser.
// The key travels only in the link's #fragment, so the server holds ciphertext it cannot read.
export const STORE_CHUNK = 8 * 1024 * 1024;
const TAG = 16; // AES-GCM tag bytes added to every chunk

export const chunkCount = (size: number) => Math.max(1, Math.ceil(size / STORE_CHUNK));
export const cipherSize = (size: number) => size + TAG * chunkCount(size);

const b64 = (b: ArrayBuffer | Uint8Array) => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (b: ArrayBuffer) => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => unb64(s.replace(/-/g, "+").replace(/_/g, "/"));

export const newKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
export async function exportKey(key: CryptoKey) { return b64url(await crypto.subtle.exportKey("raw", key)); }
export function importKey(text: string) {
  return crypto.subtle.importKey("raw", unb64url(text), "AES-GCM", false, ["decrypt"]);
}

// A key is used for one file only. The IV comes from the position, so it is never reused with different data;
// the first IV byte separates chunks (0) from the name block (1).
function iv(kind: 0 | 1, index: number) {
  const out = new Uint8Array(12);
  out[0] = kind;
  new DataView(out.buffer).setUint32(8, index);
  return out;
}

// The index and total are authenticated, so the server can't reorder, swap or drop chunks unnoticed.
const aad = (index: number, total: number) => new TextEncoder().encode(`chunk:${index}/${total}`);

export const encryptChunk = (key: CryptoKey, plain: ArrayBuffer, index: number, total: number) =>
  crypto.subtle.encrypt({ name: "AES-GCM", iv: iv(0, index), additionalData: aad(index, total) }, key, plain);

export const decryptChunk = (key: CryptoKey, cipher: ArrayBuffer, index: number, total: number) =>
  crypto.subtle.decrypt({ name: "AES-GCM", iv: iv(0, index), additionalData: aad(index, total) }, key, cipher);

const META_AAD = new TextEncoder().encode("meta");

export async function encryptMeta(key: CryptoKey, meta: { name: string; size: number; type: string }) {
  const plain = new TextEncoder().encode(JSON.stringify(meta));
  return b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv(1, 0), additionalData: META_AAD }, key, plain));
}

export async function decryptMeta(key: CryptoKey, text: string): Promise<FileInfo> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv(1, 0), additionalData: META_AAD }, key, unb64(text));
  const meta = parseFileInfo(JSON.parse(new TextDecoder().decode(plain))); // whoever uploaded it controls these fields
  if (!meta) throw new Error("The file's details are invalid.");
  return meta;
}

// Fetch with a few retries; the body is a buffer, so a retry resends exactly the same bytes.
async function request(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetch(url, init);
      if (resp.ok || resp.status < 500 || resp.status === 503) return resp; // 503 = budget used up: retrying won't help
      last = new Error(`Server error ${resp.status}`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  throw last;
}

function failureText(status: number) {
  if (status === 401) return "Wrong passcode.";
  if (status === 507) return "The server has no room for this file right now.";
  if (status === 503) return "The server has reached its monthly transfer limit. Try again next month.";
  if (status === 404) return "This file is gone: it expired or was deleted.";
  if (status === 429) return "This file has been downloaded as many times as allowed.";
  return `The server refused the request (${status}).`;
}

export type Uploaded = { link: string; id: string; writeToken: string; expiresAt: string };

export async function upload(
  file: File,
  passcode: string,
  progress: (done: number, total: number) => void,
): Promise<Uploaded> {
  const key = await newKey();
  const total = chunkCount(file.size);
  const created = await request("/store", {
    method: "POST",
    headers: { "X-Store-Key": passcode, "Content-Type": "application/json" },
    body: JSON.stringify({
      size: cipherSize(file.size),
      chunks: total,
      meta: await encryptMeta(key, { name: file.name, size: file.size, type: file.type }),
    }),
  });
  if (!created.ok) throw new Error(failureText(created.status));
  const { id, writeToken, expiresAt } = await created.json();
  progress(0, file.size);
  for (let i = 0; i < total; i++) {
    const plain = await file.slice(i * STORE_CHUNK, (i + 1) * STORE_CHUNK).arrayBuffer();
    const body = await encryptChunk(key, plain, i, total); // encrypted once: a retry reuses this exact buffer
    const put = await request(`/store/${id}/${i}`, { method: "PUT", headers: { "X-Write-Token": writeToken }, body });
    if (!put.ok) throw new Error(failureText(put.status));
    progress(Math.min((i + 1) * STORE_CHUNK, file.size), file.size);
  }
  const done = await request(`/store/${id}/finish`, { method: "POST", headers: { "X-Write-Token": writeToken } });
  if (!done.ok) throw new Error(failureText(done.status));
  return { link: `${location.origin}/#s/${id}.${await exportKey(key)}`, id, writeToken, expiresAt };
}

export async function removeUpload(id: string, writeToken: string) {
  await fetch(`/store/${id}`, { method: "DELETE", headers: { "X-Write-Token": writeToken } });
}

const LINK_RE = /^#s\/([A-Z2-7]{26})\.([A-Za-z0-9_-]{43})$/;
export function parseStoredLink(hash: string): { id: string; key: string } | null {
  const m = LINK_RE.exec(hash);
  return m ? { id: m[1], key: m[2] } : null;
}

export type Stored = { meta: FileInfo; chunks: number; expiresAt: string };

export async function fetchStored(id: string, keyText: string): Promise<Stored & { key: CryptoKey }> {
  const resp = await request(`/store/${id}`, {});
  if (!resp.ok) throw new Error(failureText(resp.status));
  const info = await resp.json();
  const key = await importKey(keyText);
  let meta: FileInfo;
  try {
    meta = await decryptMeta(key, info.meta);
  } catch {
    throw new Error("This link is incomplete or damaged: it can't unlock the file.");
  }
  if (!Number.isSafeInteger(info.chunks) || info.chunks !== chunkCount(meta.size)) throw new Error("The file doesn't match its details.");
  return { meta, chunks: info.chunks, expiresAt: String(info.expiresAt), key };
}

// Decrypt each chunk into the sink as it arrives, so a big file is never held in memory.
export async function downloadStored(
  id: string,
  stored: Stored & { key: CryptoKey },
  sink: Sink,
  progress: (done: number, total: number) => void,
) {
  let done = 0;
  try {
    for (let i = 0; i < stored.chunks; i++) {
      const resp = await request(`/store/${id}/${i}`, {});
      if (!resp.ok) throw new Error(failureText(resp.status));
      let plain: ArrayBuffer;
      try {
        plain = await decryptChunk(stored.key, await resp.arrayBuffer(), i, stored.chunks);
      } catch {
        throw new Error("The file was altered or damaged on the server. It was not saved.");
      }
      await sink.write(plain);
      done += plain.byteLength;
      progress(done, stored.meta.size);
    }
    if (done !== stored.meta.size) throw new Error("The file is incomplete.");
    await sink.close();
  } catch (err) {
    await sink.abort();
    throw err;
  }
}
