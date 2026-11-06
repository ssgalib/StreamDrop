"use strict";
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// The whole surface the page gets. The page only ever handles strings and bytes through this.
const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);
const info = ipcRenderer.sendSync("app:info");

contextBridge.exposeInMainWorld("streamdropApp", {
  ...info,
  pathForFile: (file) => {
    const p = webUtils.getPathForFile(file);
    return p ? ipcRenderer.sendSync("file:grant", p) : "";
  },
  record: {
    getItem: () => ipcRenderer.sendSync("record:get"),
    setItem: (_, value) => ipcRenderer.invoke("record:set", value),
    removeItem: () => ipcRenderer.invoke("record:set", null),
  },
  devices: {
    list: call("devices:list"),
    add: call("devices:add"),
    key: call("devices:key"),
    update: call("devices:update"),
    remove: call("devices:remove"),
  },
  receipts: { list: call("receipts:list") },
  sink: {
    open: call("sink:open"),
    write: call("sink:write"),
    checkpoint: call("sink:checkpoint"),
    close: call("sink:close"),
    abort: call("sink:abort"),
    offset: call("sink:offset"),
    clean: call("sink:clean"),
  },
  file: {
    read: call("file:read"),
    stat: call("file:stat"),
    pickFolder: call("file:pickFolder"),
    walk: call("file:walk"),
  },
  settings: {
    get: call("settings:get"),
    setAutostart: call("settings:setAutostart"),
    pickDownloads: call("settings:pickDownloads"),
  },
  notify: (title, body) => ipcRenderer.send("app:notify", title, body),
  busy: (on) => ipcRenderer.send("app:busy", on),
});
