import { test, expect, chromium, type Browser } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer } from "./server";

const URL = "http://localhost:5173";
const work = mkdtempSync(join(tmpdir(), "sd-stored-"));
const filesDir = join(work, "files");
// Playwright can't operate the native save dialog, so force the memory sink for downloads.
const forceMemorySink = "delete window.showSaveFilePicker; Object.defineProperty(navigator, 'storage', { value: undefined });";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test.beforeAll(() =>
  startServer({ STORE_GB: "1", STORE_KEY: "test-passcode", STORE_DIR: filesDir, STATE_DIRECTORY: work, STORE_FLOOR_GB: "1" }));
test.afterAll(async () => {
  await stopServer();
  rmSync(work, { recursive: true, force: true });
});

async function uploadAs(browser: Browser, name: string, data: Buffer, passcode = "test-passcode") {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(URL);
  await expect(page.locator("#stored")).toBeVisible();
  await page.click("#stored summary"); // the panel starts collapsed
  await page.fill("#store-key", passcode);
  await page.setInputFiles("#store-file", { name, mimeType: "application/octet-stream", buffer: data });
  await page.click("#store-upload");
  return { ctx, page };
}

async function download(browser: Browser, link: string) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.addInitScript(forceMemorySink);
  const page = await ctx.newPage();
  await page.goto(link);
  return { ctx, page };
}

for (const [label, size] of [["a file that isn't a multiple of 8 MiB", 20 * 1024 * 1024 + 123], ["a zero-byte file", 0], ["exactly one chunk", 8 * 1024 * 1024]] as const) {
  test(`upload, close the sender, download in a new browser: ${label}`, async () => {
    const browser = await chromium.launch();
    try {
      const data = randomBytes(size);
      const up = await uploadAs(browser, "plans.bin", data);
      await expect(up.page.locator("#store-result")).toBeVisible({ timeout: 60_000 });
      const link = await up.page.locator("#store-link").inputValue();
      expect(link).toMatch(/#s\/[A-Z2-7]{26}\.[A-Za-z0-9_-]{43}$/);
      await up.ctx.close(); // the sender leaves: the file must still be there

      const dl = await download(browser, link);
      await expect(dl.page.locator("#dl-name")).toHaveText("plans.bin");
      expect(dl.page.url()).not.toContain("#"); // the key is out of the address bar
      const event = dl.page.waitForEvent("download");
      await dl.page.click("#dl-button");
      const got = await (await event).createReadStream();
      const chunks: Buffer[] = [];
      for await (const c of got) chunks.push(c as Buffer);
      expect(sha(Buffer.concat(chunks))).toBe(sha(data));
      await expect(dl.page.locator("#status")).toHaveText("File saved");
      await dl.ctx.close();
    } finally {
      await browser.close();
    }
  });
}

test("the server stores only ciphertext: no plaintext and no file name on disk", async () => {
  const browser = await chromium.launch();
  try {
    const marker = "TOP-SECRET-MARKER-0123456789";
    const data = Buffer.from(marker.repeat(50_000)); // ~1.4 MB of an easy-to-spot string
    const up = await uploadAs(browser, "my-private-diary.txt", data);
    await expect(up.page.locator("#store-result")).toBeVisible({ timeout: 60_000 });
    const id = (await up.page.locator("#store-link").inputValue()).match(/#s\/([A-Z2-7]{26})\./)![1];
    const dir = join(filesDir, id);
    let scanned = 0;
    for (const f of readdirSync(dir)) {
      const bytes = readFileSync(join(dir, f));
      scanned += bytes.length;
      expect(bytes.includes(marker), `${f} contains plaintext`).toBe(false);
      expect(bytes.includes("my-private-diary"), `${f} contains the file name`).toBe(false);
    }
    expect(scanned).toBeGreaterThan(data.length); // the ciphertext really is there
    await up.ctx.close();
  } finally {
    await browser.close();
  }
});

test("a wrong passcode is refused and nothing is stored", async () => {
  const browser = await chromium.launch();
  try {
    const before = readdirSync(filesDir).length;
    const up = await uploadAs(browser, "x.bin", randomBytes(1000), "not-the-passcode");
    await expect(up.page.locator("#error")).toHaveText("Wrong passcode.");
    await expect(up.page.locator("#store-result")).toBeHidden();
    expect(readdirSync(filesDir).length).toBe(before);
    await up.ctx.close();
  } finally {
    await browser.close();
  }
});

test("deleting removes the file, and the link then says it is gone", async () => {
  const browser = await chromium.launch();
  try {
    const up = await uploadAs(browser, "gone.bin", randomBytes(5000));
    await expect(up.page.locator("#store-result")).toBeVisible({ timeout: 60_000 });
    const link = await up.page.locator("#store-link").inputValue();
    await up.page.click("#store-delete");
    await expect(up.page.locator("#status")).toHaveText("Deleted");
    const dl = await download(browser, link);
    await expect(dl.page.locator("#error")).toHaveText("This file is gone: it expired or was deleted.");
    await up.ctx.close();
    await dl.ctx.close();
  } finally {
    await browser.close();
  }
});

test("a chunk altered on the server is detected and nothing is saved", async () => {
  const browser = await chromium.launch();
  try {
    const up = await uploadAs(browser, "tamper.bin", randomBytes(20 * 1024 * 1024));
    await expect(up.page.locator("#store-result")).toBeVisible({ timeout: 60_000 });
    const link = await up.page.locator("#store-link").inputValue();
    const id = link.match(/#s\/([A-Z2-7]{26})\./)![1];
    const chunk = join(filesDir, id, "c1");
    const bytes = readFileSync(chunk);
    bytes[100] ^= 0xff;
    writeFileSync(chunk, bytes);

    const dl = await download(browser, link);
    let saved = false;
    dl.page.on("download", () => (saved = true));
    await dl.page.click("#dl-button");
    await expect(dl.page.locator("#error")).toContainText("altered or damaged");
    await expect(dl.page.locator("#status")).toHaveText("Not saved");
    expect(saved).toBe(false);
    await up.ctx.close();
    await dl.ctx.close();
  } finally {
    await browser.close();
  }
});

test("a link with a wrong key can't unlock the file", async () => {
  const browser = await chromium.launch();
  try {
    const up = await uploadAs(browser, "locked.bin", randomBytes(5000));
    await expect(up.page.locator("#store-result")).toBeVisible({ timeout: 60_000 });
    const link = await up.page.locator("#store-link").inputValue();
    const dl = await download(browser, link.replace(/\.[A-Za-z0-9_-]{43}$/, "." + "A".repeat(43)));
    await expect(dl.page.locator("#error")).toContainText("can't unlock the file");
    await expect(dl.page.locator("#dl-button")).toBeHidden();
    await up.ctx.close();
    await dl.ctx.close();
  } finally {
    await browser.close();
  }
});
