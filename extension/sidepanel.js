const statusEl = document.querySelector("#status");
const pendingEl = document.querySelector("#pending");
const pendingText = document.querySelector("#pending-text");
const tokenState = document.querySelector("#token-state");
const tokenInput = document.querySelector("#token");
const portInput = document.querySelector("#port");
const siteEl = document.querySelector("#site");
const allowSite = document.querySelector("#allow-site");
const allowAll = document.querySelector("#allow-all");
const allowedEl = document.querySelector("#allowed");
const activityEl = document.querySelector("#activity");

let currentOrigin = "";

document.querySelector("#save-token").addEventListener("click", saveToken);
document.querySelector("#token-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  tokenInput.value = (await file.text()).trim();
});
document.querySelector("#allow").addEventListener("click", () => decide(true));
document.querySelector("#deny").addEventListener("click", () => decide(false));
allowSite.addEventListener("click", () => {
  if (currentOrigin) chrome.runtime.sendMessage({ type: "allow-origin", origin: currentOrigin });
});
allowAll.addEventListener("change", () => {
  chrome.storage.local.set({ allowAll: allowAll.checked });
});

chrome.storage.onChanged.addListener(() => {
  render();
});
chrome.tabs.onActivated.addListener(() => renderSite());
chrome.tabs.onUpdated.addListener(() => renderSite());

render();

async function saveToken() {
  const token = tokenInput.value.trim();
  const port = Number(portInput.value) || 47321;
  if (!token) return;
  await chrome.storage.local.set({ token, port });
  tokenInput.value = "";
  render();
}

function decide(allow) {
  const origin = pendingText.dataset.origin;
  if (!origin) return;
  chrome.runtime.sendMessage({ type: allow ? "allow-origin" : "deny-origin", origin });
}

async function render() {
  const data = await chrome.storage.local.get([
    "token",
    "port",
    "bridgeStatus",
    "bridgeDetail",
    "pendingOrigin",
    "allowAll",
    "allowedOrigins",
    "activity",
  ]);
  tokenState.textContent = data.token ? "Token saved" : "No token yet";
  if (data.port) portInput.value = data.port;
  const state = data.bridgeStatus || (data.token ? "offline" : "needs-token");
  statusEl.className = `status ${state}`;
  statusEl.textContent = labelFor(state);
  statusEl.title = data.bridgeDetail || "";

  if (data.pendingOrigin) {
    pendingEl.classList.remove("hidden");
    pendingText.dataset.origin = data.pendingOrigin;
    pendingText.textContent = `Allow ${data.pendingOrigin}? The agent is waiting.`;
  } else {
    pendingEl.classList.add("hidden");
    pendingText.dataset.origin = "";
  }

  allowAll.checked = Boolean(data.allowAll);
  const origins = data.allowedOrigins || [];
  allowedEl.replaceChildren();
  if (!origins.length) {
    allowedEl.append(item("None yet", "empty"));
  } else {
    for (const origin of origins) {
      const row = document.createElement("li");
      row.append(document.createTextNode(origin));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost";
      button.textContent = "Remove";
      button.addEventListener("click", () => chrome.runtime.sendMessage({ type: "revoke-origin", origin }));
      row.append(button);
      allowedEl.append(row);
    }
  }

  const activity = data.activity || [];
  activityEl.replaceChildren();
  if (!activity.length) {
    activityEl.append(item("No actions yet", "empty"));
  } else {
    for (const entry of activity.slice(0, 12)) {
      const time = new Date(entry.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      activityEl.append(item(`${time}  ${entry.detail || entry.tool}`));
    }
  }
  renderSite();
}

async function renderSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentOrigin = originOf(tab?.url || "");
  siteEl.textContent = currentOrigin || "This tab cannot be controlled.";
  allowSite.disabled = !currentOrigin;
}

function originOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function labelFor(state) {
  if (state === "connected") return "Connected";
  if (state === "bad-token") return "Bad token";
  if (state === "needs-token") return "Needs token";
  return "Offline";
}

function item(text, className) {
  const row = document.createElement("li");
  if (className) row.className = className;
  row.textContent = text;
  return row;
}
