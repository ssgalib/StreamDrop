"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { constants } = require("node:fs");
const { atomicJson, syncDirectory, writeAll } = require("./durable.js");

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

function fitBytes(name, limit = NAME_BYTES) {
  if (Buffer.byteLength(name) <= limit) return name;
  const ext = path.extname(name).slice(0, 20);
  const chars = [...name.slice(0, name.length - ext.length)];
  while (Buffer.byteLength(chars.join("") + ext) > limit) chars.pop();
  return chars.join("") + ext;
}

function safeName(name, limit = NAME_BYTES) {
  const s = String(name).normalize("NFC").replace(CONTROL, "").replace(BIDI, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/, "")
    .replace(/^ +/, "");
  if (!s) return "file";
  return fitBytes(RESERVED.test(s) ? `_${s}` : s, limit);
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

function candidateName(name, i) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  return i ? `${stem} (${i})${ext}` : name;
}

// Received files go to <root>/.streamdrop/<id>.part, then move to their real name when complete. The sidecar
// records how much has reached the disk: after a crash, anything past that offset is not trusted.
function createSinks(getRoot, afterSave = async () => {}, { checkpoint = async () => {}, syncEvery = SYNC_EVERY } = {}) {
  const open = new Map();
  const partPath = (root, id) => path.join(root, TEMP_DIR, `${id}.part`);
  const metaPath = (root, id) => path.join(root, TEMP_DIR, `${id}.json`);

  function checkId(id) {
    if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("Bad transfer id");
  }

  async function writeMeta(s) {
    await atomicJson(metaPath(s.root, s.id), { name: s.name, rel: s.rel, subdir: s.subdir, offset: s.durable, ...(s.finalName && { finalName: s.finalName }), ...(s.published && { published: true }) }, {
      checkpoint: (phase) => checkpoint(`meta:${phase}`, s.id),
    });
  }

  async function readMeta(root, id) {
    const m = JSON.parse(await fs.readFile(metaPath(root, id), "utf8"));
    if (!Number.isSafeInteger(m.offset) || m.offset < 0) throw new Error("Bad record");
    return m;
  }

  async function sync(s) {
    await s.handle.sync();
    await checkpoint("data-synced", s.id);
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
    async open({ id, name, rel, size, subdir, resume, root: savedRoot }) {
      checkId(id);
      const live = open.get(id);
      if (live) return { offset: live.pos, root: live.root };
      const root = path.resolve(resume && typeof savedRoot === "string" ? savedRoot : getRoot());
      if (resume) {
        // A disconnected volume must not be replaced with a new empty directory on the system disk.
        const staging = await fs.lstat(path.join(root, TEMP_DIR));
        if (!staging.isDirectory() || staging.isSymbolicLink()) throw new Error("Refused a linked folder");
      } else {
        await fs.mkdir(root, { recursive: true });
        await checkedDirectory(root, TEMP_DIR);
      }
      const s = { id, root, name: safeName(name), rel: safeRel(rel), subdir: subdir ? safeName(subdir) : "", durable: 0, pos: 0, sinceSync: 0 };
      if (resume) {
        const m = await readMeta(root, id);
        Object.assign(s, { name: safeName(m.name), rel: safeRel(m.rel), subdir: m.subdir ? safeName(m.subdir) : "" });
        if (m.finalName) {
          if (typeof m.finalName !== "string" || path.basename(m.finalName) !== m.finalName || safeName(m.finalName, 255) !== m.finalName) throw new Error("Bad final file record");
          s.finalName = m.finalName;
          await checkedDirectory(root, path.join(s.subdir, s.rel));
        }
        try {
          s.handle = await fs.open(partPath(root, id), constants.O_RDWR | (constants.O_NOFOLLOW || 0));
        } catch (err) {
          if (err.code !== "ENOENT" || !s.finalName) throw err;
          const final = path.join(root, s.subdir, s.rel, s.finalName);
          const st = await fs.lstat(final);
          if (!st.isFile() || st.isSymbolicLink() || st.size !== m.offset) throw new Error("Completed file is missing or changed");
          s.published = true;
          s.durable = s.pos = m.offset;
          await writeMeta(s);
          open.set(id, s);
          return { offset: s.pos, root };
        }
        const { size: onDisk } = await s.handle.stat();
        s.durable = s.pos = Math.min(m.offset, onDisk);
        await s.handle.truncate(s.pos);
      } else {
        await checkSpace(root, size);
        try { s.handle = await fs.open(partPath(root, id), "wx", 0o600); }
        catch (err) {
          if (err.code !== "EEXIST") throw err;
          // A crash before acceptance can leave an empty/uncommitted part. No bytes were promised durable.
          let previous;
          try { previous = await readMeta(root, id); }
          catch (readError) { if (readError.code !== "ENOENT") throw readError; }
          if (previous?.offset > 0 || previous?.finalName) throw new Error("This file has unfinished progress. Resume it first.");
          const handle = await fs.open(partPath(root, id), constants.O_RDWR | (constants.O_NOFOLLOW || 0));
          try {
            const st = await handle.stat();
            if (!st.isFile() || st.nlink !== 1) throw new Error("Refused an unsafe partial file");
            await handle.truncate(0);
            s.handle = handle;
          } catch (error) { await handle.close(); throw error; }
        }
        await checkpoint("part-created", id);
        await writeMeta(s);
      }
      open.set(id, s);
      return { offset: s.pos, root };
    },

    async write(id, data) {
      const s = open.get(id);
      if (!s) throw new Error("That file is no longer open");
      if (s.published) throw new Error("That file is already complete");
      const buf = Buffer.from(data);
      await writeAll(s.handle, buf, s.pos);
      s.pos += buf.length;
      await checkpoint("data-written", id);
      s.sinceSync += buf.length;
      if (s.sinceSync >= syncEvery) {
        s.sinceSync = 0;
        await sync(s);
      }
    },

    async checkpoint(id) {
      const s = open.get(id);
      if (!s) throw new Error("That file is no longer open");
      if (s.handle) await sync(s);
    },

    async close(id) {
      const s = open.get(id);
      if (!s) throw new Error("That file is no longer open");
      if (s.handle) {
        await sync(s);
        await s.handle.close();
        s.handle = undefined;
      }
      const dir = path.join(s.root, s.subdir, s.rel);
      if (dir !== s.root && !inside(s.root, dir)) throw new Error("Refused an unsafe folder");
      await checkedDirectory(s.root, path.relative(s.root, dir));
      let final;
      if (!s.published) {
        for (let i = 0; i < 10000; i++) {
          const name = i === 0 && s.finalName ? s.finalName : candidateName(s.name, i);
          final = path.join(dir, name);
          if (!inside(s.root, final)) throw new Error("Refused an unsafe file name");
          s.finalName = name;
          await writeMeta(s);
          await checkpoint("publication-intent", id);
          try {
            // Publish the complete inode without replacing any existing file or leaving a reservation placeholder.
            await fs.link(partPath(s.root, id), final);
            break;
          } catch (err) {
            if (["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV", "ENOSYS"].includes(err.code)) {
              throw new Error("This folder can't safely finish the file. Choose another folder on this computer.");
            }
            if (err.code !== "EEXIST") throw err;
            const [part, existing] = await Promise.all([fs.stat(partPath(s.root, id)), fs.lstat(final)]);
            if (existing.isFile() && !existing.isSymbolicLink() && part.dev === existing.dev && part.ino === existing.ino) break;
            final = undefined;
          }
        }
        if (!final) throw new Error("Too many files with that name");
        await checkpoint("published", id);
      } else final = path.join(dir, s.finalName);
      await syncDirectory(dir);
      await checkpoint("destination-synced", id);
      s.published = true;
      await writeMeta(s);
      await checkpoint("completion-recorded", id);
      await afterSave(final);
      await fs.rm(partPath(s.root, id), { force: true });
      await checkpoint("part-removed", id);
      await syncDirectory(path.join(s.root, TEMP_DIR));
      await checkpoint("staging-synced", id);
      open.delete(id);
      return final;
    },

    async abort(id, savedRoot) {
      checkId(id);
      const s = open.get(id);
      open.delete(id);
      await s?.handle?.close().catch(() => {});
      const root = s?.root ?? path.resolve(savedRoot ?? getRoot());
      await fs.rm(partPath(root, id), { force: true });
      await fs.rm(metaPath(root, id), { force: true });
      await syncDirectory(path.join(root, TEMP_DIR)).catch((err) => { if (err.code !== "ENOENT") throw err; });
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
    async clean(retainedIds = []) {
      const retained = new Set(retainedIds.filter((id) => typeof id === "string" && ID_RE.test(id)));
      const dir = path.join(path.resolve(getRoot()), TEMP_DIR);
      const names = await fs.readdir(dir).catch(() => []);
      for (const n of names) {
        const p = path.join(dir, n);
        const st = await fs.stat(p).catch(() => null);
        const id = n.split(".")[0];
        if (st && Date.now() - st.mtimeMs > MAX_AGE && !open.has(id) && !retained.has(id)) await fs.rm(p, { force: true });
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
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start > 1024 * 1024) throw new Error("Invalid file range");
  const h = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    const { bytesRead } = await h.read(buf, 0, buf.length, start);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
  } finally {
    await h.close();
  }
}

// Reject existing symlink/junction components, including the private staging directory.
// A malicious local process racing directory replacement requires OS-specific handle-relative APIs.
async function checkedDirectory(root, rel) {
  if (!rel || rel === ".") return;
  let current = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!inside(root, current)) throw new Error("Refused an unsafe folder");
    await fs.mkdir(current).catch((err) => { if (err.code !== "EEXIST") throw err; });
    const st = await fs.lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Refused a linked folder");
  }
}

async function stat(file) {
  const st = await fs.stat(file).catch(() => null);
  return st?.isFile() ? { size: st.size, mtime: Math.trunc(st.mtimeMs) } : null;
}

module.exports = { safeName, safeRel, inside, createSinks, walk, read, stat };
