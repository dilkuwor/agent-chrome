const DEFAULT_PORT = 47321;
const GRANT_MS = 90000;

const pendingGrants = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen();
});

ensureOffscreen();
chrome.alarms.create("grok-chrome-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {
  ensureOffscreen();
  ensurePolling();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;
  if (message.type === "job") {
    handleJob(message.job)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "allow-origin") {
    allowOrigin(message.origin).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "deny-origin") {
    const entry = pendingGrants.get(message.origin);
    if (entry) entry.finish(false);
    chrome.storage.local.set({ pendingOrigin: nextPending() });
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "revoke-origin") {
    revokeOrigin(message.origin).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "pump") {
    ensurePolling();
    sendResponse({ ok: true });
    return false;
  }
});

let bridgeGeneration = 0;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length > 0) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Hold a localhost connection so Grok and AGY can drive this browser.",
    });
  } catch (error) {
    if (String(error).includes("single offscreen")) return;
    console.error("offscreen document failed", error);
  }
}

let pollPromise = null;

function ensurePolling() {
  if (pollPromise) return;
  const gen = ++bridgeGeneration;
  pollPromise = pollLoop(gen).finally(() => {
    pollPromise = null;
  });
}

ensurePolling();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.token || changes.port) ensurePolling();
});

async function pollLoop(gen) {
  while (gen === bridgeGeneration) {
    const stored = await chrome.storage.local.get(["token", "port"]);
    const authToken = String(stored.token || "").trim();
    const port = Number(stored.port) || DEFAULT_PORT;
    if (!authToken) {
      await chrome.storage.local.set({ bridgeStatus: "needs-token", bridgeDetail: "Paste the pairing token" });
      await sleep(1000);
      continue;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: "{}",
      });
      if (gen !== bridgeGeneration) return;
      if (response.status === 401) {
        await chrome.storage.local.set({
          bridgeStatus: "bad-token",
          bridgeDetail: "Token does not match ~/.grok-in-chrome/token",
        });
        await sleep(2000);
        continue;
      }
      if (!response.ok) {
        await chrome.storage.local.set({ bridgeStatus: "offline", bridgeDetail: `Bridge returned HTTP ${response.status}` });
        await sleep(1500);
        continue;
      }
      await chrome.storage.local.set({ bridgeStatus: "connected", bridgeDetail: `localhost:${port}` });
      const data = await response.json();
      if (!data.job) continue;
      const result = await handleJob(data.job);
      await fetch(`http://127.0.0.1:${port}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ id: data.job.id, result }),
      });
    } catch {
      if (gen !== bridgeGeneration) return;
      await chrome.storage.local.set({
        bridgeStatus: "offline",
        bridgeDetail: "Start a Grok or AGY session, then check that the chrome MCP server is enabled.",
      });
      await sleep(1500);
    }
  }
}

async function handleJob(job) {
  const tool = job?.tool;
  const args = job?.args || {};
  try {
    const outcome = await runTool(tool, args);
    await logActivity(tool, summarize(tool, args));
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logActivity(tool || "tool", message);
    return { ok: false, error: message };
  }
}

async function runTool(tool, args) {
  if (tool === "tabs_context") return tabsContext();
  if (tool === "tabs_create") return tabsCreate(args);
  if (tool === "tabs_close") return tabsClose(args);
  if (tool === "navigate") return navigate(args);
  if (tool === "screenshot") return screenshot(args);
  if (tool === "run_script") return runScript(args);
  if (["read_page", "get_page_text", "form_input", "click", "type_text", "press_key", "scroll"].includes(tool)) {
    const tabId = requireTab(args.tabId);
    await assertTabAllowed(tabId);
    await markGroup(tabId);
    if (["form_input", "click", "type_text", "press_key", "scroll"].includes(tool)) await focusTab(tabId);
    const response = await sendToPage(tabId, { type: "page", action: tool, args });
    if (!response?.ok) throw new Error(response?.error || `${tool} failed`);
    let text = response.text || "Done.";
    if (tool === "click" || tool === "press_key") {
      await sleep(300);
      const tab = await chrome.tabs.get(tabId);
      text = `${text}\nURL now: ${tab.url || ""}`;
    }
    return { ok: true, text };
  }
  throw new Error(`Unknown tool ${tool}`);
}

async function tabsContext() {
  const tabs = await chrome.tabs.query({});
  const lines = tabs.slice(0, 40).map((tab) => {
    const mark = tab.active ? " active" : "";
    return `tab ${tab.id} window ${tab.windowId}${mark} ${oneLine(tab.title)} ${tab.url || ""}`;
  });
  const extra = tabs.length > 40 ? `\n${tabs.length - 40} more tabs not shown.` : "";
  return {
    ok: true,
    text: `Open tabs (${tabs.length}):\n${lines.join("\n") || "(none)"}${extra}\n\nUse tabs_create unless the user told you to use one of these tabs.`,
  };
}

async function tabsCreate(args) {
  const url = args.url ? String(args.url) : "about:blank";
  if (url !== "about:blank") await ensureHttpAllowed(url);
  const tab = await chrome.tabs.create({ url, active: args.active !== false });
  await markGroup(tab.id);
  if (url !== "about:blank") await waitForNavigation(tab.id, url);
  const loaded = await chrome.tabs.get(tab.id);
  return { ok: true, text: `Created tab ${loaded.id}\nTitle: ${loaded.title || ""}\nURL: ${loaded.url || ""}` };
}

async function tabsClose(args) {
  const tabId = requireTab(args.tabId);
  await chrome.tabs.remove(tabId);
  return { ok: true, text: `Closed tab ${tabId}.` };
}

async function navigate(args) {
  const tabId = requireTab(args.tabId);
  const url = String(args.url || "");
  await ensureHttpAllowed(url);
  await markGroup(tabId);
  await focusTab(tabId);
  await chrome.tabs.update(tabId, { url });
  await waitForNavigation(tabId, url);
  const tab = await chrome.tabs.get(tabId);
  return { ok: true, text: `Navigated tab ${tab.id}\nTitle: ${tab.title || ""}\nURL: ${tab.url || ""}` };
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
}

async function screenshot(args) {
  const tabId = requireTab(args.tabId);
  const tab = await assertTabAllowed(tabId);
  await markGroup(tabId);
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  await sleep(250);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 });
  const imageBase64 = String(dataUrl).replace(/^data:image\/jpeg;base64,/, "");
  return { ok: true, text: `Captured the visible area of tab ${tabId}.`, imageBase64, mimeType: "image/jpeg" };
}

async function runScript(args) {
  const tabId = requireTab(args.tabId);
  await assertTabAllowed(tabId);
  const code = String(args.code || "");
  if (!code.trim()) throw new Error("Missing code.");
  if (code.length > 20000) throw new Error("Script is too long.");
  let result;
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (source) => {
        const fn = new Function(source);
        return fn();
      },
      args: [code],
    });
    result = injected?.[0]?.result;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  let text;
  try {
    text = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    text = String(result);
  }
  return { ok: true, text: text === undefined ? "Script finished." : text.slice(0, 12000) };
}

async function assertTabAllowed(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const origin = httpOrigin(tab.url || "");
  if (!origin) {
    throw new Error(`Tab ${tabId} is on a page the extension cannot control (${tab.url || "unknown url"}).`);
  }
  await ensureAllowed(origin);
  return tab;
}

async function ensureHttpAllowed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("url must be an absolute http:// or https:// address.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must start with http:// or https://.");
  }
  await ensureAllowed(parsed.origin);
}

async function ensureAllowed(origin) {
  const stored = await chrome.storage.local.get(["allowAll", "allowedOrigins"]);
  if (stored.allowAll) return;
  const allowed = stored.allowedOrigins || [];
  if (allowed.includes(origin)) return;
  const granted = await requestGrant(origin);
  if (!granted) {
    throw new Error(`Site not allowed: ${origin}. Click the Grok in Chrome icon and choose Allow for this site.`);
  }
}

function requestGrant(origin) {
  const existing = pendingGrants.get(origin);
  if (existing) return existing.promise;
  let finish = () => {};
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => done(false), GRANT_MS);
    function done(ok) {
      clearTimeout(timer);
      pendingGrants.delete(origin);
      chrome.action.setBadgeText({ text: pendingGrants.size ? "!" : "" });
      chrome.storage.local.set({ pendingOrigin: nextPending() });
      resolve(ok);
    }
    finish = done;
  });
  pendingGrants.set(origin, { promise, finish });
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#b5483d" });
  chrome.storage.local.set({ pendingOrigin: origin });
  chrome.windows.getCurrent().then((window) => {
    if (window?.id != null) chrome.sidePanel.open({ windowId: window.id }).catch(() => {});
  }).catch(() => {});
  return promise;
}

function nextPending() {
  const next = pendingGrants.keys().next();
  return next.done ? "" : next.value;
}

async function allowOrigin(origin) {
  if (!origin) throw new Error("Missing origin.");
  const stored = await chrome.storage.local.get(["allowedOrigins"]);
  const allowed = stored.allowedOrigins || [];
  if (!allowed.includes(origin)) {
    allowed.push(origin);
    await chrome.storage.local.set({ allowedOrigins: allowed });
  }
  const entry = pendingGrants.get(origin);
  if (entry) entry.finish(true);
}

async function revokeOrigin(origin) {
  const stored = await chrome.storage.local.get(["allowedOrigins"]);
  const allowed = (stored.allowedOrigins || []).filter((item) => item !== origin);
  await chrome.storage.local.set({ allowedOrigins: allowed });
}

async function sendToPage(tabId, payload) {
  let lastError = "The page did not respond.";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, payload);
      if (response) return response;
      lastError = "The page returned an empty response.";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
  }
  throw new Error(`Could not reach the page. ${lastError}`.trim());
}

function waitForNavigation(tabId, url) {
  const expected = url.split("#")[0];
  return new Promise((resolve) => {
    let sawLoad = false;
    const timer = setTimeout(() => finish("timeout"), 20000);
    const poll = setInterval(() => {
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.status === "complete" && tab.url && tab.url.split("#")[0].startsWith(expected.slice(0, Math.min(expected.length, 180)))) {
          if (sawLoad || Date.now() > started + 400) finish("complete");
        }
      }).catch(() => finish("missing"));
    }, 200);
    const started = Date.now();
    function finish() {
      clearTimeout(timer);
      clearInterval(poll);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    function onUpdated(id, info) {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoad = true;
      if (info.status === "complete" && sawLoad) finish();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function markGroup(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const groups = await chrome.tabGroups.query({ title: "Grok", windowId: tab.windowId });
    if (groups[0]) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: groups[0].id });
    } else {
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, { title: "Grok", color: "blue" });
    }
  } catch {
    // Grouping is a hint. The tab still exists if the browser refuses it.
  }
}

async function logActivity(tool, detail) {
  const stored = await chrome.storage.local.get(["activity"]);
  const activity = stored.activity || [];
  activity.unshift({ t: Date.now(), tool: tool || "tool", detail: String(detail || "").slice(0, 180) });
  await chrome.storage.local.set({ activity: activity.slice(0, 30) });
}

function summarize(tool, args) {
  if (tool === "form_input") {
    const count = Array.isArray(args.fields) && args.fields.length ? args.fields.length : 1;
    return `filled ${count} field${count === 1 ? "" : "s"} on tab ${args.tabId}`;
  }
  if (tool === "type_text") return `typed on tab ${args.tabId}`;
  if (tool === "navigate") return `opened ${args.url} in tab ${args.tabId}`;
  if (tool === "tabs_create") return `opened ${args.url || "a blank tab"}`;
  if (tool === "click") return `clicked ${args.ref || args.selector || "an element"} on tab ${args.tabId}`;
  if (tool === "screenshot") return `captured tab ${args.tabId}`;
  if (tool === "run_script") return `ran a script on tab ${args.tabId}`;
  return `${tool} on tab ${args.tabId ?? ""}`.trim();
}

function requireTab(tabId) {
  if (typeof tabId !== "number" || !Number.isFinite(tabId)) {
    throw new Error("Missing tabId. Call tabs_context or tabs_create, then pass that tab id.");
  }
  return tabId;
}

function httpOrigin(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
