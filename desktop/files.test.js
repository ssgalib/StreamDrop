"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { safeName, safeRel, inside, createSinks, walk, read } = require("./files.js");
const vectors = require("../docs/vectors.json");

const ID = "A".repeat(26), ID2 = "B".repeat(26);

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sd-files-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const bytes = (s) => new TextEncoder().encode(s).buffer;

test("hostile names are cleaned, per the shared vectors", () => {
  for (const [input, want] of vectors.names) assert.equal(safeName(input), want, JSON.stringify(input));
});

test("hostile folders are dropped, per the shared vectors", () => {
  for (const [input, want] of vectors.rels) assert.equal(safeRel(input), want, JSON.stringify(input));
  assert.equal(safeRel(undefined), "");
  assert.equal(safeRel(7), "");
});

test("very long names fit the file system and keep their extension", () => {
  const long = safeName(`${"名".repeat(255)}.tar`);
  assert.ok(Buffer.byteLength(long) <= 240);
  assert.ok(long.endsWith(".tar"));
});

test("inside() only accepts real descendants", () => {
  assert.ok(inside("/a/b", "/a/b/c"));
  assert.ok(!inside("/a/b", "/a/b"));
  assert.ok(!inside("/a/b", "/a/bc"));
  assert.ok(!inside("/a/b", "/a/b/../c"));
  assert.ok(inside("/a/b", "/a/b/..c"), "a name that merely starts with dots");
});

test("a file arrives under its name, and the part is gone", async (t) => {
  const root = await tmp(t);
  const s = createSinks(() => root);
  await s.open({ id: ID, name: "a.txt", size: 5 });
  await s.write(ID, bytes("he"));
  await s.write(ID, bytes("llo"));
  assert.equal(await s.close(ID), path.join(root, "a.txt"));
  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "hello");
  assert.deepEqual(await fs.readdir(path.join(root, ".streamdrop")), []);
});

test("an existing file is never overwritten", async (t) => {
  const root = await tmp(t);
  await fs.writeFile(path.join(root, "a.tar.gz"), "precious");
  const s = createSinks(() => root);
  await s.open({ id: ID, name: "a.tar.gz", size: 1 });
  await s.write(ID, bytes("x"));
  const final = await s.close(ID);
  assert.equal(path.basename(final), "a.tar (1).gz");
  assert.equal(await fs.readFile(path.join(root, "a.tar.gz"), "utf8"), "precious");
});

test("a hostile name or folder can't leave the target folder", async (t) => {
  const outer = await tmp(t);
  const root = path.join(outer, "target");
  await fs.mkdir(root);
  const s = createSinks(() => root);
  for (const [i, [name, rel]] of [["../evil", undefined], ["ok", "../../evil"], ["../../evil", "a/../.."], ["/abs", "/abs"]].entries()) {
    const id = String.fromCharCode(65 + i).repeat(26);
    await s.open({ id, name, rel, size: 1, subdir: "../../up" });
    await s.write(id, bytes("x"));
    assert.ok(inside(root, await s.close(id)), name);
  }
  assert.deepEqual(await fs.readdir(outer), ["target"]);
});

test("a bad transfer id can't reach the file system", async (t) => {
  const root = await tmp(t);
  const s = createSinks(() => root);
  for (const id of ["../../x", "", "a".repeat(26), 7]) {
    await assert.rejects(s.open({ id, name: "a", size: 1 }));
    await assert.rejects(s.abort(id));
    await assert.rejects(s.offset(id));
  }
});

test("a folder is rebuilt, and an accepted subfolder is cleaned", async (t) => {
  const root = await tmp(t);
  const s = createSinks(() => root);
  await s.open({ id: ID, name: "a.txt", rel: "top/sub", size: 1, subdir: "Laptop: home" });
  await s.write(ID, bytes("x"));
  assert.equal(await s.close(ID), path.join(root, "Laptop_ home", "top", "sub", "a.txt"));
});

test("after a crash, resume starts at what reached the disk and drops the rest", async (t) => {
  const root = await tmp(t);
  const s = createSinks(() => root);
  const chunk = new ArrayBuffer(1024 * 1024);
  await s.open({ id: ID, name: "big.bin", rel: "dir", size: 200 * 1024 ** 2, subdir: "Dev" });
  for (let i = 0; i < 70; i++) await s.write(ID, chunk); // one sync at 64 MiB, then 6 MiB not yet synced

  const after = createSinks(() => root); // a new process: nothing in memory
  assert.equal(await after.offset(ID), 64 * 1024 ** 2);
  const { offset } = await after.open({ id: ID, name: "ignored", size: 0, resume: true });
  assert.equal(offset, 64 * 1024 ** 2);
  assert.equal((await fs.stat(path.join(root, ".streamdrop", `${ID}.part`))).size, offset);
  await after.write(ID, bytes("tail"));
  const final = await after.close(ID);
  assert.equal(final, path.join(root, "Dev", "dir", "big.bin"), "name and folder come from the record");
  assert.equal((await fs.stat(final)).size, offset + 4);
});

test("a tampered record can't move the file out", async (t) => {
  const root = await tmp(t);
  const s = createSinks(() => root);
  await s.open({ id: ID, name: "a", size: 1 });
  await fs.writeFile(path.join(root, ".streamdrop", `${ID}.json`), JSON.stringify({ name: "../../evil", rel: "../..", subdir: "../..", offset: 0 }));
  const after = createSinks(() => root);
  await after.open({ id: ID, name: "", size: 0, resume: true });
  assert.ok(inside(root, await after.close(ID)));
});

test("resuming with no record fails instead of starting an empty file", async (t) => {
  const root = await tmp(t);
  await assert.rejects(createSinks(() => root).open({ id: ID, name: "a", size: 0, resume: true }));
});

test("abort removes everything", async (t) => {
  const root = await tmp(t);
  const s = createSinks(() => root);
  await s.open({ id: ID, name: "a", size: 1 });
  await s.write(ID, bytes("x"));
  await s.abort(ID);
  assert.deepEqual(await fs.readdir(path.join(root, ".streamdrop")), []);
  await assert.rejects(s.write(ID, bytes("x")));
});

test("no room on the disk is refused up front", async (t) => {
  const root = await tmp(t);
  const s = createSinks(() => root);
  await assert.rejects(s.open({ id: ID, name: "a", size: Number.MAX_SAFE_INTEGER }), { name: "QuotaExceededError" });
});

test("clean removes only old leftovers", async (t) => {
  const root = await tmp(t);
  const s = createSinks(() => root);
  await s.open({ id: ID, name: "fresh", size: 1 });
  await s.open({ id: ID2, name: "old", size: 1 });
  await s.abort(ID2);
  const dir = path.join(root, ".streamdrop");
  const stale = path.join(dir, `${ID2}.part`);
  await fs.writeFile(stale, "x");
  await fs.utimes(stale, new Date(0), new Date(0));
  await s.clean();
  assert.deepEqual((await fs.readdir(dir)).sort(), [`${ID}.json`, `${ID}.part`]);
});

test("walking a folder keeps structure, and links can't lead outside", async (t) => {
  const outer = await tmp(t);
  const top = path.join(outer, "album");
  await fs.mkdir(path.join(top, "sub"), { recursive: true });
  await fs.writeFile(path.join(top, "a.txt"), "a");
  await fs.writeFile(path.join(top, "sub", "b.txt"), "bb");
  await fs.writeFile(path.join(outer, "secret"), "s");
  await fs.symlink(path.join(outer, "secret"), path.join(top, "leak"));
  await fs.symlink(outer, path.join(top, "up"));
  await fs.symlink(top, path.join(top, "sub", "loop"));
  await fs.symlink(path.join(top, "a.txt"), path.join(top, "alias"));
  const got = (await walk(top)).map((e) => `${e.rel}|${e.name}|${e.size}`).sort();
  assert.deepEqual(got, ["album/sub|b.txt|2", "album|a.txt|1", "album|alias|1"]);
});

test("read returns the slice asked for, and stops at the end of the file", async (t) => {
  const f = path.join(await tmp(t), "f");
  await fs.writeFile(f, "0123456789");
  assert.equal(Buffer.from(await read(f, 2, 5)).toString(), "234");
  assert.equal(Buffer.from(await read(f, 8, 20)).toString(), "89");
});
