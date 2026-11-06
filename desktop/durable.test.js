"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { atomicJson, writeAll } = require("./durable.js");

test("atomic records replace complete JSON with private permissions and no leftovers", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sd-journal-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "record.json");
  await atomicJson(file, { offset: 1 });
  await atomicJson(file, { offset: 2 });
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { offset: 2 });
  assert.deepEqual(await fs.readdir(dir), ["record.json"]);
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("short writes are retried at the correct offset; zero writes fail", async () => {
  const result = Buffer.alloc(6);
  const handle = { async write(data, offset, length, position) {
    const n = Math.min(length, 2);
    data.copy(result, position, offset, offset + n);
    return { bytesWritten: n };
  } };
  await writeAll(handle, Buffer.from("abcdef"), 0);
  assert.equal(result.toString(), "abcdef");
  await assert.rejects(writeAll({ write: async () => ({ bytesWritten: 0 }) }, Buffer.from("a"), 0), /write/);
});
