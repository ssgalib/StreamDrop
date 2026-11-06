"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

// Everything about files, with no Electron here so plain Node can test it. Every name, folder and id
// that arrives from the other device is hostile until it has been through this file.

const TEMP_DIR = ".streamdrop";
const SYNC_EVERY = 64 * 1024 ** 2; // the most a crash can lose, matching the web's parts
const MAX_AGE = 24 * 60 * 60 * 1000;
const NAME_BYTES = 240; // file systems allow 255, and " (12)" must still fit
const ID_RE = /^[A-Z2-7]{26}$/;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

function fitBytes(name) {
  if (Buffer.byteLength(name) <= NAME_BYTES) return name;
  const ext = path.extname(name).slice(0, 20);
  const chars = [...name.slice(0, name.length - ext.length)];
  while (Buffer.byteLength(chars.join("") + ext) > NAME_BYTES) chars.pop();
  return chars.join("") + ext;
}

function safeName(name) {
  const s = String(name).normalize("NFC").replace(CONTROL, "").replace(BIDI, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/, "")
    .replace(/^ +/, "");
  if (!s) return "file";
  return fitBytes(RESERVED.test(s) ? `_${s}` : s);
}

// A folder path is only used if every part is plainly harmless. Otherwise the file lands flat in the target folder.
function safeRel(rel) {
  if (typeof rel !== "string" || !rel || rel.length > 1024) return "";
  const parts = rel.normalize("NFC").split("/");
  if (parts.length > 32) return "";
  for (const p of parts) {
    if (!p || p === "." || p === ".." || p === TEMP_DIR) return "";
    if (/[<>:"\\|?*]/.test(p) || p.search(CONTROL) >= 0 || p.search(BIDI) >= 0) return "";
    if (/[. ]$/.test(p) || RESERVED.test(p) || Buffer.byteLength(p) > NAME_BYTES) return "";
  }
  return parts.join("/");
}

function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return !!rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// Finds a free name by creating it, so two files can't race for one, and an existing file is never overwritten.
async function reserve(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 10_000; i++) {
    const candidate = path.join(dir, i ? `${stem} (${i})${ext}` : name);
    if (!inside(dir, candidate)) throw new Error("Refused an unsafe file name");
    try {
      await (await fs.open(candidate, "wx")).close();
      return candidate;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
  throw new Error("Too many files with that name");
}

// Received files go to <root>/.streamdrop/<id>.part, then move to their real name when complete. The sidecar
// records how much has reached the disk: after a crash, anything past that offset is not trusted.
function createSinks(getRoot, afterSave = async () => {}) {
  const open = new Map();
  const partPath = (root, id) => path.join(root, TEMP_DIR, `${id}.part`);
  const metaPath = (root, id) => path.join(root, TEMP_DIR, `${id}.json`);

  function checkId(id) {
    if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("Bad transfer id");
  }

  async function writeMeta(s) {
    const tmp = `${metaPath(s.root, s.id)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ name: s.name, rel: s.rel, subdir: s.subdir, offset: s.durable }));
    await fs.rename(tmp, metaPath(s.root, s.id));
  }

  async function readMeta(root, id) {
    const m = JSON.parse(await fs.readFile(metaPath(root, id), "utf8"));
    if (!Number.isSafeInteger(m.offset) || m.offset < 0) throw new Error("Bad record");
    return m;
  }

  async function sync(s) {
    await s.handle.sync();
    s.durable = s.pos;
    await writeMeta(s);
  }

  async function checkSpace(root, needed) {
    const st = await fs.statfs(root);
    if (st.bavail * st.bsize < needed) {
      const err = new Error("Not enough disk space");
      err.name = "QuotaExceededError";
      throw err;
    }
  }

  return {
    async open({ id, name, rel, size, subdir, resume }) {
      checkId(id);
      const live = open.get(id);
      if (live) return { offset: live.pos };
      const root = path.resolve(getRoot());
      await fs.mkdir(path.join(root, TEMP_DIR), { recursive: true });
      const s = { id, root, name: safeName(name), rel: safeRel(rel), subdir: subdir ? safeName(subdir) : "", durable: 0, pos: 0, sinceSync: 0 };
      if (resume) {
        const m = await readMeta(root, id);
        Object.assign(s, { name: safeName(m.name), rel: safeRel(m.rel), subdir: m.subdir ? safeName(m.subdir) : "" });
        s.handle = await fs.open(partPath(root, id), "r+");
        const { size: onDisk } = await s.handle.stat();
        s.durable = s.pos = Math.min(m.offset, onDisk);
        await s.handle.truncate(s.pos);
      } else {
        await checkSpace(root, size);
        s.handle = await fs.open(partPath(root, id), "w");
        await writeMeta(s);
      }
      open.set(id, s);
      return { offset: s.pos };
    },

    async write(id, data) {
      const s = open.get(id);
      if (!s) throw new Error("That file is no longer open");
      const buf = Buffer.from(data);
      await s.handle.write(buf, 0, buf.length, s.pos);
      s.pos += buf.length;
      s.sinceSync += buf.length;
      if (s.sinceSync >= SYNC_EVERY) {
        s.sinceSync = 0;
        await sync(s);
      }
    },

    async close(id) {
      const s = open.get(id);
      if (!s) throw new Error("That file is no longer open");
      await s.handle.sync();
      await s.handle.close();
      open.delete(id);
      const dir = path.join(s.root, s.subdir, s.rel);
      if (dir !== s.root && !inside(s.root, dir)) throw new Error("Refused an unsafe folder");
      await fs.mkdir(dir, { recursive: true });
      const final = await reserve(dir, s.name);
      await fs.rename(partPath(s.root, id), final); // replaces the empty file reserve() made
      await fs.rm(metaPath(s.root, id), { force: true });
      await afterSave(final);
      return final;
    },

    async abort(id) {
      checkId(id);
      const s = open.get(id);
      open.delete(id);
      await s?.handle.close().catch(() => {});
      const root = s?.root ?? path.resolve(getRoot());
      await fs.rm(partPath(root, id), { force: true });
      await fs.rm(metaPath(root, id), { force: true });
    },

    async offset(id) {
      checkId(id);
      try {
        return (await readMeta(path.resolve(getRoot()), id)).offset;
      } catch {
        return 0;
      }
    },

    // Partial files nobody came back for.
    async clean() {
      const dir = path.join(path.resolve(getRoot()), TEMP_DIR);
      const names = await fs.readdir(dir).catch(() => []);
      for (const n of names) {
        const p = path.join(dir, n);
        const st = await fs.stat(p).catch(() => null);
        if (st && Date.now() - st.mtimeMs > MAX_AGE && !open.has(n.split(".")[0])) await fs.rm(p, { force: true });
      }
    },
  };
}

// Every file under a folder, each with the path of its own folder relative to the one chosen, starting with that
// folder's name. Links are followed only when they stay inside.
async function walk(top) {
  const root = await fs.realpath(top);
  const base = path.basename(root);
  const out = [];
  async function visit(dir, rel) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      let target = full;
      if (e.isSymbolicLink()) {
        target = await fs.realpath(full).catch(() => "");
        if (!target || !inside(root, target)) continue;
      }
      const st = await fs.stat(target).catch(() => null);
      if (st?.isDirectory()) {
        if (!e.isSymbolicLink()) await visit(full, `${rel}/${e.name}`); // a link inside can't add anything new, only loops
      } else if (st?.isFile()) {
        out.push({ path: full, name: e.name, rel, size: st.size, mtime: Math.trunc(st.mtimeMs) });
      }
    }
  }
  await visit(root, base);
  return out;
}

async function read(file, start, end) {
  const h = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    const { bytesRead } = await h.read(buf, 0, buf.length, start);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
  } finally {
    await h.close();
  }
}

async function stat(file) {
  const st = await fs.stat(file).catch(() => null);
  return st?.isFile() ? { size: st.size, mtime: Math.trunc(st.mtimeMs) } : null;
}

module.exports = { safeName, safeRel, inside, createSinks, walk, read, stat };
