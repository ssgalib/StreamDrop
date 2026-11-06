import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer } from "./server";
import { connected, dropChannel, forceMemorySink, pair, peerStates, read, row, sha, URL, watchPeerState } from "./helpers";

test.beforeAll(() => startServer());
test.afterAll(stopServer);

const upload = (name: string, data: Buffer) => ({ name, mimeType: "application/octet-stream", buffer: data });

test("two devices connect through a link and show the same screen", async () => {
  const { a, b, close } = await pair({ memory: true });
  try {
    for (const p of [a, b]) {
      await expect(p.locator("#dropzone")).toBeVisible();
      await expect(p.locator("#activity .item")).toHaveCount(0);
      await expect(p.locator("#home")).toBeHidden();
    }
    expect(b.url()).not.toContain("#"); // the secret is out of the address bar
  } finally {
    await close();
  }
});

test("the device that created the room can send, and the joiner can send back", async () => {
  const { a, b, close } = await pair({ memory: true });
  try {
    const one = randomBytes(5 * 1024 * 1024 + 123);
    const downloadB = b.waitForEvent("download");
    await a.setInputFiles("#files", upload("from-creator.bin", one));
    await expect(row(a, "from-creator.bin")).toContainText("Waiting for the other device to accept");
    await expect(row(b, "from-creator.bin")).toContainText("Wants to send you this file");
    await row(b, "from-creator.bin").locator(".accept").click();
    expect(sha(await read(await downloadB))).toBe(sha(one));
    await expect(row(a, "from-creator.bin")).toContainText("Sent");
    await expect(row(b, "from-creator.bin")).toContainText("Received");

    // and now the joiner sends, over the same connection
    const two = randomBytes(1_000_001);
    const downloadA = a.waitForEvent("download");
    await b.setInputFiles("#files", upload("from-joiner.bin", two));
    await row(a, "from-joiner.bin").locator(".accept").click();
    expect(sha(await read(await downloadA))).toBe(sha(two));
    await expect(row(b, "from-joiner.bin")).toContainText("Sent");
  } finally {
    await close();
  }
});

test("a zero-byte file goes through", async () => {
  const { a, b, close } = await pair({ memory: true });
  try {
    const dl = b.waitForEvent("download");
    await a.setInputFiles("#files", upload("empty.bin", Buffer.alloc(0)));
    await row(b, "empty.bin").locator(".accept").click();
    expect((await read(await dl)).length).toBe(0);
    await expect(row(a, "empty.bin")).toContainText("Sent");
  } finally {
    await close();
  }
});

test("both devices send at the same time and every file arrives intact", async () => {
  const { a, b, close } = await pair({ memory: true });
  try {
    const fromA = randomBytes(8 * 1024 * 1024 + 5), fromB = randomBytes(6 * 1024 * 1024 + 9);
    const dlB = b.waitForEvent("download"), dlA = a.waitForEvent("download");
    await Promise.all([a.setInputFiles("#files", upload("a-to-b.bin", fromA)), b.setInputFiles("#files", upload("b-to-a.bin", fromB))]);
    await row(b, "a-to-b.bin").locator(".accept").waitFor();
    await row(a, "b-to-a.bin").locator(".accept").waitFor();
    await Promise.all([row(b, "a-to-b.bin").locator(".accept").click(), row(a, "b-to-a.bin").locator(".accept").click()]);
    expect(sha(await read(await dlB))).toBe(sha(fromA));
    expect(sha(await read(await dlA))).toBe(sha(fromB));
  } finally {
    await close();
  }
});

test("several files at once: Accept all takes every one, in order, intact", async () => {
  const { a, b, close } = await pair({ memory: true });
  try {
    const files = [3, 1, 2].map((n, i) => upload(`batch-${i}.bin`, randomBytes(n * 700_000 + i)));
    const downloads: Promise<Buffer>[] = [];
    b.on("download", (d) => downloads.push(read(d)));
    await a.setInputFiles("#files", files);
    await expect(b.locator("#bulk")).toBeVisible();
    await expect(b.locator("#bulk-text")).toHaveText("3 files are waiting for you");
    await b.click("#accept-all");
    await expect(a.locator(".item", { hasText: "Sent" })).toHaveCount(3, { timeout: 30_000 });
    await expect(b.locator(".item", { hasText: "Received" })).toHaveCount(3);
    const got = (await Promise.all(downloads)).map(sha).sort();
    expect(got).toEqual(files.map((f) => sha(f.buffer)).sort());
    await expect(b.locator("#bulk")).toBeHidden();
  } finally {
    await close();
  }
});

test("declining one of several files leaves the rest alone", async () => {
  const { a, b, close } = await pair({ memory: true });
  try {
    await a.setInputFiles("#files", [upload("keep.bin", randomBytes(1000)), upload("refuse.bin", randomBytes(1000))]);
    await row(b, "refuse.bin").locator(".decline").click();
    await row(b, "keep.bin").locator(".accept").click();
    await expect(row(a, "refuse.bin")).toContainText("Declined");
    await expect(row(a, "keep.bin")).toContainText("Sent");
  } finally {
    await close();
  }
});

test("cancelling while a file is on its way stops it on both devices and saves nothing", async () => {
  const { a, b, close } = await pair({ memory: true });
  try {
    let saved = false;
    b.on("download", () => (saved = true));
    // Playwright won't take an in-memory upload over 50 MB, so this one comes from a file
    const dir = mkdtempSync(join(tmpdir(), "sd-big-"));
    const big = join(dir, "big.bin");
    writeFileSync(big, Buffer.alloc(120 * 1024 * 1024));
    await a.setInputFiles("#files", big);
    await row(b, "big.bin").locator(".accept").click();
    await row(b, "big.bin").locator("progress:not([hidden])").waitFor();
    await row(b, "big.bin").locator(".cancel").click();
    await expect(row(b, "big.bin")).toContainText("Cancelled");
    await expect(row(a, "big.bin")).toContainText("Cancelled");
    await b.waitForTimeout(500);
    expect(saved).toBe(false);
    await expect(b.locator("#clear")).toBeVisible();
    await b.click("#clear");
    await expect(b.locator("#activity .item")).toHaveCount(0);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    await close();
  }
});

test("dropping files onto the page offers them", async () => {
  const { a, b, close } = await pair({ memory: true });
  try {
    await a.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(2000)], "dropped.bin"));
      document.querySelector("#session")!.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(row(b, "dropped.bin")).toContainText("Wants to send you this file");
  } finally {
    await close();
  }
});

test("Disconnect on one device tells the other, which keeps its history", async () => {
  const { a, b, close } = await pair({ memory: true });
  try {
    const dl = b.waitForEvent("download");
    await a.setInputFiles("#files", upload("before.bin", randomBytes(3000)));
    await row(b, "before.bin").locator(".accept").click();
    await dl;
    await a.click("#leave");
    await expect(a.locator("#home")).toBeVisible();
    await expect(b.locator("#ended")).toBeVisible();
    await expect(b.locator("#ended-text")).toHaveText("The other device disconnected.");
    await expect(b.locator("#dropzone")).toBeHidden();
    await expect(row(b, "before.bin")).toContainText("Received"); // the history is still there
    await b.click("#restart");
    await expect(b.locator("#home")).toBeVisible();
  } finally {
    await close();
  }
});

test("a link that was already used is refused", async () => {
  const { a, b, close } = await pair({ memory: true });
  try {
    const link = await a.evaluate(() => (document.querySelector("#link") as HTMLTextAreaElement).value);
    const third = await b.context().browser()!.newPage();
    await third.goto(link);
    await expect(third.locator("#error")).toHaveText("This link has already been used.");
    await expect(third.locator("#home")).toBeVisible();
    await third.close();
  } finally {
    await close();
  }
});

test("a made-up code shows a readable error and the form still works", async () => {
  const { a, close } = await pair({ memory: true });
  try {
    const page = await a.context().browser()!.newPage();
    await page.goto(URL);
    await page.fill("#token-input", "not-a-real-code");
    await page.click("#join-form button");
    await expect(page.locator("#error")).toHaveText("That link isn't valid. Ask the sender for a new one.");
    await expect(page.locator("#home")).toBeVisible();
    await expect(page.locator("#join-form")).toBeVisible();
    await page.close();
  } finally {
    await close();
  }
});

// A phone freezes the tab (and drops its connections) while you pick a file in the Files app. Nothing is
// moving at that moment, so the connection must come back by itself instead of giving up.
test("an idle connection that drops reconnects by itself, and sending still works after", async () => {
  const { a, b, close } = await pair({ memory: true, withSpy: true });
  try {
    await watchPeerState(a);
    await watchPeerState(b);
    await dropChannel(a); // nothing is being sent
    for (const p of [a, b]) {
      await expect.poll(async () => (await peerStates(p)).includes("Reconnecting…"), { timeout: 15_000 }).toBe(true);
      await connected(p);
      await expect(p.locator("#ended")).toBeHidden();
    }
    const data = randomBytes(2_000_000);
    const dl = b.waitForEvent("download");
    await a.setInputFiles("#files", upload("after-reconnect.bin", data));
    await row(b, "after-reconnect.bin").locator(".accept").click();
    expect(sha(await read(await dl))).toBe(sha(data));
  } finally {
    await close();
  }
});

test("a tab that is killed and reopened while idle rejoins by itself", async () => {
  const { a, b, close } = await pair({ memory: true });
  try {
    await a.reload(); // what a phone does to a tab you left for the Files app
    await connected(a);
    await connected(b);
    await expect(a.locator("#home")).toBeHidden();
    const data = randomBytes(1_500_000);
    const dl = a.waitForEvent("download");
    await b.setInputFiles("#files", upload("back-to-a.bin", data));
    await row(a, "back-to-a.bin").locator(".accept").click();
    expect(sha(await read(await dl))).toBe(sha(data));
  } finally {
    await close();
  }
});

test("Disconnect is understood at once: the other device doesn't wait to see if you come back", async () => {
  const { a, b, close } = await pair({ memory: true });
  try {
    await a.click("#leave");
    await expect(b.locator("#ended")).toBeVisible({ timeout: 3000 });
    await expect(b.locator("#ended-text")).toHaveText("The other device disconnected.");
    await b.reload(); // and it does not try to rejoin after a reload either
    await expect(b.locator("#home")).toBeVisible();
    await expect(b.locator("#session")).toBeHidden();
  } finally {
    await close();
  }
});

test("if the other device never comes back, waiting stops after a few minutes", async () => {
  const { a, b, ctxA, close } = await pair({ memory: true });
  try {
    await b.context().clock.install();
    await ctxA.close(); // the other device is just gone, with no goodbye
    await expect(b.locator("#peer-state")).toHaveText("Reconnecting…", { timeout: 15_000 });
    await b.clock.fastForward("06:00");
    await expect(b.locator("#ended")).toBeVisible({ timeout: 10_000 });
    await expect(b.locator("#ended-text")).toHaveText("The other device didn't come back.");
  } finally {
    await close().catch(() => {});
  }
});
