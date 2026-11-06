const { test, expect, _electron: electron, chromium } = require("@playwright/test");
const { execFileSync, spawn } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const bin = path.join(os.tmpdir(), `sd-e2e-server-${process.pid}`);
const PORT = 18090;
const SIGNAL = `ws://127.0.0.1:${PORT}/ws`;
let server;

const startServer = async () => {
  server = spawn(bin, ["-addr", `127.0.0.1:${PORT}`], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
};

test.beforeAll(async () => {
  execFileSync("go", ["build", "-o", bin, "."], { cwd: path.join(root, "..", "server") });
  await startServer();
});
test.afterAll(() => {
  server.kill();
  fs.rmSync(bin, { force: true });
});

const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const shaOf = (b) => createHash("sha256").update(b).digest("hex");

const made = [];
function dirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sd-app-"));
  made.push(base);
  return { base, data: path.join(base, "data"), home: path.join(base, "home") };
}
test.afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// One running app. Restarting keeps its data folder, as a real restart would.
async function launch(d, extra = {}) {
  fs.mkdirSync(d.data, { recursive: true });
  fs.mkdirSync(d.home, { recursive: true });
  const downloads = path.join(d.home, "received");
  fs.writeFileSync(path.join(d.data, "settings.json"), JSON.stringify({ downloads }));
  const electronApp = await electron.launch({
    args: [root],
    env: {
      ...process.env, HOME: d.home, XDG_CONFIG_HOME: path.join(d.home, ".config"), STREAMDROP_USER_DATA: d.data, STREAMDROP_SIGNAL: SIGNAL,
      STREAMDROP_ORIGIN: "http://invite.test", STREAMDROP_HIDDEN: "1", STREAMDROP_NO_TRAY: "1", STREAMDROP_TEST_PLAIN_STORE: "1", ...extra,
    },
  });
  const page = await electronApp.firstWindow();
  await page.waitForSelector("#create");
  return { electronApp, page, d, downloads };
}

// The placeholder text in the page also says "Connected", so the screen must be showing too.
const connected = async (p) => {
  await expect(p.locator("#session")).toBeVisible({ timeout: 30_000 });
  await expect(p.locator("#peer-state")).toHaveText(/^Connected to /, { timeout: 30_000 });
};
const row = (p, name) => p.locator(".item", { hasText: name });

async function pairByLink(a, b) {
  await a.page.click("#create");
  await expect(a.page.locator("#link")).not.toHaveValue("", { timeout: 15_000 });
  await b.page.fill("#token-input", await a.page.locator("#link").inputValue());
  await b.page.locator("#join-form button[type=submit]").click();
  await connected(a.page);
  await connected(b.page);
}

async function save(a, b) {
  await a.page.click("#save-device");
  await b.page.click("#save-device");
  await expect(a.page.locator("#save-offer")).toBeHidden({ timeout: 10_000 });
  await expect(b.page.locator("#save-offer")).toBeHidden({ timeout: 10_000 });
  for (const x of [a, b]) await expect.poll(() => devices(x)).toHaveLength(1);
}

const devices = (x) => JSON.parse(fs.existsSync(path.join(x.d.data, "devices.json")) ? fs.readFileSync(path.join(x.d.data, "devices.json")) : "[]");

async function sendFile(from, to, name, data) {
  const f = path.join(from.d.base, name);
  fs.writeFileSync(f, data);
  await from.page.setInputFiles("#files", f);
  await row(to.page, name).locator(".accept").click();
  await expect(row(from.page, name)).toContainText("Sent", { timeout: 60_000 });
  await expect(row(to.page, name)).toContainText("Received", { timeout: 60_000 });
  return path.join(to.downloads, name);
}

test("the app connects to the real server from its own origin, and files go both ways to disk", async () => {
  const a = await launch(dirs()), b = await launch(dirs());
  try {
    await pairByLink(a, b);
    expect(await a.page.locator("#link").inputValue()).toMatch(/^http:\/\/invite\.test\/#[A-Z2-7]{26}\.[A-Z2-7]{26}$/);
    await expect(a.page.locator("#session")).toHaveAttribute("data-verified", "true");
    const one = randomBytes(5_000_123), two = randomBytes(77);
    expect(sha(await sendFile(a, b, "one.bin", one))).toBe(shaOf(one));
    expect(sha(await sendFile(b, a, "two.bin", two))).toBe(shaOf(two));
  } finally {
    await a.electronApp.close();
    await b.electronApp.close();
  }
});

test("the page is locked down: no Node, a strict policy, and nothing else may be loaded", async () => {
  const a = await launch(dirs());
  try {
    expect(await a.page.evaluate(() => typeof require + typeof process)).toBe("undefinedundefined");
    const url = await a.page.evaluate(() => location.href);
    expect(url).toBe("app://streamdrop/");
    const blocked = await a.page.evaluate(() => fetch("https://example.com").then(() => false, () => true));
    expect(blocked).toBe(true);
    const status = (url) => a.electronApp.evaluate(async ({ net }, u) => (await net.fetch(u)).status, url);
    expect(await status("app://streamdrop/index.html")).toBe(200); // so the next two mean something
    expect(await status("app://streamdrop/..%2f..%2fpackage.json")).toBe(404);
    expect(await status("app://elsewhere/index.html")).toBe(404);
  } finally {
    await a.electronApp.close();
  }
});

test("saved devices find each other after both restart, with no link", async () => {
  const da = dirs(), db = dirs();
  let a = await launch(da), b = await launch(db);
  try {
    await pairByLink(a, b);
    await save(a, b);
    expect(devices(a)[0].roomId).toBe(devices(b)[0].roomId);
    expect(devices(a)[0].name).toBe(os.hostname());
    await a.electronApp.close();
    await b.electronApp.close();

    a = await launch(da);
    b = await launch(db);
    await expect(a.page.locator(".device")).toHaveCount(1);
    await a.page.locator(".device-connect").click();
    await connected(a.page); // b was rung and came by itself
    await connected(b.page);
    await expect(a.page.locator("#session")).toHaveAttribute("data-verified", "true");
    const data = randomBytes(1_000_000);
    expect(sha(await sendFile(a, b, "later.bin", data))).toBe(shaOf(data));
  } finally {
    await a.electronApp.close();
    await b.electronApp.close();
  }
});

test("calling a device that is off waits, and it connects when that device starts", async () => {
  const da = dirs(), db = dirs();
  let a = await launch(da), b = await launch(db);
  try {
    await pairByLink(a, b);
    await save(a, b);
    await b.electronApp.close();
    await a.electronApp.close();

    a = await launch(da);
    await a.page.locator(".device-connect").click();
    await expect(a.page.locator("#peer-state")).toContainText("to open StreamDrop", { timeout: 15_000 });
    b = await launch(db); // its listener finds the waiting room
    await connected(a.page);
    await connected(b.page);
  } finally {
    await a.electronApp.close();
    await b.electronApp.close();
  }
});

test("a device whose key no longer matches is refused", async () => {
  const da = dirs(), db = dirs();
  let a = await launch(da), b = await launch(db);
  try {
    await pairByLink(a, b);
    await save(a, b);
    await a.electronApp.close();
    await b.electronApp.close();

    // the same room id with a different key: what someone who only learned the id would have
    const list = devices({ d: db });
    list[0].k = randomBytes(32).toString("base64");
    fs.writeFileSync(path.join(db.data, "devices.json"), JSON.stringify(list));
    a = await launch(da);
    b = await launch(db);
    await a.page.locator(".device-connect").click();
    await expect(a.page.locator("#ended")).toContainText("Couldn't verify", { timeout: 30_000 });
    await expect(a.page.locator("#dropzone")).toBeHidden();
  } finally {
    await a.electronApp.close();
    await b.electronApp.close();
  }
});

test("a hostile name from the other device stays in the folder, and always accept writes to the device's folder", async () => {
  const da = dirs(), db = dirs();
  let a = await launch(da), b = await launch(db);
  try {
    await pairByLink(a, b);
    await save(a, b);
    await b.page.click("#leave");
    await expect(b.page.locator("#saved")).toBeVisible();
    await expect(a.page.locator("#ended")).toBeVisible({ timeout: 10_000 });
    await a.page.click("#restart");
    await b.page.locator(".device .device-always input").check();
    await expect.poll(() => devices(b)[0].alwaysAccept).toBe(true);

    await a.page.locator(".device-connect").click();
    await connected(a.page);
    await connected(b.page);

    // The sending page is ours, so reach past its checks to send what a malicious client would.
    await a.page.evaluate(() => {
      const O = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function (d) {
        if (typeof d === "string" && d.startsWith('{"t":"meta"')) {
          const m = JSON.parse(d);
          m.name = "../../../evil.txt";
          m.rel = "../../outside";
          d = JSON.stringify(m);
        }
        return O.call(this, d);
      };
    });
    const f = path.join(da.base, "plain.txt");
    fs.writeFileSync(f, "hello");
    await a.page.setInputFiles("#files", f);
    await expect(row(a.page, "plain.txt")).toContainText("Sent", { timeout: 30_000 }); // nobody clicked Accept
    const folder = path.join(b.downloads, os.hostname());
    expect(fs.readdirSync(folder)).toEqual([".._.._.._evil.txt"]);
    expect(fs.readFileSync(path.join(folder, ".._.._.._evil.txt"), "utf8")).toBe("hello");
    expect(fs.existsSync(path.join(db.home, "evil.txt"))).toBe(false);
    expect(fs.existsSync(path.join(db.home, "outside"))).toBe(false);
  } finally {
    await a.electronApp.close();
    await b.electronApp.close();
  }
});

test("a folder arrives with its structure, without a zip", async () => {
  const da = dirs(), db = dirs();
  const a = await launch(da), b = await launch(db);
  try {
    const top = path.join(da.base, "album");
    fs.mkdirSync(path.join(top, "2026", "june"), { recursive: true });
    fs.writeFileSync(path.join(top, "cover.jpg"), "cover");
    fs.writeFileSync(path.join(top, "2026", "a.jpg"), randomBytes(200_000));
    fs.writeFileSync(path.join(top, "2026", "june", "b.jpg"), "");
    await pairByLink(a, b);
    await a.electronApp.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, top);
    await a.page.click("#send-folder");
    await expect(b.page.locator(".item")).toHaveCount(3, { timeout: 15_000 });
    await b.page.click("#accept-all");
    for (const name of ["cover.jpg", "a.jpg", "b.jpg"]) await expect(row(a.page, name)).toContainText("Sent", { timeout: 30_000 });
    const got = path.join(b.downloads, "album");
    expect(sha(path.join(got, "2026", "a.jpg"))).toBe(sha(path.join(top, "2026", "a.jpg")));
    expect(fs.readFileSync(path.join(got, "cover.jpg"), "utf8")).toBe("cover");
    expect(fs.statSync(path.join(got, "2026", "june", "b.jpg")).size).toBe(0);
  } finally {
    await a.electronApp.close();
    await b.electronApp.close();
  }
});

test("killing both apps mid-file: they restart, find each other and finish with no help", async () => {
  const da = dirs(), db = dirs();
  let a = await launch(da), b = await launch(db);
  const big = path.join(da.base, "big.bin");
  try {
    await pairByLink(a, b);
    await save(a, b);
    const fd = fs.openSync(big, "w");
    for (let i = 0; i < 300; i++) fs.writeSync(fd, randomBytes(1024 * 1024));
    fs.closeSync(fd);

    // slow the sender so the kill lands mid-file
    await a.page.evaluate(() => {
      const O = RTCDataChannel.prototype.send;
      let n = 0;
      RTCDataChannel.prototype.send = function (d) {
        if (typeof d !== "string" && ++n % 40 === 0) { const end = performance.now() + 15; while (performance.now() < end); }
        return O.call(this, d);
      };
    });
    await a.page.setInputFiles("#files", big);
    await row(b.page, "big.bin").locator(".accept").click();
    await b.page.waitForFunction(() => { const e = document.querySelector(".item progress:not([hidden])"); return !!e && e.value / e.max >= 0.4; }, null, { timeout: 90_000 });
    a.electronApp.process().kill("SIGKILL");
    b.electronApp.process().kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 500));

    a = await launch(da);
    b = await launch(db);
    await expect(row(a.page, "big.bin")).toContainText("Sent", { timeout: 90_000 });
    await expect(row(b.page, "big.bin")).toContainText("Received", { timeout: 90_000 });
    const final = path.join(b.downloads, "big.bin");
    expect(sha(final)).toBe(sha(big));
  } finally {
    await a.electronApp.close();
    await b.electronApp.close();
  }
});

test("without a safe place for keys, the app won't offer to save, but transfers still work", async () => {
  const a = await launch(dirs(), { STREAMDROP_TEST_PLAIN_STORE: "" }), b = await launch(dirs());
  try {
    await pairByLink(a, b);
    await expect(a.page.locator("#save-offer")).toBeHidden();
    const data = randomBytes(10_000);
    expect(sha(await sendFile(a, b, "still.bin", data))).toBe(shaOf(data));
  } finally {
    await a.electronApp.close();
    await b.electronApp.close();
  }
});

test("autostart writes a login entry and can be turned off", async () => {
  const d = dirs();
  const a = await launch(d);
  try {
    await expect(a.page.locator("#app-settings")).toBeVisible();
    await a.page.locator("#autostart").check();
    const entry = path.join(d.home, ".config", "autostart", "streamdrop.desktop");
    await expect.poll(() => fs.existsSync(entry)).toBe(true);
    expect(fs.readFileSync(entry, "utf8")).toContain("--hidden");
    await a.page.locator("#autostart").uncheck();
    await expect.poll(() => fs.existsSync(entry)).toBe(false);
  } finally {
    await a.electronApp.close();
  }
});

test("an idle saved connection closes by itself, and the pair stays", async () => {
  const da = dirs(), db = dirs();
  const a = await launch(da), b = await launch(db);
  try {
    await pairByLink(a, b);
    await a.page.evaluate(() => { const O = Date.now; Date.now = () => O() + (window.__skip ?? 0); });
    await save(a, b);
    await a.page.evaluate(() => { window.__skip = 3 * 60_000; });
    await expect(a.page.locator("#ended")).toContainText("idle", { timeout: 15_000 });
    await expect(b.page.locator("#ended")).toBeVisible({ timeout: 15_000 });
    expect(devices(a)).toHaveLength(1);
    expect(devices(b)).toHaveLength(1);
  } finally {
    await a.electronApp.close();
    await b.electronApp.close();
  }
});

test("a browser and the app connect through a link, both ways, but the browser is not offered Save", async () => {
  const a = await launch(dirs());
  const browser = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks"] });
  const site = `http://127.0.0.1:${PORT}`;
  try {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    // The site, from the same origin as the signaling server, as in production.
    await page.route(`${site}/**`, (r) => {
      const p = new URL(r.request().url()).pathname;
      return r.fulfill({ path: path.join(root, "ui", p === "/" ? "index.html" : p) });
    });
    await page.addInitScript(() => {
      delete window.showSaveFilePicker;
      Object.defineProperty(navigator, "storage", { value: undefined });
    });
    await a.page.click("#create");
    await expect(a.page.locator("#link")).not.toHaveValue("", { timeout: 15_000 });
    const link = await a.page.locator("#link").inputValue();
    await page.goto(link.replace("http://invite.test", site));
    await connected(a.page);
    await connected(page);
    await expect(a.page.locator("#session")).toHaveAttribute("data-verified", "true");
    await expect(page.locator("#session")).toHaveAttribute("data-verified", "true");
    await expect(a.page.locator("#save-offer")).toBeHidden();

    const data = randomBytes(1_000_000);
    const dl = page.waitForEvent("download");
    const f = path.join(a.d.base, "to-browser.bin");
    fs.writeFileSync(f, data);
    await a.page.setInputFiles("#files", f);
    await row(page, "to-browser.bin").locator(".accept").click();
    expect(shaOf(fs.readFileSync(await (await dl).path()))).toBe(shaOf(data));

    const back = randomBytes(123_456);
    await page.setInputFiles("#files", { name: "from-browser.bin", mimeType: "application/octet-stream", buffer: back });
    await row(a.page, "from-browser.bin").locator(".accept").click();
    await expect(row(a.page, "from-browser.bin")).toContainText("Received", { timeout: 30_000 });
    expect(sha(path.join(a.downloads, "from-browser.bin"))).toBe(shaOf(back));
  } finally {
    await a.electronApp.close();
    await browser.close();
  }
});
