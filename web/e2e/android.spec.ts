import { test, expect, chromium, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer } from "./server";
import { row, sha, shaFile, URL } from "./helpers";

// The Android spike against a real browser, on an emulator or a phone with `adb reverse tcp:8080 tcp:8080`.
// On an emulator run `adb shell svc wifi disable` first: its virtual access point loses beacons every few seconds
// and drops the network. The simulated mobile link doesn't.
//   ANDROID_SPIKE=ws://10.0.2.2:8080/ws npm run test:e2e -- android
const server = process.env.ANDROID_SPIKE;
const SIZE = Number(process.env.ANDROID_SPIKE_MIB ?? 64) * 1024 * 1024;
const PKG = "xyz.kurohane.streamdrop";
const FILES = `/sdcard/Android/data/${PKG}/files`;
test.skip(!server, "set ANDROID_SPIKE to the server's address as seen from the device");
test.setTimeout(1_200_000);

const adb = (...args: string[]) => execFileSync("adb", args, { encoding: "utf8", maxBuffer: 1 << 26 });
const log = () => adb("logcat", "-d", "-s", "SD:*");

async function logged(re: RegExp, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const text = log();
    const m = text.match(re);
    if (m) return m;
    if (/ice FAILED/.test(text)) throw new Error(`connection lost:\n${text.slice(-1500)}`); // the spike can't reconnect
    if (Date.now() > end) throw new Error(`no ${re} in the log:\n${log().slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function startApp(extra: string[] = []) {
  adb("shell", "am", "force-stop", PKG);
  adb("logcat", "-c");
  adb("shell", "am", "start-foreground-service", "-n", `${PKG}/.SpikeService`, "--es", "server", server!, ...extra);
}

// Browsers hide their address behind an mDNS name, which an emulator can't resolve.
// A persistent profile: a throwaway one has so little quota that a large file goes to the save dialog, which nobody can press.
async function browserPage() {
  const profile = mkdtempSync(join(tmpdir(), "sd-android-profile-"));
  const ctx = await chromium.launchPersistentContext(profile, { acceptDownloads: true, args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] });
  // The quota follows free disk, and falling below twice the file means the save dialog again.
  await ctx.addInitScript("navigator.storage.estimate = async () => ({ quota: 1e12, usage: 0 })");
  const page = await ctx.newPage();
  return {
    page,
    close: async () => {
      await ctx.close();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

async function invite(p: Page) {
  await p.goto(URL);
  await p.click("#create");
  await expect(p.locator("#link")).not.toHaveValue("", { timeout: 15_000 });
  return (await p.locator("#link").inputValue()).split("#")[1];
}

const connected = async (p: Page) => {
  await expect(p.locator("#session")).toBeVisible({ timeout: 60_000 }).catch((e) => { console.log(log().slice(-1500)); throw e; });
  await expect(p.locator("#session")).toHaveAttribute("data-verified", "true", { timeout: 15_000 });
};

let dir: string;
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sd-android-"));
  await startServer();
  adb("shell", "am", "force-stop", PKG);
  adb("shell", "pm", "clear", PKG);
  adb("shell", "mkdir", "-p", FILES);
});
test.afterAll(async () => {
  await stopServer();
  rmSync(dir, { recursive: true, force: true });
});

function fileOf(name: string) {
  const path = join(dir, name);
  const fd = openSync(path, "w");
  for (let left = SIZE; left > 0; left -= 1 << 24) writeSync(fd, randomBytes(Math.min(left, 1 << 24)));
  closeSync(fd);
  return path;
}

const deviceSha = (path: string) => adb("shell", "sha256sum", path).split(" ")[0];

test("a browser's link: verified, and a file reaches Android intact", async () => {
  const { page, close } = await browserPage();
  try {
    const f = fileOf("to-android.bin"); // before connecting: making 2 GiB starves an emulator's network
    startApp(["--es", "invite", await invite(page)]);
    await connected(page);
    await logged(/GATE passed verified=true/);
    await page.setInputFiles("#files", f);
    const m = await logged(/RECEIVED to-android\.bin .*/, 900_000);
    console.log(m[0]);
    expect(deviceSha(`${FILES}/recv-to-android.bin`)).toBe(await shaFile(f));
    await expect(row(page, "to-android.bin")).toContainText("Sent");
  } finally {
    await close();
  }
});

test("Android makes the invite and offers, and the browser receives it intact", async () => {
  const { page, close } = await browserPage();
  try {
    const f = fileOf("from-android.bin");
    adb("push", f, `${FILES}/from-android.bin`);
    startApp(["--es", "send", "from-android.bin"]);
    const link = (await logged(/INVITE (\S+)/))[1];
    await page.goto(`${URL}/#${link}`);
    await connected(page);
    await logged(/GATE passed verified=true/);
    const dl = page.waitForEvent("download", { timeout: 900_000 });
    await row(page, "from-android.bin").locator(".accept").click();
    const path = await (await dl).path();
    console.log((await logged(/SENT from-android\.bin .*/, 900_000))[0]);
    expect(await shaFile(path)).toBe(await shaFile(f));
    await logged(/SENT confirmed saved/);
  } finally {
    await close();
  }
});

test("a wrong key is refused on both sides", async () => {
  const { page, close } = await browserPage();
  try {
    const link = await invite(page);
    startApp(["--es", "invite", `${link.split(".")[0]}.${"A".repeat(26)}`]);
    await logged(/GATE failed auth/);
    await expect(page.locator("body")).toContainText("Couldn't verify the other device", { timeout: 20_000 });
  } finally {
    await close();
  }
});

test("a typed code connects, unverified", async () => {
  const { page, close } = await browserPage();
  try {
    startApp(["--es", "invite", (await invite(page)).split(".")[0]]);
    await logged(/GATE passed verified=false/);
    await expect(page.locator("#session")).toHaveAttribute("data-verified", "false", { timeout: 15_000 });
    const data = randomBytes(100_000);
    await page.setInputFiles("#files", { name: "typed.bin", mimeType: "application/octet-stream", buffer: data });
    await logged(/RECEIVED typed\.bin/);
    expect(deviceSha(`${FILES}/recv-typed.bin`)).toBe(sha(data));
  } finally {
    await close();
  }
});
