import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer } from "./server";

const URL = "http://localhost:5173";
const SIZE = 300 * 1024 * 1024 + 4321; // big enough to catch at 50%; not a multiple of any chunk size

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const work = mkdtempSync(join(tmpdir(), "sd-resume-"));
const file = join(work, "original.bin");
const other = join(work, "other.bin"); // same size, different bytes
let originalSha = "";

function sha(path: string) {
  return new Promise<string>((done, fail) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("end", () => done(h.digest("hex"))).on("error", fail);
  });
}

function writeRandom(path: string, size: number) {
  writeFileSync(path, "");
  for (let left = size; left > 0; left -= 32 * 1024 * 1024) appendFileSync(path, randomBytes(Math.min(left, 32 * 1024 * 1024)));
}

test.beforeAll(async () => {
  writeRandom(file, SIZE);
  writeRandom(other, SIZE);
  originalSha = await sha(file);
  await startServer();
});
test.afterAll(async () => {
  await stopServer();
  rmSync(work, { recursive: true, force: true });
});

// Records every data channel so a test can close one, which both pages see as a dropped connection.
const spy = `(() => {
  window.__dcs = [];
  const O = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) {
    const pc = new O(...a);
    const create = pc.createDataChannel.bind(pc);
    pc.createDataChannel = (...b) => { const dc = create(...b); window.__dcs.push(dc); return dc; };
    pc.addEventListener("datachannel", (e) => window.__dcs.push(e.channel));
    return pc;
  };
  window.RTCPeerConnection.prototype = O.prototype;
})()`;

type Pair = { tx: Page; rx: Page; txCtx: BrowserContext; rxCtx: BrowserContext; rxDir: string; close: () => Promise<void> };

// Persistent profiles: OPFS and localStorage must survive a reload, as in a real browser.
async function pair(): Promise<Pair> {
  const txDir = mkdtempSync(join(work, "tx-")), rxDir = mkdtempSync(join(work, "rx-"));
  const txCtx = await chromium.launchPersistentContext(txDir, { acceptDownloads: true });
  const rxCtx = await chromium.launchPersistentContext(rxDir, { acceptDownloads: true });
  await txCtx.addInitScript(spy);
  await rxCtx.addInitScript(spy);
  const tx = await txCtx.newPage(), rx = await rxCtx.newPage();
  await tx.goto(URL);
  await tx.click("#create");
  await tx.locator("#share").waitFor({ state: "visible" });
  await rx.goto(await tx.locator("#link").inputValue());
  await expect(tx.locator("#status")).toHaveText("Connected", { timeout: 20_000 });
  await expect(rx.locator("#status")).toHaveText("Connected", { timeout: 20_000 });
  return { tx, rx, txCtx, rxCtx, rxDir, close: async () => { await txCtx.close(); await rxCtx.close(); } };
}

const progress = (p: Page) => p.evaluate(() => { const e = document.querySelector<HTMLProgressElement>("#progress")!; return e.value / e.max; });
const reach = (p: Page, fraction: number) =>
  p.waitForFunction((f) => { const e = document.querySelector<HTMLProgressElement>("#progress")!; return e.value / e.max >= f; }, fraction, { timeout: 60_000 });
const dropChannel = (p: Page) => p.evaluate(() => (window as any).__dcs.forEach((dc: RTCDataChannel) => dc.close()));

async function startSending(tx: Page, rx: Page) {
  await tx.setInputFiles("#file", file);
  await rx.locator("#accept").click();
}

async function expectDownloadMatches(rx: Page, trigger: () => Promise<void>) {
  const download = rx.waitForEvent("download", { timeout: 120_000 });
  await trigger();
  expect(await sha(await (await download).path())).toBe(originalSha);
}

test("connection drops mid-transfer with both tabs open: resumes by itself", async () => {
  const { tx, rx, close } = await pair();
  try {
    await startSending(tx, rx);
    await reach(rx, 0.4);
    const before = await progress(rx);
    const download = rx.waitForEvent("download", { timeout: 120_000 });
    await dropChannel(tx);
    await expect(tx.locator("#status")).toHaveText(/Reconnecting|Resuming|Sending/, { timeout: 10_000 });
    expect(await sha(await (await download).path())).toBe(originalSha);
    await expect(tx.locator("#status")).toHaveText("Complete", { timeout: 30_000 });
    expect(before).toBeLessThan(0.95); // it really was interrupted mid-way
  } finally {
    await close();
  }
});

test("receiver reloads at 50% on OPFS parts: Resume continues, file identical", async () => {
  const { tx, rx, rxDir, close } = await pair();
  try {
    await startSending(tx, rx);
    await reach(rx, 0.5);
    await rx.reload();
    await expect(rx.locator("#unfinished")).toBeVisible();
    const shown = await rx.locator("#unfinished-pct").textContent();
    expect(shown).toMatch(/\d+% saved/);
    expect(parseInt(shown!.match(/\d+/)![0])).toBeGreaterThan(0); // closed 64 MiB parts survived the reload
    await expectDownloadMatches(rx, () => rx.locator("#resume").click());
    await expect(tx.locator("#status")).toHaveText("Complete", { timeout: 30_000 });
    expect(rxDir).toBeTruthy();
  } finally {
    await close();
  }
});

test("sender reloads at 50%: re-selecting the same file continues", async () => {
  const { tx, rx, close } = await pair();
  try {
    await startSending(tx, rx);
    await reach(rx, 0.5);
    await tx.reload();
    await expect(tx.locator("#unfinished")).toBeVisible();
    await expectDownloadMatches(rx, async () => {
      await tx.setInputFiles("#resume-file", file);
    });
    await expect(tx.locator("#status")).toHaveText("Complete", { timeout: 30_000 });
  } finally {
    await close();
  }
});

test("wrong file chosen on resume is refused, the right one still works", async () => {
  const { tx, rx, close } = await pair();
  try {
    await startSending(tx, rx);
    await reach(rx, 0.5);
    await tx.reload();
    await tx.setInputFiles("#resume-file", other);
    await expect(tx.locator("#error")).toHaveText("This isn't the same file.");
    await expect(tx.locator("#unfinished")).toBeVisible();
    await expectDownloadMatches(rx, async () => {
      await tx.setInputFiles("#resume-file", file);
    });
  } finally {
    await close();
  }
});

test("server restarts while both sides are paused: they reconnect and finish", async () => {
  const { tx, rx, close } = await pair();
  try {
    await startSending(tx, rx);
    await reach(rx, 0.4);
    await stopServer();
    await dropChannel(tx);
    await expect(rx.locator("#status")).toHaveText("Reconnecting…", { timeout: 10_000 });
    await expect(tx.locator("#status")).toHaveText("Reconnecting…", { timeout: 10_000 });
    await tx.waitForTimeout(3000); // stay paused across at least one failed retry
    await expectDownloadMatches(rx, () => startServer());
    await expect(tx.locator("#status")).toHaveText("Complete", { timeout: 30_000 });
  } finally {
    await close();
  }
});

test("Cancel while paused discards the partial file and returns to the start page", async () => {
  const { tx, rx, close } = await pair();
  try {
    await startSending(tx, rx);
    await reach(rx, 0.4);
    await stopServer();
    await dropChannel(tx);
    await expect(rx.locator("#status")).toHaveText("Reconnecting…", { timeout: 10_000 });
    await rx.locator("#cancel").click();
    await expect(rx.locator("#start")).toBeVisible();
    const left = await rx.evaluate(async () => { let n = 0; for await (const [name] of (await navigator.storage.getDirectory() as any).entries()) if (name.startsWith("resume-")) n++; return n; });
    expect(left).toBe(0);
    expect(await rx.evaluate(() => localStorage.getItem("streamdrop-transfer"))).toBeNull();
  } finally {
    await close();
    await startServer();
  }
});
