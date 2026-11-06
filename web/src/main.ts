import { parseInvite } from "./auth";
import { createConnection, type Phase } from "./connection";
import { createTransfers, type Item, type Saved } from "./transfers";
import { app, appSinks, initApp, pathOf, type AppHooks } from "./app";
import * as browserSinks from "./sinks";
import { fingerprint, isId, parseMeta } from "./transfer";
import { drawQr } from "./qr";
import { fmtSize, fmtTime } from "./format";
import { initStored, openStoredLink } from "./stored";
import { parseStoredLink } from "./store";
import { flashCopied, setStatus, showError } from "./ui";
import "./style.css";

const { chooseSink, cleanOpfs, discardParts, openParts, partsOffset } = app ? appSinks(app) : browserSinks;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const homeEl = $("#home");
const pairEl = $("#pair");
const sessionEl = $("#session");
const sessionBar = $(".sessionbar");
const peerState = $("#peer-state");
const dropzone = $("#dropzone");
const filesInput = $<HTMLInputElement>("#files");
const endedEl = $("#ended");
const bulkEl = $("#bulk");
const activityEl = $("#activity");
const clearBtn = $("#clear");
const noteEl = $("#note");
const leaveBtn = $("#leave");

type View = "none" | "home" | "pair" | "session";
function view(v: View) {
  homeEl.hidden = v !== "home";
  pairEl.hidden = v !== "pair";
  sessionEl.hidden = v !== "session";
  // The connected screen shows its own state, so the status line goes quiet there (screen readers still hear it)
  $("#status").classList.toggle("visually-hidden", v === "session");
}

// ---------------------------------------------------------------- connection and transfers

const RECORD_KEY = "streamdrop-session";
type Record = { session: string; p?: string; items: Saved[]; at: number };

// How long a pair is remembered for an automatic rejoin when the page was killed or reloaded, and how long
// a device waits for the other to come back before giving up (when no file is in progress).
const RECONNECT_WINDOW = 10 * 60_000;
const GRACE = 5 * 60_000;

// A killed app loses recent localStorage writes, so the app keeps this in a file instead.
const recordStore = () => app?.record ?? localStorage;

// What a reload needs to carry on: the shared secret, and the files that were moving. Written even when
// nothing is moving, so a phone that kills the tab while you pick files can reconnect by itself.
// Reads are wrapped and validated: storage can be blocked or edited.
function saveRecords(items: Saved[]) {
  try {
    if (conn.session) recordStore().setItem(RECORD_KEY, JSON.stringify({ session: hooks?.savedRoom() ?? conn.session, p: conn.inviteKey, items, at: Date.now() }));
  } catch { /* storage blocked: the pair just can't be rejoined after a reload */ }
}

function clearRecord() {
  try { recordStore().removeItem(RECORD_KEY); } catch { /* ignore */ }
}

function loadRecords(): Record | null {
  try {
    const raw = JSON.parse(recordStore().getItem(RECORD_KEY) ?? "null");
    if (!isId(raw?.session) || !Array.isArray(raw.items)) return null;
    const items: Saved[] = [];
    for (const r of raw.items.slice(0, 500)) {
      const m = parseMeta(r);
      if (m && (r.dir === "send" || r.dir === "receive")) {
        items.push({ id: m.id, dir: r.dir, name: m.name, size: m.size, type: m.type, fp: m.fp, ...(typeof r.path === "string" && { path: r.path }) });
      }
    }
    return { session: raw.session, p: isId(raw.p) ? raw.p : undefined, items, at: Number.isFinite(raw.at) ? raw.at : 0 };
  } catch {
    return null;
  }
}

let hooks: AppHooks | undefined; // only in the desktop app
let giveUp: ReturnType<typeof setTimeout> | undefined;
// Nothing is in progress and the other device is gone: wait a while (phones freeze tabs when you pick a file),
// then stop. With files in progress we keep waiting, since they can carry on.
function armGiveUp() {
  clearTimeout(giveUp);
  if (transfers.hasUnfinished()) return;
  giveUp = setTimeout(() => {
    if (!conn.isOpen()) ended("The other device didn't come back.");
  }, GRACE);
}

const conn = createConnection({
  phase(p: Phase) {
    switch (p) {
      case "waiting": view("pair"); setStatus("Waiting for the other device"); break;
      case "connecting": view("none"); setStatus("Connecting"); break;
      case "open": view("session"); setSessionState("open"); setStatus("Connected"); break;
      case "reconnecting": view("session"); setSessionState("paused"); setStatus("Reconnecting…"); break;
      case "idle": setStatus(""); break;
    }
  },
  invite(token, p) {
    const link = `${app?.origin ?? location.origin}/#${token}.${p}`;
    $("#token").textContent = token;
    $<HTMLTextAreaElement>("#link").value = link;
    drawQr($<SVGSVGElement & HTMLElement>("#qr-code"), link);
    $("#share").hidden = false;
    $("#renew").hidden = true;
    $("#copy").focus();
  },
  inviteExpired() {
    $("#share").hidden = true;
    $("#renew").hidden = false;
    setStatus("Link expired");
  },
  open(reconnected) {
    clearTimeout(giveUp);
    sessionEl.dataset.verified = String(conn.verified);
    endedEl.hidden = true;
    dropzone.hidden = false;
    leaveBtn.hidden = false;
    showError("");
    transfers.onOpen(reconnected);
    hooks?.opened(reconnected);
  },
  message(data) {
    if (!hooks?.message(data)) void transfers.onMessage(data);
  },
  low: () => transfers.onLow(),
  async lost() {
    await transfers.onLost(); // files that were moving pause with exact offsets
    conn.rejoin(); // always try to get back together: a phone freezes its tab while you pick a file
    armGiveUp();
  },
  bye: () => ended("The other device disconnected."), // it left on purpose: no reason to wait
  session: () => transfers.persist(), // the pair can now be saved and rejoined
  error: connectionError,
  refused(text) {
    hooks?.refused();
    if (sessionEl.hidden) connectionError(text);
    else ended(text);
  },
  listeners: (n) => hooks?.listeners(n),
}, app?.signalUrl, app ? ["save"] : []);

function connectionError(text: string) {
  showError(text);
  // a failed pairing or join goes back to the start; an open session stays as it is
  if (!sessionEl.hidden) return;
  conn.leave();
  view("home");
}

const transfers = createTransfers({
  send: (m) => conn.send(m),
  channel: () => conn.channel(),
  channelOpen: () => conn.isOpen(),
  maxMessage: () => conn.maxMessage(),
  chooseSink,
  save: saveRecords,
  pathOf: app && pathOf,
  changed: scheduleRender,
  warn: showError,
});

function setSessionState(s: "open" | "paused" | "ended") {
  sessionBar.dataset.state = s;
  const who = hooks?.peerName() ?? "the other device";
  peerState.textContent = s === "open" ? `Connected to ${who}` : s === "paused" ? "Reconnecting…" : "Disconnected";
}

// The connection is over and nothing is left to finish. History stays visible.
function ended(text: string) {
  clearTimeout(giveUp);
  hooks?.ended();
  transfers.cancelAll();
  conn.leave();
  clearRecord();
  setSessionState("ended");
  setStatus("Disconnected");
  $("#ended-text").textContent = text;
  endedEl.hidden = false;
  dropzone.hidden = true;
  leaveBtn.hidden = true; // nothing left to disconnect from
  scheduleRender();
}

async function goHome() {
  clearTimeout(giveUp);
  hooks?.ended();
  transfers.cancelAll();
  try { conn.send({ t: "bye", reason: "user" }); } catch { /* not connected */ } // so the other device doesn't wait for us
  await new Promise((r) => setTimeout(r, 150)); // let it leave before the connection closes
  conn.leave();
  clearRecord();
  transfers.clearFinished();
  endedEl.hidden = true;
  dropzone.hidden = false;
  leaveBtn.hidden = false;
  view("home");
  setStatus("");
  showError("");
}

// ---------------------------------------------------------------- the activity list

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  // animation frames pause in background tabs, so fall back to a timer there
  const run = () => {
    if (!renderQueued) return;
    renderQueued = false;
    render();
  };
  requestAnimationFrame(run);
  setTimeout(run, 250);
}

const rows = new Map<string, HTMLLIElement>();

function describe(it: Item): string {
  const size = fmtSize(it.size);
  switch (it.state) {
    case "offered":
      if (it.dir === "send") return `${size} · Waiting for the other device to accept`;
      return it.needsClick ? `${size} · Click Accept to choose where to save it` : `${size} · Wants to send you this file`;
    case "waiting": return it.dir === "send" ? `${size} · Accepted, waiting for its turn` : `${size} · Starting…`;
    case "active": {
      if (it.note) return `${size} · ${it.note}`; // e.g. Finalizing…
      const pct = it.size ? Math.floor((it.bytes / it.size) * 100) : 100;
      let text = `${it.dir === "send" ? "Sending" : "Receiving"} · ${pct}% · ${fmtSize(it.bytes)} of ${size}`;
      if (it.speed > 0 && it.bytes < it.size) text += ` · ${fmtSize(it.speed)}/s · ${fmtTime((it.size - it.bytes) / it.speed)} left`;
      return text;
    }
    case "paused": return `${size} · Reconnecting…`;
    case "done": return `${size} · ${it.dir === "send" ? "Sent" : "Received"}`;
    case "declined": return `${size} · Declined${it.note ? ` · ${it.note}` : ""}`;
    case "cancelled": return `${size} · Cancelled${it.note ? ` · ${it.note}` : ""}`;
    case "failed": return `${size} · ${it.note || "Failed"}`;
  }
}

function button(label: string, cls: string, onClick: () => void, name: string) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn btn-sm ${cls} ${name}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function makeRow(it: Item): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "item";
  li.dataset.id = it.id;
  li.dataset.dir = it.dir;
  // static markup only: the file name is added below as text
  li.innerHTML = `<svg class="item-icon" aria-hidden="true"><use href="#i-${it.dir === "send" ? "upload" : "download"}"/></svg>
    <div class="item-main"><p class="item-name"></p><p class="item-detail"></p><progress max="1" value="0" hidden></progress></div>
    <div class="item-actions"></div>`;
  li.querySelector(".item-name")!.textContent = it.name; // untrusted: textContent only
  li.querySelector("progress")!.setAttribute("aria-label", `Progress of ${it.name}`);
  li.querySelector(".item-actions")!.append(
    button("Accept", "btn-primary", () => void transfers.accept(it.id), "accept"),
    button("Decline", "btn-outline", () => transfers.decline(it.id), "decline"),
    button("Cancel", "btn-outline", () => transfers.cancel(it.id), "cancel"),
  );
  return li;
}

function render() {
  const items = transfers.items();
  for (const it of items) {
    let li = rows.get(it.id);
    if (!li) {
      li = makeRow(it);
      rows.set(it.id, li);
      activityEl.append(li);
    }
    li.dataset.state = it.state;
    li.querySelector(".item-detail")!.textContent = describe(it);
    const bar = li.querySelector("progress")!;
    bar.hidden = !(it.state === "active" || it.state === "paused");
    bar.max = it.size || 1;
    bar.value = it.bytes;
    const offeredToMe = it.dir === "receive" && it.state === "offered";
    li.querySelector<HTMLElement>(".accept")!.hidden = !offeredToMe;
    li.querySelector<HTMLElement>(".decline")!.hidden = !offeredToMe;
    li.querySelector<HTMLElement>(".cancel")!.hidden = !(["waiting", "active", "paused"].includes(it.state) || (it.dir === "send" && it.state === "offered"));
  }
  const ids = new Set(items.map((i) => i.id));
  for (const [id, li] of rows) {
    if (!ids.has(id)) {
      li.remove();
      rows.delete(id);
    }
  }

  const waiting = items.filter((i) => i.dir === "receive" && i.state === "offered").length;
  bulkEl.hidden = waiting < 2;
  $("#bulk-text").textContent = `${waiting} files are waiting for you`;
  clearBtn.hidden = !items.some((i) => ["done", "declined", "cancelled", "failed"].includes(i.state));
  noteEl.hidden = !items.some((i) => i.state === "active" || i.state === "paused"); // only while files are moving
  keepAwake(transfers.activeCount() > 0);
  hooks?.rendered(items);
}

// Keeps the screen on while files move, so the tab isn't suspended; a refusal is fine.
let lock: WakeLockSentinel | null = null;
let lockPending = false;
function keepAwake(on: boolean) {
  if (on && !lock && !lockPending) {
    lockPending = true;
    navigator.wakeLock?.request("screen").then(
      (l) => { lockPending = false; lock = l; if (!transfers.activeCount()) keepAwake(false); },
      () => { lockPending = false; },
    );
  } else if (!on && lock) {
    void lock.release();
    lock = null;
  }
}

// Closing the tab mid-transfer would interrupt the file.
addEventListener("beforeunload", (e) => {
  if (transfers.items().some((i) => i.state === "active" || i.state === "paused")) e.preventDefault();
});

// ---------------------------------------------------------------- sending files

function offerFiles(files: File[]) {
  if (!files.length) return;
  if (!conn.isOpen()) return showError("Not connected right now. Wait for it to reconnect, then try again.");
  showError("");
  void transfers.offer(files);
}

filesInput.addEventListener("change", () => {
  offerFiles([...(filesInput.files ?? [])]);
  filesInput.value = ""; // so the same file can be chosen again
});

sessionEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("is-over");
});
sessionEl.addEventListener("dragleave", (e) => {
  if (e.target === sessionEl || e.target === dropzone) dropzone.classList.remove("is-over");
});
sessionEl.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("is-over");
  const files: File[] = [];
  const folders: File[] = [];
  for (const entry of [...(e.dataTransfer?.items ?? [])]) {
    if (entry.kind !== "file") continue;
    const isFolder = entry.webkitGetAsEntry?.()?.isDirectory; // ask before getAsFile
    const f = entry.getAsFile();
    if (f) (isFolder ? folders : files).push(f);
  }
  if (folders.length && hooks) void hooks.sendFolders(folders);
  else if (folders.length) showError("Folders can't be sent. Zip the folder first, then send the zip.");
  offerFiles(files);
});

// ---------------------------------------------------------------- buttons

$("#create").addEventListener("click", () => {
  showError("");
  conn.create();
});
$("#renew-btn").addEventListener("click", () => {
  showError("");
  conn.create();
});
$("#cancel-pair").addEventListener("click", () => {
  conn.leave();
  view("home");
  setStatus("");
});
$("#copy").addEventListener("click", () => {
  const link = $<HTMLTextAreaElement>("#link");
  navigator.clipboard.writeText(link.value).then(
    () => flashCopied($("#copy")),
    () => link.select(), // clipboard blocked: select it so Ctrl+C works
  );
});
$("#join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  showError("");
  view("none");
  setStatus("Connecting");
  const { token, p } = parseInvite($<HTMLInputElement>("#token-input").value);
  conn.join(token, p);
});

$("#accept-all").addEventListener("click", () => void transfers.acceptAll());
$("#decline-all").addEventListener("click", () => transfers.declineAll());
clearBtn.addEventListener("click", () => transfers.clearFinished());
leaveBtn.addEventListener("click", goHome);
$("#restart").addEventListener("click", goHome);
bulkEl.setAttribute("aria-live", "polite"); // new offers are announced

// ---------------------------------------------------------------- after a reload: carry on with what was interrupted

const unfinishedEl = $("#unfinished");
const resumeBtn = $("#resume");
const resumeFiles = $<HTMLInputElement>("#resume-files");
let resumeSession: string | undefined;
let resumeKey: string | undefined;
let pendingSends: Saved[] = [];
let rejoined = false;

async function showUnfinished() {
  const rec = loadRecords();
  if (!rec || !rec.items.length) return;
  resumeSession = rec.session;
  resumeKey = rec.p;
  pendingSends = rec.items.filter((i) => i.dir === "send");
  const receives = rec.items.filter((i) => i.dir === "receive");
  const list = $("#unfinished-list");
  list.replaceChildren();
  for (const it of rec.items) {
    const li = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = it.name; // untrusted: textContent only
    const note = document.createElement("span");
    note.className = "pct";
    note.textContent = it.dir === "receive" ? ` (${it.size ? Math.floor(((await partsOffset(it.id)) / it.size) * 100) : 100}% saved)` : " (choose the file again)";
    li.append(name, note);
    list.append(li);
  }
  resumeBtn.hidden = receives.length === 0;
  $("#unfinished-send").hidden = pendingSends.length === 0;
  unfinishedEl.hidden = false;
}

function startRejoin() {
  if (rejoined || !resumeSession) return;
  rejoined = true;
  conn.rejoin(resumeSession, resumeKey); // shows the connected screen as "Reconnecting…"
}

resumeBtn.addEventListener("click", async () => {
  const rec = loadRecords();
  if (!rec) return;
  showError("");
  try {
    for (const it of rec.items.filter((i) => i.dir === "receive")) {
      const opened = await openParts(it.id, it.name, it.type);
      transfers.restore(it, { sink: opened.sink, offset: opened.offset });
    }
  } catch {
    clearRecord();
    unfinishedEl.hidden = true;
    return showError("This browser can't continue that transfer. Ask the other device to send the file again.");
  }
  resumeBtn.hidden = true;
  if (!pendingSends.length) unfinishedEl.hidden = true;
  startRejoin();
});

resumeFiles.addEventListener("change", async () => {
  const chosen = [...(resumeFiles.files ?? [])];
  resumeFiles.value = "";
  const unmatched: string[] = [];
  for (const file of chosen) {
    const fp = await fingerprint(file);
    const hit = pendingSends.find((s) => s.size === file.size && s.fp === fp);
    if (!hit) {
      unmatched.push(file.name);
      continue;
    }
    pendingSends = pendingSends.filter((s) => s !== hit);
    transfers.restore(hit, { file });
  }
  if (unmatched.length) showError(`Not the same file: ${unmatched.join(", ")}`);
  else showError("");
  if (chosen.length > unmatched.length) startRejoin();
  if (!pendingSends.length) $("#unfinished-send").hidden = true;
  if (!pendingSends.length && resumeBtn.hidden) unfinishedEl.hidden = true;
});

$("#discard").addEventListener("click", async () => {
  const rec = loadRecords();
  clearRecord();
  unfinishedEl.hidden = true;
  for (const it of rec?.items ?? []) if (it.dir === "receive") await discardParts(it.id);
});

// ---------------------------------------------------------------- start up

void cleanOpfs();

// Pasting a link into a tab that already has the site open only changes the "#" part, which doesn't
// reload the page. The links are read at load, so reload to act on them.
addEventListener("hashchange", () => location.reload());

// Links carry their secret after "#", which the server never sees. Take it out of the address bar.
const stored = parseStoredLink(location.hash);
const linkToken = location.hash.slice(1);
view("home");
if (app) {
  hooks = await initApp(app, { conn, transfers, ended, offerFiles, showError, setStatus, setSessionState, view });
}
if (hooks && await hooks.resume(loadRecords())) {
  armGiveUp();
} else if (stored) {
  history.replaceState(null, "", location.pathname + location.search);
  void openStoredLink(stored);
} else if (linkToken) {
  history.replaceState(null, "", location.pathname + location.search);
  const { token, p } = parseInvite(linkToken);
  $<HTMLInputElement>("#token-input").value = token;
  view("none");
  setStatus("Connecting");
  conn.join(token, p);
} else {
  const rec = loadRecords();
  if (!app && rec && !rec.items.length && Date.now() - rec.at < RECONNECT_WINDOW) {
    // The tab was killed or reloaded (a phone does this while you pick a file) with nothing in flight: rejoin.
    resumeSession = rec.session;
    rejoined = true;
    conn.rejoin(rec.session, rec.p);
    armGiveUp();
  } else {
    void showUnfinished();
    if (!app) void initStored(); // Stored mode lives on the website
  }
}

// Coming back to the tab (e.g. from the Files app): don't wait for a retry timer that was frozen meanwhile.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && conn.session && conn.phase !== "idle" && !conn.isOpen()) conn.rejoin();
});

// Keep the saved pair fresh while connected, so it counts as recent if the tab is killed hours later.
setInterval(() => {
  if (conn.isOpen()) transfers.persist();
}, 60_000);
