import { downloadStored, fetchStored, removeUpload, upload, type Stored, type Uploaded } from "./store";
import { chooseSink } from "./sinks";
import { drawQr } from "./qr";
import { fmtSize } from "./format";
import { flashCopied, setStatus, showError } from "./ui";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const when = (iso: string) => new Date(iso).toLocaleString();

function progress(el: HTMLProgressElement, text: HTMLElement) {
  return (done: number, total: number) => {
    el.max = total || 1;
    el.value = done;
    text.textContent = `${total ? Math.floor((done / total) * 100) : 100}% · ${fmtSize(done)} of ${fmtSize(total)}`;
  };
}

// "Upload for later": shown only when the server has Stored mode switched on.
export async function initStored() {
  let maxBytes = 0;
  try {
    const info = await (await fetch("/store")).json();
    if (!info.enabled) return;
    maxBytes = info.maxBytes;
  } catch {
    return;
  }
  $("#stored").hidden = false;
  const fileInput = $<HTMLInputElement>("#store-file");
  const keyInput = $<HTMLInputElement>("#store-key");
  const button = $<HTMLButtonElement>("#store-upload");
  const bar = $<HTMLProgressElement>("#store-progress");
  const barText = $("#store-pct");
  let done: Uploaded | undefined;

  button.addEventListener("click", async () => {
    const file = fileInput.files?.[0];
    showError("");
    if (!file || !keyInput.value) return showError("Choose a file and enter the passcode.");
    if (file.size > maxBytes) return showError(`This file is over the ${fmtSize(maxBytes)} limit for stored files.`);
    button.disabled = true;
    bar.hidden = barText.hidden = false;
    setStatus("Uploading");
    try {
      done = await upload(file, keyInput.value, progress(bar, barText));
      $<HTMLInputElement>("#store-link").value = done.link;
      drawQr($<SVGSVGElement & HTMLElement>("#store-qr"), done.link);
      $("#store-expiry").textContent = `Available until ${when(done.expiresAt)}`;
      $("#store-result").hidden = false;
      setStatus("Uploaded. You can close this page.");
    } catch (err) {
      setStatus("Not connected");
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      bar.hidden = barText.hidden = true;
      button.disabled = false;
    }
  });

  $("#store-copy").addEventListener("click", () => {
    const link = $<HTMLTextAreaElement>("#store-link");
    navigator.clipboard.writeText(link.value).then(() => flashCopied($("#store-copy")), () => link.select());
  });

  $("#store-delete").addEventListener("click", async () => {
    if (!done) return;
    await removeUpload(done.id, done.writeToken).catch(() => {});
    done = undefined;
    $("#store-result").hidden = true;
    setStatus("Deleted");
  });
}

// A stored-file link: show what is there and let the person download it.
export async function openStoredLink(link: { id: string; key: string }) {
  $("#home").hidden = true;
  $("#download").hidden = false;
  setStatus("Looking for the file");
  let stored: Stored & { key: CryptoKey };
  try {
    stored = await fetchStored(link.id, link.key);
  } catch (err) {
    setStatus("Not available");
    showError(err instanceof Error ? err.message : String(err));
    $("#download").hidden = true; // nothing to show: just the error and "Start a new transfer"
    return;
  }
  $("#dl-name").textContent = stored.meta.name; // textContent only: the name comes from the uploader
  $("#dl-size").textContent = fmtSize(stored.meta.size);
  $("#dl-expiry").textContent = when(stored.expiresAt);
  const button = $<HTMLButtonElement>("#dl-button");
  button.hidden = false;
  setStatus("Ready to download");

  button.addEventListener("click", async () => {
    showError("");
    let sink;
    try {
      sink = await chooseSink(stored.meta); // first await in the handler: the save picker needs the click
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return; // picker cancelled
      return showError(err instanceof Error ? err.message : String(err));
    }
    button.disabled = true;
    const bar = $<HTMLProgressElement>("#dl-progress");
    const text = $("#dl-pct");
    bar.hidden = text.hidden = false;
    setStatus("Downloading");
    try {
      await downloadStored(link.id, stored, sink, progress(bar, text));
      setStatus("File saved");
    } catch (err) {
      setStatus("Not saved");
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      button.disabled = false;
    }
  });
}
