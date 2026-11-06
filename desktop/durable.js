"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

async function syncDirectory(dir) {
  // Windows does not support opening directories through Node's fs API for fsync.
  if (process.platform === "win32") return;
  const handle = await fs.open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeAll(handle, data, position) {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, position + offset);
    if (!bytesWritten) throw new Error("Couldn't write the file");
    offset += bytesWritten;
  }
}

// Each invocation has its own exclusive temporary file. Callers serialize logical updates.
async function atomicJson(file, value, { checkpoint = async () => {} } = {}) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await checkpoint("written");
    await handle.sync();
    await checkpoint("file-synced");
  } catch (err) {
    await handle.close();
    await fs.rm(tmp, { force: true });
    throw err;
  }
  await handle.close();
  try {
    await fs.rename(tmp, file);
    await checkpoint("renamed");
    await syncDirectory(path.dirname(file));
    await checkpoint("directory-synced");
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

module.exports = { atomicJson, syncDirectory, writeAll };
