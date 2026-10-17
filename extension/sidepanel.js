const statusEl = document.querySelector("#status");
const pendingEl = document.querySelector("#pending");
const pendingBadge = document.querySelector("#pending-badge");
const pendingText = document.querySelector("#pending-text");
const tokenState = document.querySelector("#token-state");
const tokenInput = document.querySelector("#token");
const portInput = document.querySelector("#port");
const siteEl = document.querySelector("#site");
const tabCdpEl = document.querySelector("#tab-cdp");
const allowSite = document.querySelector("#allow-site");
const allowAll = document.querySelector("#allow-all");
const allowedEl = document.querySelector("#allowed");
const activityEl = document.querySelector("#activity");
const diagSummary = document.querySelector("#diag-summary");
const diagList = document.querySelector("#diag-list");
const refreshDiag = document.querySelector("#refresh-diag");

let currentOrigin = "";
let currentTabId = null;

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
refreshDiag.addEventListener("click", () => renderDiagnostics());

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
    "pendingHighRisk",
    "allowAll",
    "allowedOrigins",
    "activity",
  ]);

  tokenState.textContent = data.token ? "Token saved" : "No token configured yet";
  if (data.port) portInput.value = data.port;
  const state = data.bridgeStatus || (data.token ? "offline" : "needs-token");
  statusEl.className = `status ${state}`;
  statusEl.textContent = labelFor(state);
  statusEl.title = data.bridgeDetail || "";

  if (data.pendingOrigin) {
    pendingEl.classList.remove("hidden");
    if (data.pendingHighRisk) {
      pendingEl.classList.add("high-risk");
      pendingBadge.textContent = "High-Risk Sensitive Domain";
    } else {
      pendingEl.classList.remove("high-risk");
      pendingBadge.textContent = "Permission Required";
    }
    pendingText.dataset.origin = data.pendingOrigin;
    pendingText.textContent = `Allow agent control on ${data.pendingOrigin}?`;
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
      button.textContent = "Revoke";
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
    for (const entry of activity.slice(0, 15)) {
      const time = new Date(entry.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      activityEl.append(item(`${time}  ${entry.detail || entry.tool}`));
    }
  }

  renderSite();
}

async function renderSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id || null;
  currentOrigin = originOf(tab?.url || "");
  siteEl.textContent = currentOrigin || (tab?.url ? tab.url.slice(0, 50) : "No active web tab");
  allowSite.disabled = !currentOrigin;
  renderDiagnostics();
}

async function renderDiagnostics() {
  if (!currentTabId) {
    tabCdpEl.textContent = "CDP: No tab";
    diagSummary.textContent = "No active tab";
    diagList.replaceChildren();
    return;
  }

  try {
    const diag = await chrome.runtime.sendMessage({ type: "get-tab-diagnostics", tabId: currentTabId });
    if (!diag) return;

    tabCdpEl.textContent = diag.cdpAttached ? "CDP: Active (Trusted Events)" : "CDP: Ready";

    const logs = diag.logs || [];
    const net = diag.network || [];
    diagSummary.textContent = `${logs.length} console log(s), ${net.length} network request(s)`;

    diagList.replaceChildren();
    if (!logs.length && !net.length) {
      diagList.append(item("No errors or logs recorded", "empty"));
      return;
    }

    for (const l of logs.slice(0, 8)) {
      const row = document.createElement("li");
      if (l.type === "error") row.className = "error";
      else if (l.type === "warn") row.className = "warn";
      row.textContent = `[${l.type}] ${l.text}`;
      diagList.append(row);
    }
  } catch {
    diagSummary.textContent = "Diagnostics unavailable";
  }
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
