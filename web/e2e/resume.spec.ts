import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer } from "./server";
import { dropChannel, pair, peerStates, reach, row, shaFile, watchPeerState } from "./helpers";

const SIZE = 300 * 1024 * 1024 + 4321; // big enough to catch at 50%; not a multiple of any chunk size

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const work = mkdtempSync(join(tmpdir(), "sd-resume-"));
const file = join(work, "original.bin");
const other = join(work, "other.bin"); // same size, different bytes
let originalSha = "";

function writeRandom(path: string, size: number) {
  writeFileSync(path, "");
  for (let left = size; left > 0; left -= 32 * 1024 * 1024) appendFileSync(path, randomBytes(Math.min(left, 32 * 1024 * 1024)));
}

test.beforeAll(async () => {
  writeRandom(file, SIZE);
  writeRandom(other, SIZE);
  originalSha = await shaFile(file);
  await startServer();
});
test.afterAll(async () => {
  await stopServer();
  rmSync(work, { recursive: true, force: true });
});

// Persistent profiles: OPFS and localStorage must survive a reload, as in a real browser.
const resumable = () => pair({ persistent: true, withSpy: true });
const NAME = "original.bin";

async function start(a: Page, b: Page) {
  await a.setInputFiles("#files", file);
  await row(b, NAME).locator(".accept").click();
}

async function expectDownloadMatches(b: Page, trigger: () => Promise<void>, a?: Page) {
  const download = b.waitForEvent("download", { timeout: 120_000 });
  await trigger();
  try {
    expect(await shaFile(await (await download).path())).toBe(originalSha);
  } catch (err) {
    for (const [name, p] of [["receiver", b], ["sender", a]] as const) {
      if (p) console.error(name, await p.locator("#peer-state").textContent(), await p.locator("#activity").innerText(), await p.locator("#error").textContent());
    }
    throw err;
  }
}

test("connection drops mid-transfer with both tabs open: resumes by itself", async () => {
  const { a, b, close } = await resumable();
  try {
    await watchPeerState(a);
    await watchPeerState(b);
    await start(a, b);
    await reach(b, 0.4);
    await expectDownloadMatches(b, () => dropChannel(a));
    await expect(row(a, NAME)).toContainText("Sent", { timeout: 30_000 });
    // both devices really did go through "Reconnecting…" and came back
    for (const p of [a, b]) {
      const states = await peerStates(p);
      expect(states).toContain("Reconnecting…");
      expect(states.at(-1)).toBe("Connected to the other device");
    }
  } finally {
    await close();
  }
});

test("receiver reloads at 50% on OPFS parts: Resume continues, file identical", async () => {
  const { a, b, close } = await resumable();
  try {
    await start(a, b);
    await reach(b, 0.5);
    await b.reload();
    await expect(b.locator("#unfinished")).toBeVisible();
    const shown = (await b.locator("#unfinished-list").textContent())!;
    expect(shown).toContain(NAME);
    const pct = parseInt(shown.match(/(\d+)% saved/)![1]);
    expect(pct).toBeGreaterThan(0); // closed 64 MiB parts survived the reload
    await expectDownloadMatches(b, () => b.locator("#resume").click(), a);
    await expect(row(a, NAME)).toContainText("Sent", { timeout: 30_000 });
    await expect(b.locator("#unfinished")).toBeHidden();
  } finally {
    await close();
  }
});

test("sender reloads at 50%: choosing the same file continues", async () => {
  const { a, b, close } = await resumable();
  try {
    await start(a, b);
    await reach(b, 0.5);
    await a.reload();
    await expect(a.locator("#unfinished")).toBeVisible();
    await expect(a.locator("#unfinished-send")).toBeVisible();
    await expectDownloadMatches(b, () => a.setInputFiles("#resume-files", file));
    await expect(row(a, NAME)).toContainText("Sent", { timeout: 30_000 });
  } finally {
    await close();
  }
});

test("a different file chosen on resume is refused, the right one still works", async () => {
  const { a, b, close } = await resumable();
  try {
    await start(a, b);
    await reach(b, 0.5);
    await a.reload();
    await a.setInputFiles("#resume-files", other);
    await expect(a.locator("#error")).toHaveText("Not the same file: other.bin");
    await expect(a.locator("#unfinished")).toBeVisible();
    await expectDownloadMatches(b, () => a.setInputFiles("#resume-files", file));
  } finally {
    await close();
  }
});

test("server restarts while both sides are paused: they reconnect and finish", async () => {
  const { a, b, close } = await resumable();
  try {
    await start(a, b);
    await reach(b, 0.4);
    await stopServer();
    await dropChannel(a);
    await expect(b.locator("#peer-state")).toHaveText("Reconnecting…", { timeout: 10_000 });
    await expect(a.locator("#peer-state")).toHaveText("Reconnecting…", { timeout: 10_000 });
    await a.waitForTimeout(3000); // stay paused across at least one failed retry
    await expectDownloadMatches(b, () => startServer());
    await expect(row(a, NAME)).toContainText("Sent", { timeout: 30_000 });
  } finally {
    await close();
  }
});

test("Disconnect while paused discards the partial file and returns to the start page", async () => {
  const { a, b, close } = await resumable();
  try {
    await start(a, b);
    await reach(b, 0.4);
    await stopServer();
    await dropChannel(a);
    await expect(b.locator("#peer-state")).toHaveText("Reconnecting…", { timeout: 10_000 });
    await b.click("#leave");
    await expect(b.locator("#disconnect-choice")).toBeVisible();
    await b.click("#discard-unfinished");
    await expect(b.locator("#home")).toBeVisible();
    // discarding is asynchronous, so wait for the partial file to go rather than looking at one instant
    await expect.poll(() => b.evaluate(async () => {
      let n = 0;
      for await (const [name] of (await navigator.storage.getDirectory() as any).entries()) if (name.startsWith("resume-")) n++;
      return n;
    }), { timeout: 10_000 }).toBe(0);
    expect(await b.evaluate(() => localStorage.getItem("streamdrop-session"))).toBeNull();
  } finally {
    await close();
    await startServer();
  }
});

test('Keep unfinished preserves browser progress and resumes without choosing the files again', async () => {
  const { a, b, close } = await resumable();
  try {
    await start(a, b);
    await reach(b, 0.35);
    await b.click('#leave');
    await expect(b.locator('#disconnect-choice')).toBeVisible();
    await b.click('#stay-connected');
    await expect(b.locator('#disconnect-choice')).not.toBeVisible();
    await b.click('#leave');
    await b.click('#keep-unfinished');
    await expect(b.locator('#resume-kept')).toBeVisible();
    await expect(a.locator('#resume-kept')).toBeVisible();
    await expect(row(b, NAME)).toContainText('Kept for later');
    expect(await b.evaluate(() => JSON.parse(localStorage.getItem('streamdrop-session')!).held)).toBe(true);
    await expectDownloadMatches(b, async () => {
      await b.click('#resume-kept');
      await a.click('#resume-kept');
    }, a);
    await expect(row(a, NAME)).toContainText('Sent');
  } finally { await close(); }
});
