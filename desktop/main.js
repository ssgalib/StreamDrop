"use strict";
const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, net, powerSaveBlocker, protocol, safeStorage, shell } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createSinks, inside, read, stat, walk } = require("./files.js");

const SIGNAL_URL = process.env.STREAMDROP_SIGNAL || "wss://streamdrop.kurohane.xyz/ws";
const ORIGIN = process.env.STREAMDROP_ORIGIN || "https://streamdrop.kurohane.xyz";
const UI_DIR = path.join(__dirname, "ui");
const PAGE = "app://streamdrop/";
const HIDDEN = process.argv.includes("--hidden") || !!process.env.STREAMDROP_HIDDEN;

if (process.env.STREAMDROP_USER_DATA) app.setPath("userData", process.env.STREAMDROP_USER_DATA);
// Tests run on machines with no keyring. A packaged app never takes this path.
const plainStore = !app.isPackaged && !!process.env.STREAMDROP_TEST_PLAIN_STORE;

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();

let win;
let tray;
let quitting = false;
let keepAwake;

const dataFile = (name) => path.join(app.getPath("userData"), name);

async function loadJson(name, fallback) {
  try { return JSON.parse(await fs.readFile(dataFile(name), "utf8")); } catch { return fallback; }
}

async function saveJson(name, value) {
  const tmp = `${dataFile(name)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(tmp, dataFile(name));
}

// ---------------------------------------------------------------- keys

// Linux without a keyring falls back to "basic_text", a hardcoded password: that is no protection, so refuse to save.
async function canKeepSecrets() {
  if (plainStore) return true;
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
  return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
}

async function seal(k) {
  if (plainStore) return Buffer.from(k).toString("base64");
  return (await safeStorage.encryptStringAsync(Buffer.from(k).toString("base64"))).toString("base64");
}

async function unseal(stored) {
  if (plainStore) return new Uint8Array(Buffer.from(stored, "base64"));
  const { result } = await safeStorage.decryptStringAsync(Buffer.from(stored, "base64"));
  return new Uint8Array(Buffer.from(result, "base64"));
}

// ---------------------------------------------------------------- saved devices

// Only k is secret, and it is sealed. Room ids stay readable, so the listener can start before a keyring is unlocked.
const loadDevices = () => loadJson("devices.json", []);
const publicDevice = ({ k, ...rest }) => rest;

async function changeDevice(roomId, change) {
  const list = await loadDevices();
  const d = list.find((x) => x.roomId === roomId);
  if (d) {
    if (typeof change.name === "string") d.name = change.name.slice(0, 64);
    if (typeof change.alwaysAccept === "boolean") d.alwaysAccept = change.alwaysAccept;
    if (Number.isSafeInteger(change.lastSeen)) d.lastSeen = change.lastSeen;
    await saveJson("devices.json", list);
  }
}

// ---------------------------------------------------------------- settings

let settings = { downloads: "" };
const downloadsDir = () => settings.downloads || path.join(app.getPath("downloads"), "StreamDrop");

// Received files carry the mark browsers give downloads, so the system warns before running one.
async function markDownloaded(file) {
  if (process.platform === "win32") await fs.writeFile(`${file}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n").catch(() => {});
}

const sinks = createSinks(downloadsDir, markDownloaded);

const autostartFile = () => path.join(app.getPath("appData"), "autostart", "streamdrop.desktop");

async function getAutostart() {
  if (process.platform !== "linux") return app.getLoginItemSettings().openAtLogin;
  return fs.access(autostartFile()).then(() => true, () => false);
}

async function setAutostart(on) {
  if (process.platform !== "linux") return app.setLoginItemSettings({ openAtLogin: !!on, args: ["--hidden"] });
  if (!on) return fs.rm(autostartFile(), { force: true });
  await fs.mkdir(path.dirname(autostartFile()), { recursive: true });
  // An AppImage's real path is in $APPIMAGE; process.execPath points inside its temporary mount.
  const exec = process.env.APPIMAGE || process.execPath;
  await fs.writeFile(autostartFile(), `[Desktop Entry]\nType=Application\nName=StreamDrop\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
}

// ---------------------------------------------------------------- what a restart needs to carry on

let record = null;
let recordWrites = Promise.resolve();

function setRecord(value) {
  record = typeof value === "string" ? value : null;
  const snapshot = record;
  recordWrites = recordWrites.then(() => saveJson("record.json", snapshot)).catch(() => {});
}

// ---------------------------------------------------------------- talking to the page

// The bundled page is the only thing allowed to call these.
function handle(name, fn) {
  ipcMain.handle(name, (event, ...args) => {
    if (!event.senderFrame?.url.startsWith(PAGE)) throw new Error("Refused");
    return fn(...args);
  });
}

async function chooseFolder(title) {
  const r = await dialog.showOpenDialog(win, { title, properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
}

function registerIpc(canSave) {
  ipcMain.on("app:info", (event) => {
    event.returnValue = { signalUrl: SIGNAL_URL, origin: ORIGIN, deviceName: os.hostname().slice(0, 64), canSave };
  });
  ipcMain.on("record:get", (event) => { event.returnValue = record; });
  ipcMain.on("record:set", (event, value) => {
    if (event.senderFrame?.url.startsWith(PAGE)) setRecord(value);
  });
  ipcMain.on("app:busy", (_, on) => setBusy(!!on));
  ipcMain.on("app:notify", (_, title, body) => {
    if (win?.isFocused() || !Notification.isSupported()) return;
    const n = new Notification({ title: String(title), body: String(body) });
    n.on("click", showWindow);
    n.show();
  });

  handle("devices:list", async () => (await loadDevices()).map(publicDevice));
  handle("devices:add", async ({ roomId, name, k }) => {
    if (!canSave) throw new Error("This computer has no safe place for keys");
    const list = (await loadDevices()).filter((d) => d.roomId !== roomId);
    list.push({ roomId, name: String(name).slice(0, 64), addedAt: Date.now(), lastSeen: Date.now(), alwaysAccept: false, k: await seal(k) });
    await saveJson("devices.json", list);
  });
  handle("devices:key", async (roomId) => {
    const d = (await loadDevices()).find((x) => x.roomId === roomId);
    if (!d) throw new Error("No such device");
    return unseal(d.k);
  });
  handle("devices:update", changeDevice);
  handle("devices:remove", async (roomId) => saveJson("devices.json", (await loadDevices()).filter((d) => d.roomId !== roomId)));

  handle("sink:open", (s) => sinks.open(s));
  handle("sink:write", (id, data) => sinks.write(id, data));
  handle("sink:close", (id) => sinks.close(id).then(() => undefined));
  handle("sink:abort", (id) => sinks.abort(id));
  handle("sink:offset", (id) => sinks.offset(id));
  handle("sink:clean", () => sinks.clean());

  // shortcut: the page can read any path here. It is our own bundled code, under a strict CSP, and shows peer text
  // only as text. If it ever loads remote content, restrict this to paths the person chose.
  handle("file:read", (p, start, end) => read(String(p), start, end));
  handle("file:stat", (p) => stat(String(p)));
  handle("file:pickFolder", () => chooseFolder("Choose a folder to send"));
  handle("file:walk", (p) => walk(String(p)));

  handle("settings:get", async () => ({ autostart: await getAutostart(), downloads: downloadsDir() }));
  handle("settings:setAutostart", setAutostart);
  handle("settings:pickDownloads", async () => {
    const dir = await chooseFolder("Choose where to save files");
    if (dir) {
      settings.downloads = dir;
      await saveJson("settings.json", settings);
    }
    return downloadsDir();
  });
}

// Stops the computer sleeping, only while files are moving.
function setBusy(on) {
  if (on && keepAwake === undefined) keepAwake = powerSaveBlocker.start("prevent-app-suspension");
  else if (!on && keepAwake !== undefined) {
    powerSaveBlocker.stop(keepAwake);
    keepAwake = undefined;
  }
}

// ---------------------------------------------------------------- window and tray

function serveUi() {
  const signalOrigin = new URL(SIGNAL_URL).origin;
  const csp = `default-src 'self'; connect-src ${signalOrigin}; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
  protocol.handle("app", async (req) => {
    const url = new URL(req.url);
    if (url.host !== "streamdrop") return new Response("Not found", { status: 404 });
    const file = path.join(UI_DIR, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!inside(UI_DIR, file)) return new Response("Not found", { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set("Content-Security-Policy", csp);
    return new Response(res.body, { status: res.status, headers });
  });
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 760,
    show: false,
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // the engine keeps moving files while the window is hidden
    },
  });
  // The page never leaves the bundle: a link goes to the system browser, anything else is refused.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(PAGE)) e.preventDefault();
  });
  win.on("close", (e) => {
    if (!quitting && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  if (!HIDDEN) win.once("ready-to-show", showWindow);
  return win.loadURL(PAGE);
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, "icon.png"));
  } catch {
    return; // some desktops have no tray: the window then behaves like any other
  }
  tray.setToolTip("StreamDrop");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open StreamDrop", click: showWindow },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", showWindow);
}

app.on("second-instance", showWindow);
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { if (!tray || quitting) app.quit(); });

app.whenReady().then(async () => {
  settings = { ...settings, ...(await loadJson("settings.json", {})) };
  record = await loadJson("record.json", null);
  registerIpc(await canKeepSecrets());
  serveUi();
  if (!process.env.STREAMDROP_NO_TRAY) createTray();
  await createWindow();
});
