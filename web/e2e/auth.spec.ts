import { test, expect, chromium, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { startServer, stopServer } from "./server";
import { connected, dropChannel, forceMemorySink, pair, read, row, sha, spy, URL } from "./helpers";

test.beforeAll(() => startServer());
test.afterAll(stopServer);

const upload = (name: string, data: Buffer) => ({ name, mimeType: "application/octet-stream", buffer: data });
const verified = (p: Page) => expect(p.locator("#session")).toHaveAttribute("data-verified", "true");

async function device(init = "") {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.addInitScript(forceMemorySink);
  if (init) await ctx.addInitScript(init);
  return { page: await ctx.newPage(), close: () => browser.close() };
}

async function invite(p: Page) {
  await p.goto(URL);
  await p.click("#create");
  await expect(p.locator("#link")).not.toHaveValue("", { timeout: 15_000 });
  return p.locator("#link").inputValue();
}

const refused = (p: Page) => expect(p.locator("body")).toContainText("Couldn't verify the other device", { timeout: 20_000 });

test("a link verifies both devices, and its key never reaches the server", async () => {
  const frames: string[] = [];
  const a = await device(), b = await device();
  try {
    for (const d of [a, b]) {
      d.page.on("websocket", (ws) => {
        ws.on("framesent", (f) => frames.push(String(f.payload)));
        ws.on("framereceived", (f) => frames.push(String(f.payload)));
      });
    }
    const link = await invite(a.page);
    const key = link.split(".").at(-1)!;
    expect(key).toMatch(/^[A-Z2-7]{26}$/);
    await b.page.goto(link);
    await connected(a.page);
    await connected(b.page);
    await verified(a.page);
    await verified(b.page);
    expect(frames.some((f) => f.includes('"join"'))).toBe(true);
    expect(frames.filter((f) => f.includes(key))).toEqual([]);
  } finally {
    await a.close();
    await b.close();
  }
});

test("a link with the wrong key is refused on both devices and no file can be offered", async () => {
  const a = await device(), b = await device();
  try {
    const link = await invite(a.page);
    await b.page.goto(link.slice(0, link.lastIndexOf(".") + 1) + "A".repeat(26));
    await refused(a.page);
    await refused(b.page);
    await expect(b.page.locator("#dropzone")).toBeHidden();
  } finally {
    await a.close();
    await b.close();
  }
});

// What someone in the middle causes: each device sees a different certificate from the one the other holds.
// The real DTLS check still passes here, so only the proof can catch it.
const tamperFingerprint = `(() => {
  const d = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, "remoteDescription");
  Object.defineProperty(RTCPeerConnection.prototype, "remoteDescription", {
    get() {
      const r = d.get.call(this);
      return r && { type: r.type, sdp: r.sdp.replace(/(a=fingerprint:sha-256 )../g, "$1" + "00") };
    },
  });
})()`;

test("a tampered fingerprint fails the proof on both devices", async () => {
  const a = await device(), b = await device(tamperFingerprint);
  try {
    const link = await invite(a.page);
    await b.page.goto(link);
    await refused(a.page);
    await refused(b.page);
  } finally {
    await a.close();
    await b.close();
  }
});

test("a typed code works, unverified, in both directions", async () => {
  const a = await device(), b = await device();
  try {
    await invite(a.page);
    const code = await a.page.locator("#token").innerText();
    await b.page.goto(URL);
    await b.page.fill("#token-input", code);
    await b.page.locator("#join-form button[type=submit]").click();
    await connected(a.page);
    await connected(b.page);
    await expect(a.page.locator("#session")).toHaveAttribute("data-verified", "false");

    const data = randomBytes(300_000);
    const dl = b.page.waitForEvent("download");
    await a.page.setInputFiles("#files", upload("typed.bin", data));
    await row(b.page, "typed.bin").locator(".accept").click();
    expect(sha(await read(await dl))).toBe(sha(data));
  } finally {
    await a.close();
    await b.close();
  }
});

test("a verified pair proves itself again after a drop and after a reload", async () => {
  const { a, b, close } = await pair({ memory: true, withSpy: true });
  try {
    await dropChannel(a);
    await connected(a);
    await connected(b);
    await verified(a);
    await verified(b);

    await b.reload();
    await connected(a);
    await connected(b);
    await verified(b); // the key survived the reload

    await b.reload();
    await b.reload(); // a second reload before the proof finished must not lose it
    await connected(b);
    await verified(a);
    await verified(b);
  } finally {
    await close();
  }
});

test("a reconnect that fails its proof ends the session instead of trusting it", async () => {
  const a = await device(spy), b = await device(spy);
  try {
    const link = await invite(a.page);
    await b.page.goto(link);
    await connected(a.page);
    await connected(b.page);
    await b.page.evaluate(tamperFingerprint);
    await a.page.evaluate(() => (window as any).__dcs.forEach((dc: RTCDataChannel) => dc.close()));
    await expect(a.page.locator("#ended")).toContainText("Couldn't verify the other device", { timeout: 20_000 });
    await expect(b.page.locator("#ended")).toContainText("Couldn't verify the other device", { timeout: 20_000 });
    await expect(a.page.locator("#dropzone")).toBeHidden();
  } finally {
    await a.close();
    await b.close();
  }
});
