"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createSinks } = require('./files.js');
const { atomicJson } = require('./durable.js');
const ID = 'A'.repeat(26);
const payload = Buffer.alloc(128 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = i * 17 % 251;
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function crash(t, root, operation, boundary) {
  const child = fork(path.join(__dirname, 'fixtures/crash-worker.js'), [root, operation, boundary], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Missing boundary ${operation}/${boundary}: ${stderr}`)), 10000);
    child.once('error', (err) => { clearTimeout(timeout); reject(err); });
    child.once('message', (message) => {
      clearTimeout(timeout);
      if (message.error) reject(new Error(message.error));
      else resolve();
    });
    child.once('exit', (code, signal) => { clearTimeout(timeout); reject(new Error(`Worker exited early: ${code}/${signal}: ${stderr}`)); });
  });
  child.kill('SIGKILL');
  assert.equal((await exited).signal, 'SIGKILL');
}

async function tmp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-crash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

for (const boundary of ['written', 'file-synced', 'renamed', 'directory-synced']) {
  test(`JSON commit survives SIGKILL after ${boundary}`, async (t) => {
    const root = await tmp(t), file = path.join(root, 'record.json');
    await atomicJson(file, { offset: 1 });
    await crash(t, root, 'json', boundary);
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(value, { offset: boundary === 'written' || boundary === 'file-synced' ? 1 : 2 });
  });
}

const cases = [
  ['opening', 'part-created'],
  ...['written', 'file-synced', 'renamed', 'directory-synced'].map((phase) => ['opening', `meta:${phase}`]),
  ...['data-written', 'data-synced', 'meta:written', 'meta:file-synced', 'meta:renamed', 'meta:directory-synced'].map((phase) => ['writing', phase]),
  ...['publication-intent', 'published', 'destination-synced', 'completion-recorded', 'part-removed', 'staging-synced'].map((phase) => ['finalizing', phase]),
];
for (const [operation, boundary] of cases) {
  test(`file recovery after SIGKILL at ${operation}/${boundary} yields one intact destination`, async (t) => {
    const root = await tmp(t);
    await crash(t, root, operation, boundary);
    let metadata;
    try { metadata = JSON.parse(await fs.readFile(path.join(root, '.streamdrop', `${ID}.json`), 'utf8')); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const sinks = createSinks(() => root);
    const { offset } = await sinks.open({ id: ID, name: 'received.bin', size: payload.length, resume: !!metadata });
    const committed = operation === 'finalizing' || operation === 'writing' && ['meta:renamed', 'meta:directory-synced'].includes(boundary);
    assert.equal(offset, committed ? payload.length : 0, 'only the recorded durable prefix is reused');
    if (offset < payload.length) await sinks.write(ID, payload.subarray(offset));
    const final = await sinks.close(ID);
    assert.equal(sha(await fs.readFile(final)), sha(payload));
    assert.deepEqual((await fs.readdir(root)).filter((name) => name !== '.streamdrop'), ['received.bin']);
    await assert.rejects(fs.stat(path.join(root, '.streamdrop', `${ID}.part`)), { code: 'ENOENT' });
  });
}

for (const boundary of ['publication-intent', 'published', 'part-removed']) {
  test(`publication crash at ${boundary} never overwrites an existing file`, async (t) => {
    const root = await tmp(t);
    const original = path.join(root, 'received.bin');
    await fs.writeFile(original, 'precious original');
    await crash(t, root, 'finalizing', boundary);
    const sinks = createSinks(() => root);
    const { offset } = await sinks.open({ id: ID, name: 'received.bin', size: payload.length, resume: true });
    assert.equal(offset, payload.length);
    const final = await sinks.close(ID);
    assert.equal(path.basename(final), 'received (1).bin');
    assert.equal(sha(await fs.readFile(final)), sha(payload));
    assert.equal(await fs.readFile(original, 'utf8'), 'precious original');
    assert.deepEqual((await fs.readdir(root)).filter((n) => n !== '.streamdrop').sort(), ['received (1).bin', 'received.bin']);
  });
}
