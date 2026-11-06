import { type Connection } from "./connection";
import { createListener, createPairing, parseName, savedKeys } from "./saved";
import { fingerprint, parseMeta, type FileInfo, type Meta, type Sink } from "./transfer";
import type { Item, Saved, Transfers, Restored } from "./transfers";

// The desktop app: what only it can do, on top of the page. window.streamdropApp comes from desktop/preload.js
// and is absent in a browser. Nothing here runs on the website.
export type Device = { roomId: string; name: string; addedAt: number; lastSeen: number; alwaysAccept: boolean };
type Entry = { path: string; name: string; rel: string; size: number; mtime: number };
type RecoveryRecord = { session: string; p?: string; items: Saved[]; held?: boolean };

export type Bridge = {
  signalUrl: string;
  origin: string;
  deviceName: string;
  canSave: boolean; // false when this computer has no safe place for keys
  pathForFile(file: File): string;
  record: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  };
  receipts: { list(roomId: string): Promise<Saved[]> };
  devices: {
    list(): Promise<Device[]>;
    add(d: { roomId: string; name: string; k: Uint8Array }): Promise<void>;
    key(roomId: string): Promise<Uint8Array>;
    update(roomId: string, change: Partial<Pick<Device, "name" | "alwaysAccept" | "lastSeen">>): Promise<void>;
    remove(roomId: string): Promise<void>;
  };
  sink: {
    open(s: { id: string; name: string; rel?: string; size: number; subdir?: string; resume?: boolean; root?: string }): Promise<{ offset: number; root: string }>;
    write(id: string, data: ArrayBuffer): Promise<void>;
    checkpoint(id: string): Promise<void>;
    close(id: string): Promise<void>;
    abort(id: string, root?: string): Promise<void>;
    offset(id: string): Promise<number>;
    clean(): Promise<void>;
  };
  file: {
    read(path: string, start: number, end: number): Promise<ArrayBuffer>;
    stat(path: string): Promise<{ size: number; mtime: number } | null>;
    pickFolder(): Promise<string | null>;
    walk(path: string): Promise<Entry[]>;
  };
  settings: {
    get(): Promise<{ autostart: boolean; downloads: string }>;
    setAutostart(on: boolean): Promise<void>;
    pickDownloads(): Promise<string>;
  };
  notify(title: string, body: string): void;
  busy(on: boolean): void; // files are moving: don't let the computer sleep
};

export const app: Bridge | undefined = (window as any).streamdropApp;

const IDLE_MS = 2 * 60_000; // an open connection costs a phone battery: close it when nothing is happening
const WAIT_MS = 10 * 60_000; // a room lasts this long, so waiting longer means nothing
const AUTH_COOLDOWN = 30_000;
const ALWAYS_ACCEPT_LIMIT = 2 * 1024 ** 3;

let subdir: string | undefined; // the folder for files accepted without asking

export function appSinks(b: Bridge) {
  const sink = (id: string, root: string): Sink => ({
    root,
    resumable: true,
    write: (data) => b.sink.write(id, data),
    checkpoint: () => b.sink.checkpoint(id),
    close: () => b.sink.close(id),
    abort: () => b.sink.abort(id, root),
  });
  return {
    async chooseSink(m: FileInfo & Pick<Meta, "id" | "rel">) {
      const { root } = await b.sink.open({ id: m.id, name: m.name, rel: m.rel, size: m.size, subdir });
      return sink(m.id, root);
    },
    async openParts(id: string, name: string, _type?: string, savedRoot?: string) {
      const { offset, root } = await b.sink.open({ id, name, size: 0, resume: true, root: savedRoot });
      return { sink: sink(id, root), offset };
    },
    partsOffset: (id: string) => b.sink.offset(id),
    discardParts: (id: string) => b.sink.abort(id),
    cleanOpfs: () => b.sink.clean(),
  };
}

// A file reached by path, for what the page can't get a File for: folder contents, and files after a restart.
function pathFile(e: { path: string; name: string; size: number; mtime: number; rel?: string; type?: string }) {
  return {
    name: e.name, size: e.size, type: e.type ?? "", lastModified: e.mtime, rel: e.rel, path: e.path,
    slice: (start = 0, end = e.size) => ({ arrayBuffer: () => app!.file.read(e.path, start, Math.min(end, e.size)) }),
  } as unknown as File & { rel?: string };
}

export const pathOf = (f: File) => (f as any).path ?? (app!.pathForFile(f) || undefined);

export type AppHooks = Awaited<ReturnType<typeof initApp>>;

type Context = {
  conn: Connection;
  transfers: Transfers;
  ended(text: string): void;
  offerFiles(files: File[]): void;
  showError(text: string): void;
  setStatus(text: string): void;
  setSessionState(s: "open" | "paused" | "ended"): void;
  view(v: "home" | "session"): void;
  records(): RecoveryRecord | null;
};

export async function initApp(b: Bridge, c: Context) {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const { conn, transfers } = c;
  const peerEl = $("#peer-state");
  const listEl = $("#devices");
  const saveEl = $("#save-offer");
  const tempEl = $("#temporary");

  let devices = await b.devices.list();
  let current: Device | undefined; // the saved device we are connected, or connecting, to
  let peerName: string | undefined;
  let pairing: ReturnType<typeof createPairing> | undefined;
  let lastActive = Date.now();
  let held = false;
  let wait: ReturnType<typeof setTimeout> | undefined;
  const cooling = new Map<string, number>(); // room id -> when a failed proof may be retried
  const notified = new Set<string>();
  let resumeRecord: ((rec: RecoveryRecord) => Promise<boolean>) | undefined;

  const listener = createListener(b.signalUrl, () => devices.map((d) => d.roomId), onRing);

  async function reload() {
    devices = await b.devices.list();
    drawDevices();
    listener.update();
  }

  async function connect(d: Device, resuming = false) {
    if (Date.now() < (cooling.get(d.roomId) ?? 0)) return c.showError(`Couldn't verify ${d.name}. Try again in a moment.`);
    current = d;
    for (const receipt of await b.receipts.list(d.roomId)) {
      if (parseMeta(receipt) && (receipt.state === "cancelled" || receipt.state === "done" && receipt.dir === "receive")) transfers.restore(receipt, {});
    }
    subdir = d.alwaysAccept ? d.name : undefined;
    const { ka } = await savedKeys(await b.devices.key(d.roomId));
    c.showError("");
    conn.connectSaved(d.roomId, ka, resuming);
    await transfers.persist();
    clearTimeout(wait);
    wait = setTimeout(() => {
      if (!conn.isOpen()) c.ended(`${d.name} didn't answer.`);
    }, WAIT_MS);
  }

  function onRing(id: string) {
    const d = devices.find((x) => x.roomId === id);
    const rec = c.records();
    // Busy covers our own call too: the server rings both devices of a pair.
    if (d && (!held || rec?.session === id) && conn.phase === "idle" && Date.now() >= (cooling.get(id) ?? 0)) {
      const attempt = rec?.held && rec.session === id ? resumeRecord?.({ ...rec, held: false }) : connect(d, transfers.hasUnfinished());
      void attempt?.catch(() => c.showError("Couldn't resume these transfers. Reconnect the drive and try Resume."));
    }
  }

  function row(d: Device) {
    const li = document.createElement("li");
    li.className = "device";
    li.dataset.room = d.roomId;
    const name = document.createElement("span");
    name.className = "device-name";
    name.textContent = d.name; // untrusted: textContent only
    const go = document.createElement("button");
    go.type = "button";
    go.className = "btn btn-sm btn-primary device-connect";
    go.textContent = "Connect";
    go.addEventListener("click", () => void connect(d));

    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "btn btn-sm btn-outline device-rename";
    rename.textContent = "Rename";
    rename.addEventListener("click", () => {
      const input = document.createElement("input");
      input.className = "input";
      input.value = d.name;
      input.maxLength = 64;
      input.setAttribute("aria-label", `New name for ${d.name}`);
      const done = () => {
        const v = parseName({ name: input.value });
        void (v && v !== d.name ? b.devices.update(d.roomId, { name: v }).then(reload) : reload());
      };
      input.addEventListener("blur", done);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
      name.replaceWith(input);
      input.select();
    });

    const label = document.createElement("label");
    label.className = "device-always";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = d.alwaysAccept;
    box.addEventListener("change", () => void b.devices.update(d.roomId, { alwaysAccept: box.checked }).then(reload));
    label.append(box, " Always accept files up to 2 GiB");

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn-sm btn-outline device-remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      if (current?.roomId === d.roomId && conn.isOpen()) {
        try { conn.send({ t: "unpair" }); } catch { /* it finds out when its proof fails */ }
      }
      await b.devices.remove(d.roomId);
      if (current?.roomId === d.roomId) c.ended("This device was removed.");
      await reload();
    });
    li.append(name, go, rename, remove, label);
    return li;
  }

  function drawDevices() {
    $("#saved").hidden = !devices.length;
    listEl.replaceChildren(...devices.map(row));
  }

  function startPairing() {
    const p = conn.inviteKey;
    saveEl.hidden = true;
    pairing = undefined;
    // Only a pairing verified by the invite key can be saved, and both ends must be able to keep it.
    if (!conn.verified || !p || current || !b.canSave || !conn.peerCaps.includes("save")) return;
    pairing = createPairing({
      role: conn.role,
      p,
      fingerprints: () => conn.fingerprints(),
      send: (m) => conn.send(m),
      async saved(k) {
        const { roomId } = await savedKeys(k);
        await b.devices.add({ roomId, name: peerName ?? "Unnamed device", k });
        saveEl.hidden = true;
        await reload();
        current = devices.find((d) => d.roomId === roomId);
      },
      failed() {
        saveEl.hidden = true;
        c.showError("The devices couldn't be saved. Connect them again and retry.");
      },
    });
    saveEl.hidden = false;
    $("#save-text").textContent = `Save ${peerName ?? "this device"}?`;
  }

  $("#save-device").addEventListener("click", () => {
    pairing?.save();
    $("#save-text").textContent = "Waiting for the other device to save too…";
  });
  $("#send-folder").addEventListener("click", async () => {
    const path = await b.file.pickFolder();
    if (path) await sendPaths([path]);
  });

  async function sendPaths(paths: string[]) {
    for (const path of paths) {
      try {
        const entries = await b.file.walk(path);
        if (!entries.length) c.showError("That folder has no files to send.");
        // an offer takes at most 500 files
        for (let i = 0; i < entries.length; i += 500) c.offerFiles(entries.slice(i, i + 500).map(pathFile));
      } catch (err) {
        c.showError(`Couldn't read that folder: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  const settings = await b.settings.get();
  const auto = $<HTMLInputElement>("#autostart");
  auto.checked = settings.autostart;
  auto.addEventListener("change", () => void b.settings.setAutostart(auto.checked));
  $("#downloads").textContent = settings.downloads;
  $("#pick-downloads").addEventListener("click", async () => {
    $("#downloads").textContent = await b.settings.pickDownloads();
  });
  $("#app-settings").hidden = false;
  $("#send-folder").hidden = false;
  drawDevices();

  // Closing an idle connection is not an error: the pair stays, and the next send reconnects.
  setInterval(() => {
    if (!current || !conn.isOpen() || transfers.hasUnfinished() || Date.now() - lastActive < IDLE_MS) return;
    try { conn.send({ t: "bye", reason: "idle" }); } catch { /* gone already */ }
    setTimeout(() => c.ended("Closed the idle connection. It reconnects when you next connect."), 150);
  }, 5000);

  const hooks = {
    ready() { listener.update(); },
    setHeld(value: boolean) { held = value; },
    async resumeConnection(roomId: string) {
      const d = devices.find((x) => x.roomId === roomId);
      if (!d) throw new Error("This device is no longer saved. Connect it again.");
      held = false;
      await connect(d, true);
    },
    peerName: () => current?.name ?? undefined,
    savedRoom: () => current?.roomId, // after a restart, a saved device is found this way, even if it was saved mid-session
    listeners(n: number) {
      // Our own listener is one of them, because both devices of a pair use the same id.
      if (current) peerEl.textContent = n > 1 ? `Connecting to ${current.name}…` : `Waiting for ${current.name} to open StreamDrop`;
    },
    opened(reconnected: boolean) {
      clearTimeout(wait);
      lastActive = Date.now();
      c.setSessionState("open");
      tempEl.hidden = conn.verified;
      conn.send({ t: "name", name: b.deviceName });
      if (current) void b.devices.update(current.roomId, { lastSeen: Date.now() });
      if (!reconnected) startPairing();
    },
    // True when the message was for the app, not the engine.
    message(data: string | ArrayBuffer) {
      if (typeof data !== "string" || !data.startsWith('{"t":"')) return false;
      let m: any;
      try { m = JSON.parse(data); } catch { return false; }
      if (m.t === "name") {
        peerName = parseName(m) ?? peerName;
        if (pairing && !saveEl.hidden && !pairing.started) $("#save-text").textContent = `Save ${peerName ?? "this device"}?`;
        return true;
      }
      if (m.t === "unpair") {
        if (current) void b.devices.remove(current.roomId).then(() => { c.ended("This device was removed."); return reload(); });
        return true;
      }
      return pairing?.message(m) ?? false;
    },
    refused() {
      if (current) cooling.set(current.roomId, Date.now() + AUTH_COOLDOWN);
    },
    ended() {
      transfers.forgetReceipts();
      clearTimeout(wait);
      current = undefined;
      peerName = undefined;
      pairing = undefined;
      subdir = undefined;
      saveEl.hidden = tempEl.hidden = true;
    },
    rendered(items: Item[]) {
      const moving = items.some((i) => i.state === "active");
      b.busy(moving);
      if (moving) lastActive = Date.now();
      const offered = items.filter((i) => i.dir === "receive" && i.state === "offered");
      if (current?.alwaysAccept) {
        for (const it of offered) {
          if (it.size <= ALWAYS_ACCEPT_LIMIT) void transfers.accept(it.id);
        }
      }
      const fresh = offered.filter((i) => !notified.has(i.id));
      for (const it of fresh) notified.add(it.id);
      if (fresh.length) {
        lastActive = Date.now();
        const who = current?.name ?? peerName ?? "A device";
        b.notify("StreamDrop", fresh.length === 1 ? `${who} wants to send you ${fresh[0].name}` : `${who} wants to send you ${fresh.length} files`);
      }
    },
    sendFolders: (files: File[]) => sendPaths(files.map((f) => b.pathForFile(f)).filter(Boolean)),
    // After a restart: carry on with a saved device by ourselves. Ad hoc connections go through the page's usual prompt.
    async resume(rec: RecoveryRecord | null) {
      held = !!rec?.held;
      if (held) return false;
      const d = rec && devices.find((x) => x.roomId === rec.session);
      if (!rec || !rec.items.length) return false;
      const sinks = appSinks(b);
      const entries: Restored[] = [];
      const outcomes = (await b.receipts.list(rec.session)).filter((r) => parseMeta(r) && (r.state === "cancelled" || r.state === "done" && r.dir === "receive"));
      const recovered = new Map(rec.items.map((it) => [it.id, it]));
      for (const outcome of outcomes) recovered.set(outcome.id, outcome);
      for (const it of recovered.values()) {
        if (it.state === "cancelled") {
          if (it.dir === "receive") await b.sink.abort(it.id, it.root);
          entries.push({ saved: it });
          continue;
        }
        if (it.state === "done" || it.state === "offered" && it.dir === "receive") {
          entries.push({ saved: it });
          continue;
        }
        if (it.dir === "receive") {
          const { sink, offset } = await sinks.openParts(it.id, it.name, it.type, it.root);
          entries.push({ saved: it, sink, offset });
          continue;
        }
        const st = it.path ? await b.file.stat(it.path).catch(() => null) : null;
        if (!st || st.size !== it.size) {
          entries.push({ saved: it }); // retain its source reference so a restart never erases the rest of the queue
          c.showError(`Couldn't reopen ${it.name}. Restore the original file at its previous location and restart StreamDrop.`);
          continue;
        }
        const file = pathFile({ path: it.path!, name: it.name, size: it.size, mtime: st.mtime, type: it.type, rel: it.rel });
        if ((await fingerprint(file).catch(() => null)) === it.fp) entries.push({ saved: it, file });
        else {
          entries.push({ saved: it });
          c.showError(`${it.name} has changed. Restore the original file and restart StreamDrop.`);
        }
      }
      await transfers.restoreAll(entries);
      if ([...recovered.values()].every((it) => it.state === "done" || it.state === "cancelled")) return false;
      if (d) await connect(d, true);
      else conn.rejoin(rec.session, rec.p);
      return true;
    },
  };
  resumeRecord = hooks.resume;
  return hooks;
}
