import { test, expect, chromium, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { startServer, stopServer } from "./server";
import { connected, forceMemorySink, read, row, sha, URL } from "./helpers";

// A page from before version 2, still open in someone's browser. Needs a build of an old commit:
//   git archive 9967382 web | tar -x -C <dir>; ln -s $PWD/node_modules <dir>/web/; (cd <dir>/web && npx vite build)
//   OLD_DIST=<dir>/web/dist npm run test:e2e -- oldpage
const dist = process.env.OLD_DIST;
const OLD = "http://localhost:5174";
test.skip(!dist, "set OLD_DIST to a build of an old commit");

let preview: ChildProcess;
test.beforeAll(async () => {
  await startServer();
  preview = spawn("npx", ["vite", "preview", "--outDir", dist!, "--port", "5174", "--strictPort"], { stdio: "ignore", detached: true });
  for (let i = 0; i < 100; i++) {
    if (await fetch(OLD).then(() => true, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});
test.afterAll(async () => {
  process.kill(-preview.pid!);
  await stopServer();
});

async function device() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.addInitScript(forceMemorySink);
  return { page: await ctx.newPage(), close: () => browser.close() };
}

const upload = (name: string, data: Buffer) => ({ name, mimeType: "application/octet-stream", buffer: data });

async function sendBothWays(a: Page, b: Page) {
  for (const [from, to, name] of [[a, b, "one.bin"], [b, a, "two.bin"]] as const) {
    const data = randomBytes(2_000_000);
    const dl = to.waitForEvent("download");
    await from.setInputFiles("#files", upload(name, data));
    await row(to, name).locator(".accept").click();
    expect(sha(await read(await dl))).toBe(sha(data));
    await expect(row(from, name)).toContainText("Sent");
  }
}

test("an old page's link opened on a new page works both ways", async () => {
  const a = await device(), b = await device();
  try {
    await a.page.goto(OLD);
    await a.page.click("#create");
    await expect(a.page.locator("#link")).not.toHaveValue("", { timeout: 15_000 });
    const token = (await a.page.locator("#link").inputValue()).split("#")[1];
    await b.page.goto(`${URL}/#${token}`);
    await connected(a.page);
    await connected(b.page);
    await expect(b.page.locator("#session")).toHaveAttribute("data-verified", "false");
    await sendBothWays(a.page, b.page);
  } finally {
    await a.close();
    await b.close();
  }
});

test("a new page's code typed on an old page works both ways", async () => {
  const a = await device(), b = await device();
  try {
    await a.page.goto(URL);
    await a.page.click("#create");
    await expect(a.page.locator("#link")).not.toHaveValue("", { timeout: 15_000 });
    await b.page.goto(OLD);
    await b.page.fill("#token-input", await a.page.locator("#token").innerText());
    await b.page.locator("#join-form button[type=submit]").click();
    await connected(a.page);
    await connected(b.page);
    await expect(a.page.locator("#session")).toHaveAttribute("data-verified", "false");
    await sendBothWays(a.page, b.page);
  } finally {
    await a.close();
    await b.close();
  }
});

test("a new page's full link on an old page fails clearly", async () => {
  const a = await device(), b = await device();
  try {
    await a.page.goto(URL);
    await a.page.click("#create");
    await expect(a.page.locator("#link")).not.toHaveValue("", { timeout: 15_000 });
    await b.page.goto((await a.page.locator("#link").inputValue()).replace(URL, OLD));
    await expect(b.page.locator("body")).toContainText("That link isn't valid", { timeout: 15_000 });
  } finally {
    await a.close();
    await b.close();
  }
});
