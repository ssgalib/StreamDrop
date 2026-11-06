import { test, expect, chromium, firefox, webkit } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";

const engines = { chromium, firefox, webkit };
// Firefox hides local addresses behind mDNS names; with no STUN/TURN server the peers can't find each other.
const launchOptions = { firefoxUserPrefs: { "media.peerconnection.ice.obfuscate_host_addresses": false } };
type Engine = keyof typeof engines;
const URL = "http://localhost:5173";
// Playwright can't operate the native save dialog, so force the memory sink.
const forceMemorySink = "delete window.showSaveFilePicker; Object.defineProperty(navigator, 'storage', { value: undefined });";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function send(from: Engine, to: Engine, size: number) {
  const [sb, rb] = await Promise.all([engines[from].launch(launchOptions), engines[to].launch(launchOptions)]);
  try {
    const a = await (await sb.newContext()).newPage();
    const rctx = await rb.newContext({ acceptDownloads: true });
    await rctx.addInitScript(forceMemorySink);
    const r = await rctx.newPage();

    await a.goto(URL);
    await a.click("#create");
    await a.locator("#share").waitFor({ state: "visible" });
    await r.goto(await a.locator("#link").inputValue());
    await expect(a.locator("#status")).toHaveText("Connected", { timeout: 20_000 });
    await expect(r.locator("#status")).toHaveText("Connected", { timeout: 20_000 });

    const file = randomBytes(size);
    const download = r.waitForEvent("download");
    await a.setInputFiles("#file", { name: "generated.bin", mimeType: "application/octet-stream", buffer: file });
    await r.locator("#accept").click();
    const got = await (await download).createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of got) chunks.push(c as Buffer);
    expect(sha(Buffer.concat(chunks))).toBe(sha(file));
    await expect(a.locator("#status")).toHaveText("Complete", { timeout: 20_000 });
  } finally {
    await Promise.all([sb.close(), rb.close()]);
  }
}

const SIZE = 5 * 1024 * 1024 + 123; // not a multiple of the chunk size
// Playwright's Firefox gathers no ICE candidates here and WebKit needs system libraries,
// so other engines are opt-in: CROSS_BROWSER=1 npm run test:e2e
const pairs: [Engine, Engine][] = [["chromium", "chromium"]];
if (process.env.CROSS_BROWSER) {
  pairs.push(["firefox", "firefox"], ["webkit", "webkit"], ["chromium", "firefox"], ["firefox", "chromium"]);
}
for (const [from, to] of pairs) {
  test(`${from} -> ${to}: file arrives identical`, () => send(from, to, SIZE));
}
test("zero-byte file", () => send("chromium", "chromium", 0));
