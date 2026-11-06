"use strict";
const path = require('node:path');
const { createSinks } = require('../files.js');
const { atomicJson } = require('../durable.js');
const [root, operation, boundary] = process.argv.slice(2);
const ID = 'A'.repeat(26);
const payload = Buffer.alloc(128 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = i * 17 % 251;
let stage = 'opening';
async function checkpoint(point) {
  if (stage !== operation || point !== boundary) return;
  process.send({ boundary: point });
  await new Promise(() => { setInterval(() => {}, 1000); });
}
(async () => {
  if (operation === 'json') {
    stage = 'json';
    await atomicJson(path.join(root, 'record.json'), { offset: 2 }, { checkpoint });
  } else {
    const sinks = createSinks(() => root, async () => {}, { checkpoint, syncEvery: operation === 'writing' ? payload.length : 1024 * 1024 });
    await sinks.open({ id: ID, name: 'received.bin', size: payload.length });
    stage = 'writing';
    await sinks.write(ID, payload);
    stage = 'finalizing';
    await sinks.close(ID);
  }
  process.send({ error: `Boundary not reached: ${operation}/${boundary}` });
})().catch((error) => { process.send({ error: error.stack }); process.exitCode = 1; });
