import { createConnection, type Phase } from "./connection";
import { createTransfers, type Item, type Saved } from "./transfers";
import { chooseSink, cleanOpfs, discardParts, openParts, partsOffset } from "./sinks";
import { fingerprint, isId, parseMeta } from "./transfer";
import { drawQr } from "./qr";
import { fmtSize, fmtTime } from "./format";
import { initStored, openStoredLink } from "./stored";
import { parseStoredLink } from "./store";
import { flashCopied, setStatus, showError } from "./ui";
import "./style.css";

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
type Record = { session: string; items: Saved[] };

// What a reload needs to carry on. Reads are wrapped and validated: storage can be blocked or edited.
function saveRecords(items: Saved[]) {
  try {
    if (items.length && conn.session) localStorage.setItem(RECORD_KEY, JSON.stringify({ session: conn.session, items }));
    else localStorage.removeItem(RECORD_KEY);
  } catch { /* storage blocked: files just can't resume after a reload */ }
}

function loadRecords(): Record | null {
  try {
    const raw = JSON.parse(localStorage.getItem(RECORD_KEY) ?? "null");
    if (!isId(raw?.session) || !Array.isArray(raw.items)) return null;
    const items: Saved[] = [];
    for (const r of raw.items.slice(0, 500)) {
      const m = parseMeta(r);
      if (m && (r.dir === "send" || r.dir === "receive")) items.push({ id: m.id, dir: r.dir, name: m.name, size: m.size, type: m.type, fp: m.fp });
    }
    return items.length ? { session: raw.session, items } : null;
  } catch {
    return null;
  }
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
  invite(token) {
    const link = `${location.origin}/#${token}`;
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
    endedEl.hidden = true;
    dropzone.hidden = false;
    leaveBtn.hidden = false;
    showError("");
    transfers.onOpen(reconnected);
  },
  message: (data) => void transfers.onMessage(data),
  low: () => transfers.onLow(),
  async lost() {
    await transfers.onLost(); // files that were moving pause with exact offsets
    if (transfers.hasUnfinished()) conn.rejoin(); // something is still in progress: get back together
    else ended("The other device disconnected.");
  },
  error(text) {
    showError(text);
    // a failed pairing or join goes back to the start; an open session stays as it is
    if (!sessionEl.hidden) return;
    conn.leave();
    view("home");
  },
});

const transfers = createTransfers({
  send: (m) => conn.send(m),
  channel: () => conn.channel(),
  channelOpen: () => conn.isOpen(),
  maxMessage: () => conn.maxMessage(),
  chooseSink,
  save: saveRecords,
  changed: scheduleRender,
  warn: showError,
});

function setSessionState(s: "open" | "paused" | "ended") {
  sessionBar.dataset.state = s;
  peerState.textContent = s === "open" ? "Connected to the other device" : s === "paused" ? "Reconnecting…" : "Disconnected";
}

// The connection is over and nothing is left to finish. History stays visible.
function ended(text: string) {
  conn.leave();
  setSessionState("ended");
  setStatus("Disconnected");
  $("#ended-text").textContent = text;
  endedEl.hidden = false;
  dropzone.hidden = true;
  leaveBtn.hidden = true; // nothing left to disconnect from
  scheduleRender();
}

function goHome() {
  transfers.cancelAll();
  conn.leave();
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
  if (!files.length || !conn.isOpen()) return;
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
  let folders = 0;
  for (const entry of [...(e.dataTransfer?.items ?? [])]) {
    if (entry.kind !== "file") continue;
    if (entry.webkitGetAsEntry?.()?.isDirectory) folders++;
    else {
      const f = entry.getAsFile();
      if (f) files.push(f);
    }
  }
  if (folders) showError("Folders can't be sent. Zip the folder first, then send the zip.");
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
  conn.join($<HTMLInputElement>("#token-input").value.trim());
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
let pendingSends: Saved[] = [];
let rejoined = false;

async function showUnfinished() {
  const rec = loadRecords();
  if (!rec) return;
  resumeSession = rec.session;
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
  conn.rejoin(resumeSession); // shows the connected screen as "Reconnecting…"
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
    saveRecords([]);
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
  saveRecords([]);
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
if (stored) {
  history.replaceState(null, "", location.pathname + location.search);
  void openStoredLink(stored);
} else if (linkToken) {
  history.replaceState(null, "", location.pathname + location.search);
  $<HTMLInputElement>("#token-input").value = linkToken;
  view("none");
  setStatus("Connecting");
  conn.join(linkToken);
} else {
  void showUnfinished();
  void initStored();
}
