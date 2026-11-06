import test from "node:test";
import assert from "node:assert/strict";
import { chunkCount, cipherSize, decryptChunk, decryptMeta, encryptChunk, encryptMeta, exportKey, importKey, newKey, parseStoredLink, STORE_CHUNK } from "./store.ts";

const bytes = (n: number) => crypto.getRandomValues(new Uint8Array(Math.min(n, 65536))).slice(0, n).buffer;

test("chunk arithmetic: zero bytes still takes one chunk, and every chunk adds a 16-byte tag", () => {
  assert.equal(chunkCount(0), 1);
  assert.equal(chunkCount(1), 1);
  assert.equal(chunkCount(STORE_CHUNK), 1);
  assert.equal(chunkCount(STORE_CHUNK + 1), 2);
  assert.equal(cipherSize(0), 16);
  assert.equal(cipherSize(STORE_CHUNK + 1), STORE_CHUNK + 1 + 32);
});

test("encrypt then decrypt returns the original bytes, for empty and odd sizes", async () => {
  const key = await newKey();
  for (const n of [0, 1, 100, 65535]) {
    const plain = bytes(n);
    const sealed = await encryptChunk(key, plain, 3, 7);
    assert.equal(sealed.byteLength, n + 16);
    assert.deepEqual(new Uint8Array(await decryptChunk(key, sealed, 3, 7)), new Uint8Array(plain));
  }
});

test("the key survives export and import through the link", async () => {
  const key = await newKey();
  const text = await exportKey(key);
  assert.match(text, /^[A-Za-z0-9_-]{43}$/);
  const sealed = await encryptChunk(key, bytes(50), 0, 1);
  const again = await importKey(text);
  assert.equal((await decryptChunk(again, sealed, 0, 1)).byteLength, 50);
});

test("a tampered chunk fails to decrypt", async () => {
  const key = await newKey();
  const sealed = new Uint8Array(await encryptChunk(key, bytes(100), 0, 1));
  sealed[5] ^= 1;
  await assert.rejects(decryptChunk(key, sealed.buffer, 0, 1));
});

test("swapped, reordered or dropped chunks fail", async () => {
  const key = await newKey();
  const c0 = await encryptChunk(key, bytes(100), 0, 3);
  const c1 = await encryptChunk(key, bytes(100), 1, 3);
  await assert.rejects(decryptChunk(key, c0, 1, 3), "chunk 0 served as chunk 1");
  await assert.rejects(decryptChunk(key, c1, 0, 3), "chunk 1 served as chunk 0");
  await assert.rejects(decryptChunk(key, c0, 0, 2), "file truncated to 2 chunks");
  await assert.rejects(decryptChunk(key, c0, 0, 4), "chunks added");
});

test("a different key cannot decrypt", async () => {
  const sealed = await encryptChunk(await newKey(), bytes(100), 0, 1);
  await assert.rejects(decryptChunk(await newKey(), sealed, 0, 1));
});

test("encrypting the same data twice gives different bytes only if the position differs", async () => {
  const key = await newKey();
  const plain = bytes(64);
  const a = new Uint8Array(await encryptChunk(key, plain, 0, 2));
  const b = new Uint8Array(await encryptChunk(key, plain, 1, 2));
  assert.notDeepEqual(a, b, "never the same IV for two positions");
});

test("the file name is encrypted and validated when read back", async () => {
  const key = await newKey();
  const sealed = await encryptMeta(key, { name: "secret plans.pdf", size: 123, type: "application/pdf" });
  assert.ok(!Buffer.from(sealed, "base64").includes("secret plans"), "the name must not appear in the sealed block");
  assert.deepEqual(await decryptMeta(key, sealed), { name: "secret plans.pdf", size: 123, type: "application/pdf" });
  const evil = await encryptMeta(key, { name: "", size: -5, type: "x" });
  await assert.rejects(decryptMeta(key, evil), /invalid/);
  await assert.rejects(decryptMeta(await newKey(), sealed));
});

test("stored links parse strictly", () => {
  const id = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".slice(0, 26), key = "A".repeat(43);
  assert.deepEqual(parseStoredLink(`#s/${id}.${key}`), { id, key });
  for (const h of ["", "#", `#${id}`, `#s/${id}`, `#s/${id}.${key}x`, `#s/${id.toLowerCase()}.${key}`, `#s/${id}.${key.slice(1)}`, `#s/../x.${key}`, `#S/${id}.${key}`]) {
    assert.equal(parseStoredLink(h), null, h);
  }
});
