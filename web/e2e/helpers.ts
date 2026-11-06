import { chromium, expect, type BrowserContext, type Download, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const URL = "http://localhost:5173";
export const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export function shaFile(path: string) {
  return new Promise<string>((done, fail) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("end", () => done(h.digest("hex"))).on("error", fail);
  });
}

// Playwright can't operate the native save dialog, so force the memory sink for tests that don't need OPFS.
export const forceMemorySink = "delete window.showSaveFilePicker; Object.defineProperty(navigator, 'storage', { value: undefined });";

// Records every data channel so a test can close one, which both pages see as a dropped connection.
export const spy = `(() => {
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

export const dropChannel = (p: Page) => p.evaluate(() => (window as any).__dcs.forEach((dc: RTCDataChannel) => dc.close()));

export const row = (p: Page, name: string): Locator => p.locator(".item", { hasText: name });
export const connected = (p: Page) => expect(p.locator("#peer-state")).toHaveText("Connected to the other device", { timeout: 20_000 });

export async function read(download: Download) {
  const chunks: Buffer[] = [];
  for await (const c of await download.createReadStream()) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

// Two devices (separate browsers) connected through an invite link, ready to send either way.
export async function pair(opts: { persistent?: boolean; memory?: boolean; withSpy?: boolean } = {}) {
  const dirs: string[] = [];
  const open = async (): Promise<BrowserContext> => {
    const ctxOpts = { acceptDownloads: true };
    let ctx: BrowserContext;
    if (opts.persistent) {
      const dir = mkdtempSync(join(tmpdir(), "sd-profile-"));
      dirs.push(dir);
      ctx = await chromium.launchPersistentContext(dir, ctxOpts);
    } else {
      ctx = await (await chromium.launch()).newContext(ctxOpts);
    }
    if (opts.withSpy) await ctx.addInitScript(spy);
    if (opts.memory) await ctx.addInitScript(forceMemorySink);
    return ctx;
  };
  const ctxA = await open(), ctxB = await open();
  const a = await ctxA.newPage(), b = await ctxB.newPage();
  await a.goto(URL);
  await a.click("#create");
  await expect(a.locator("#link")).not.toHaveValue("", { timeout: 15_000 });
  await b.goto(await a.locator("#link").inputValue());
  await connected(a);
  await connected(b);
  return {
    a, b, ctxA, ctxB,
    close: async () => {
      for (const c of [ctxA, ctxB]) {
        const browser = c.browser();
        await c.close();
        await browser?.close();
      }
      dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    },
  };
}

export const progress = (p: Page) =>
  p.evaluate(() => { const e = document.querySelector<HTMLProgressElement>(".item progress:not([hidden])"); return e ? e.value / e.max : 0; });

export const reach = async (p: Page, fraction: number) => {
  try {
    await p.waitForFunction((f) => { const e = document.querySelector<HTMLProgressElement>(".item progress:not([hidden])"); return !!e && e.value / e.max >= f; }, fraction, { timeout: 90_000 });
  } catch (err) {
    console.error("Progress wait failed:", await p.locator("#activity").innerText(), await p.locator("#error").textContent());
    throw err;
  }
};

// Remembers every text #peer-state shows, so a test can prove a short-lived state ("Reconnecting…") happened.
export const watchPeerState = (p: Page) =>
  p.evaluate(() => {
    const w = window as any;
    w.__peerStates = [document.querySelector("#peer-state")!.textContent];
    new MutationObserver(() => w.__peerStates.push(document.querySelector("#peer-state")!.textContent))
      .observe(document.querySelector("#peer-state")!, { childList: true, characterData: true, subtree: true });
  });
export const peerStates = (p: Page) => p.evaluate(() => (window as any).__peerStates as string[]);
