// Shared by the page scripts: the status line (a coloured dot per state) and the error banner.
const statusEl = document.querySelector<HTMLElement>("#status")!;
const errorEl = document.querySelector<HTMLElement>("#error")!;

// First match wins. Words that match nothing ("Not connected", "Link expired") get the neutral dot.
const STATES: [RegExp, string][] = [
  [/^(Complete|File received|File saved|Uploaded|Deleted)/, "done"],
  [/^Reconnecting/, "paused"],
  [/^(Sending|Receiving|Uploading|Downloading|Finalizing|Resuming|Looking for)/, "active"],
  [/^(Connected|Ready)/, "ok"],
  [/^(Waiting|Connecting)/, "wait"],
];

export function setStatus(text: string) {
  statusEl.textContent = text;
  const state = STATES.find(([re]) => re.test(text))?.[1];
  if (state) statusEl.dataset.state = state;
  else delete statusEl.dataset.state;
}

// Shown only while there is something to say (the banner starts hidden).
export function showError(text: string) {
  errorEl.textContent = text;
  errorEl.hidden = !text;
}

// "Copy" becomes a green "Copied" with a tick for two seconds. The button keeps its icon and its <span>.
export function flashCopied(button: HTMLElement) {
  const label = button.querySelector("span");
  const icon = button.querySelector("use");
  if (!label || !icon) return;
  label.textContent = "Copied";
  icon.setAttribute("href", "#i-check");
  button.classList.add("is-done");
  setTimeout(() => {
    label.textContent = "Copy";
    icon.setAttribute("href", "#i-copy");
    button.classList.remove("is-done");
  }, 2000);
}
