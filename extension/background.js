const DEFAULT_PORT = 47321;
const GRANT_MS = 90000;

const pendingGrants = new Map();
const cdpSessions = new Set();
const tabConsoleLogs = new Map();
const tabNetworkLogs = new Map();
const tabOpenDialogs = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen();
});

ensureOffscreen();
chrome.alarms.create("agent-chrome-keepalive", { periodInMinutes: 1 });
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
  if (message.type === "get-tab-diagnostics") {
    const tabId = message.tabId;
    sendResponse({
      logs: tabConsoleLogs.get(tabId) || [],
      network: tabNetworkLogs.get(tabId) || [],
      dialog: tabOpenDialogs.get(tabId) || null,
      cdpAttached: cdpSessions.has(tabId),
    });
    return false;
  }
});

// CDP Event Listeners
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;

  if (method === "Page.javascriptDialogOpening") {
    tabOpenDialogs.set(tabId, {
      type: params.type,
      message: params.message,
      defaultPrompt: params.defaultPrompt,
      timestamp: Date.now(),
    });
    // Auto-accept simple alerts so the browser tab does not freeze
    if (params.type === "alert") {
      chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      tabOpenDialogs.delete(tabId);
    }
  }

  if (method === "Page.javascriptDialogClosed") {
    tabOpenDialogs.delete(tabId);
  }

  if (method === "Runtime.consoleAPICalled") {
    const list = tabConsoleLogs.get(tabId) || [];
    const text = (params.args || []).map((arg) => arg.value ?? arg.description ?? JSON.stringify(arg)).join(" ");
    list.unshift({
      timestamp: Date.now(),
      type: params.type || "log",
      text: text.slice(0, 1000),
    });
    if (list.length > 100) list.pop();
    tabConsoleLogs.set(tabId, list);
  }

  if (method === "Runtime.exceptionThrown") {
    const list = tabConsoleLogs.get(tabId) || [];
    const desc = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "Unknown exception";
    list.unshift({
      timestamp: Date.now(),
      type: "error",
      text: desc.slice(0, 1000),
    });
    if (list.length > 100) list.pop();
    tabConsoleLogs.set(tabId, list);
  }

  if (method === "Network.responseReceived") {
    const list = tabNetworkLogs.get(tabId) || [];
    const res = params.response || {};
    list.unshift({
      timestamp: Date.now(),
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      mimeType: res.mimeType,
      type: params.type,
    });
    if (list.length > 100) list.pop();
    tabNetworkLogs.set(tabId, list);
  }

  if (method === "Network.loadingFailed") {
    const list = tabNetworkLogs.get(tabId) || [];
    list.unshift({
      timestamp: Date.now(),
      status: 0,
      statusText: "Failed",
      url: params.requestId,
      errorText: params.errorText,
      type: params.type,
    });
    if (list.length > 100) list.pop();
    tabNetworkLogs.set(tabId, list);
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) cdpSessions.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cdpSessions.delete(tabId);
  tabConsoleLogs.delete(tabId);
  tabNetworkLogs.delete(tabId);
  tabOpenDialogs.delete(tabId);
});

async function attachCdp(tabId) {
  if (cdpSessions.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    cdpSessions.add(tabId);
    await Promise.allSettled([
      chrome.debugger.sendCommand({ tabId }, "Page.enable"),
      chrome.debugger.sendCommand({ tabId }, "Runtime.enable"),
      chrome.debugger.sendCommand({ tabId }, "Network.enable"),
      chrome.debugger.sendCommand({ tabId }, "DOM.enable"),
    ]);
    return true;
  } catch (err) {
    console.warn(`[Agent in Chrome] CDP attach failed on tab ${tabId}: ${err.message}`);
    return false;
  }
}

async function detachCdp(tabId) {
  if (!cdpSessions.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
  cdpSessions.delete(tabId);
}

let bridgeGeneration = 0;

async function ensureOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (contexts.length > 0) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Hold a localhost connection so the AI agent can drive this browser.",
    });
  } catch (error) {
    if (String(error).includes("single offscreen")) return;
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
          bridgeDetail: "Token does not match pairing token file",
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
        bridgeDetail: "Start an agent session, then verify the chrome MCP server is enabled.",
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
  if (tool === "get_console_logs") return getConsoleLogs(args);
  if (tool === "get_network_activity") return getNetworkActivity(args);
  if (tool === "handle_dialog") return handleDialog(args);
  if (tool === "upload_file") return uploadFile(args);

  if (["read_page", "get_page_text", "form_input", "click", "type_text", "press_key", "scroll"].includes(tool)) {
    const tabId = requireTab(args.tabId);
    await assertTabAllowed(tabId);
    await markGroup(tabId);

    // Auto-attach CDP for robust input & telemetry
    await attachCdp(tabId);

    if (["form_input", "click", "type_text", "press_key", "scroll"].includes(tool)) {
      await focusTab(tabId);
    }

    // Try CDP-powered trusted clicks
    if (tool === "click") {
      return clickWithCdp(tabId, args);
    }

    // Try CDP-powered trusted typing
    if (tool === "type_text") {
      return typeWithCdp(tabId, args);
    }

    // Try CDP-powered trusted keys
    if (tool === "press_key") {
      return pressKeyWithCdp(tabId, args);
    }

    const response = await sendToPage(tabId, { type: "page", action: tool, args });
    if (!response?.ok) throw new Error(response?.error || `${tool} failed`);

    let text = response.text || "Done.";
    if (tool === "form_input") {
      const tab = await chrome.tabs.get(tabId);
      text = `${text}\nURL now: ${tab.url || ""}`;
    }
    return { ok: true, text };
  }

  throw new Error(`Unknown tool ${tool}`);
}

async function tabsContext() {
  const tabs = await chrome.tabs.query({});
  const lines = tabs.map((tab) => {
    const active = tab.active ? " [active]" : "";
    const pinned = tab.pinned ? " [pinned]" : "";
    const status = tab.status ? ` (${tab.status})` : "";
    return `tab ${tab.id} win ${tab.windowId}${active}${pinned}${status}: "${oneLine(tab.title)}" ${tab.url || ""}`;
  });

  return {
    ok: true,
    text:
      `Open Chrome Tabs (${tabs.length}):\n` +
      `${lines.join("\n") || "(no open tabs)"}\n\n` +
      `Tip: Call tabs_create to open a new tab, or use an existing tabId above.`,
  };
}

async function tabsCreate(args) {
  const url = args.url ? String(args.url) : "about:blank";
  if (url !== "about:blank") await ensureHttpAllowed(url);
  const tab = await chrome.tabs.create({ url, active: args.active !== false });
  await markGroup(tab.id);
  if (url !== "about:blank") await waitForNavigation(tab.id, url);
  await attachCdp(tab.id);
  const loaded = await chrome.tabs.get(tab.id);
  return { ok: true, text: `Created tab ${loaded.id}\nTitle: ${loaded.title || ""}\nURL: ${loaded.url || ""}` };
}

async function tabsClose(args) {
  const tabId = requireTab(args.tabId);
  await detachCdp(tabId);
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
  await attachCdp(tabId);
  const tab = await chrome.tabs.get(tabId);
  return { ok: true, text: `Navigated tab ${tab.id}\nTitle: ${tab.title || ""}\nURL: ${tab.url || ""}` };
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
}

// Trusted CDP Click
async function clickWithCdp(tabId, args) {
  let x = args.x;
  let y = args.y;

  if (x == null || y == null) {
    const boundsRes = await sendToPage(tabId, { type: "page", action: "get_element_bounds", args });
    if (boundsRes?.ok && boundsRes.bounds) {
      x = boundsRes.bounds.x;
      y = boundsRes.bounds.y;
    }
  }

  if (cdpSessions.has(tabId) && x != null && y != null) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(x),
        y: Math.round(y),
      });
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: Math.round(x),
        y: Math.round(y),
        button: "left",
        clickCount: 1,
      });
      await sleep(40);
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: Math.round(x),
        y: Math.round(y),
        button: "left",
        clickCount: 1,
      });

      await sleep(250);
      const tab = await chrome.tabs.get(tabId);
      return {
        ok: true,
        text: `Clicked ${args.ref || args.selector || `at (${x}, ${y})`} via trusted native mouse event.\nURL now: ${tab.url || ""}`,
      };
    } catch (err) {
      console.warn(`[Agent in Chrome] CDP click failed, falling back to DOM click: ${err.message}`);
    }
  }

  // Fallback to DOM dispatch
  const res = await sendToPage(tabId, { type: "page", action: "click", args });
  if (!res?.ok) throw new Error(res?.error || "click failed");
  await sleep(250);
  const tab = await chrome.tabs.get(tabId);
  return { ok: true, text: `${res.text}\nURL now: ${tab.url || ""}` };
}

// Trusted CDP Typing
async function typeWithCdp(tabId, args) {
  const text = String(args.text ?? "");
  const clear = Boolean(args.clear);

  // Focus element first
  await sendToPage(tabId, {
    type: "page",
    action: "type_text",
    args: { ...args, text: "" },
  }).catch(() => {});

  if (cdpSessions.has(tabId)) {
    try {
      if (clear) {
        // Select all and delete
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: "a",
          code: "KeyA",
          modifiers: 2, // Control or Command
          windowsVirtualKeyCode: 65,
        });
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: "Backspace",
          code: "Backspace",
          windowsVirtualKeyCode: 8,
        });
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Backspace",
          code: "Backspace",
          windowsVirtualKeyCode: 8,
        });
      }

      await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text });
      return { ok: true, text: `Typed "${text}" via trusted native input into ${args.ref || args.selector || "element"}.` };
    } catch (err) {
      console.warn(`[Agent in Chrome] CDP typing failed, falling back: ${err.message}`);
    }
  }

  const res = await sendToPage(tabId, { type: "page", action: "type_text", args });
  if (!res?.ok) throw new Error(res?.error || "type_text failed");
  return { ok: true, text: res.text };
}

// Trusted CDP Key Press
async function pressKeyWithCdp(tabId, args) {
  const key = String(args.key || "");
  if (!key) throw new Error("Missing key.");

  let modifiers = 0;
  if (args.altKey) modifiers |= 1;
  if (args.ctrlKey) modifiers |= 2;
  if (args.metaKey) modifiers |= 4;
  if (args.shiftKey) modifiers |= 8;

  const keyCodes = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    PageUp: 33,
    PageDown: 34,
    Home: 36,
    End: 35,
    Space: 32,
  };

  if (cdpSessions.has(tabId)) {
    try {
      const vk = keyCodes[key] || key.toUpperCase().charCodeAt(0) || 0;
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key,
        code: key,
        modifiers,
        windowsVirtualKeyCode: vk,
      });
      if (key.length === 1 && !modifiers) {
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
          type: "char",
          text: key,
          key,
          code: key,
          modifiers,
          windowsVirtualKeyCode: vk,
        });
      }
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code: key,
        modifiers,
        windowsVirtualKeyCode: vk,
      });

      await sleep(200);
      const tab = await chrome.tabs.get(tabId);
      return { ok: true, text: `Pressed key "${key}" via trusted native event.\nURL now: ${tab.url || ""}` };
    } catch (err) {
      console.warn(`[Agent in Chrome] CDP press_key failed, falling back: ${err.message}`);
    }
  }

  const res = await sendToPage(tabId, { type: "page", action: "press_key", args });
  if (!res?.ok) throw new Error(res?.error || "press_key failed");
  await sleep(200);
  const tab = await chrome.tabs.get(tabId);
  return { ok: true, text: `${res.text}\nURL now: ${tab.url || ""}` };
}

// File Upload via CDP
async function uploadFile(args) {
  const tabId = requireTab(args.tabId);
  await assertTabAllowed(tabId);
  const filePath = String(args.filePath || "");
  if (!filePath) throw new Error("Missing filePath.");

  await attachCdp(tabId);
  if (!cdpSessions.has(tabId)) {
    throw new Error("CDP debugger is required for file uploads.");
  }

  const selector = args.selector || (args.ref ? `[data-agent-ref="${CSS.escape(args.ref)}"], [data-grok-ref="${CSS.escape(args.ref)}"]` : 'input[type="file"]');

  try {
    const doc = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument");
    const node = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector,
    });

    if (!node || !node.nodeId) {
      throw new Error(`File input matching ${selector} was not found on the page.`);
    }

    const desc = await chrome.debugger.sendCommand({ tabId }, "DOM.describeNode", {
      nodeId: node.nodeId,
    });

    await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
      files: [filePath],
      backendNodeId: desc.node.backendNodeId,
    });

    return { ok: true, text: `Uploaded file ${filePath} into ${selector}.` };
  } catch (err) {
    throw new Error(`File upload failed: ${err.message}`);
  }
}

// Dialog Handling via CDP
async function handleDialog(args) {
  const tabId = requireTab(args.tabId);
  await attachCdp(tabId);
  if (!cdpSessions.has(tabId)) {
    throw new Error("CDP debugger is required to handle dialogs.");
  }

  const accept = args.accept !== false;
  const promptText = args.promptText ? String(args.promptText) : undefined;

  await chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", {
    accept,
    promptText,
  });

  tabOpenDialogs.delete(tabId);
  return { ok: true, text: `Handled dialog (accepted: ${accept}${promptText ? `, prompt: "${promptText}"` : ""}).` };
}

// Console logs telemetry
async function getConsoleLogs(args) {
  const tabId = requireTab(args.tabId);
  const logs = tabConsoleLogs.get(tabId) || [];
  if (args.clear) tabConsoleLogs.set(tabId, []);

  if (!logs.length) {
    return { ok: true, text: "No console logs recorded on this tab." };
  }

  const formatted = logs.slice(0, 30).map((item) => {
    const time = new Date(item.timestamp).toLocaleTimeString();
    return `[${time}] [${item.type.toUpperCase()}] ${item.text}`;
  });

  return { ok: true, text: `Console logs for tab ${tabId} (${logs.length}):\n${formatted.join("\n")}` };
}

// Network activity telemetry
async function getNetworkActivity(args) {
  const tabId = requireTab(args.tabId);
  const records = tabNetworkLogs.get(tabId) || [];
  if (args.clear) tabNetworkLogs.set(tabId, []);

  const failedOnly = Boolean(args.failedOnly);
  const filtered = failedOnly ? records.filter((r) => r.status >= 400 || r.status === 0) : records;

  if (!filtered.length) {
    return { ok: true, text: failedOnly ? "No failed network requests." : "No network activity recorded." };
  }

  const formatted = filtered.slice(0, 30).map((item) => {
    const time = new Date(item.timestamp).toLocaleTimeString();
    const st = item.status === 0 ? "FAIL" : item.status;
    return `[${time}] ${st} ${item.type || ""} ${item.url} ${item.errorText || item.statusText || ""}`;
  });

  return { ok: true, text: `Network activity for tab ${tabId} (${filtered.length}):\n${formatted.join("\n")}` };
}

async function screenshot(args) {
  const tabId = requireTab(args.tabId);
  const tab = await assertTabAllowed(tabId);
  await markGroup(tabId);
  await focusTab(tabId);
  await sleep(150);

  // Full page screenshot via CDP if requested
  if (args.fullPage && cdpSessions.has(tabId)) {
    try {
      const metrics = await chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics");
      const width = Math.ceil(metrics.contentSize.width);
      const height = Math.ceil(metrics.contentSize.height);

      const shot = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 70,
        clip: { x: 0, y: 0, width, height, scale: 1 },
        captureBeyondViewport: true,
      });

      return {
        ok: true,
        text: `Captured full page screenshot of tab ${tabId} (${width}x${height}).`,
        imageBase64: shot.data,
        mimeType: "image/jpeg",
      };
    } catch (err) {
      console.warn(`[Agent in Chrome] CDP full page screenshot failed, falling back to viewport: ${err.message}`);
    }
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
  const imageBase64 = String(dataUrl).replace(/^data:image\/jpeg;base64,/, "");
  return { ok: true, text: `Captured visible area of tab ${tabId}.`, imageBase64, mimeType: "image/jpeg" };
}

async function runScript(args) {
  const tabId = requireTab(args.tabId);
  await assertTabAllowed(tabId);
  const code = String(args.code || "");
  if (!code.trim()) throw new Error("Missing code.");
  if (code.length > 50000) throw new Error("Script is too long.");

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
    text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  } catch {
    text = String(result);
  }
  return { ok: true, text: text === undefined ? "Script finished." : text.slice(0, 20000) };
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

// Sensitive domain protection (banking, high-risk financial sites)
const SENSITIVE_DOMAINS = [
  "bankofamerica.com",
  "chase.com",
  "wellsfargo.com",
  "citi.com",
  "fidelity.com",
  "vanguard.com",
  "schwab.com",
  "coinbase.com",
  "binance.com",
  "kraken.com",
  "1password.com",
  "bitwarden.com",
  "lastpass.com",
];

async function ensureAllowed(origin) {
  const stored = await chrome.storage.local.get(["allowAll", "allowedOrigins"]);

  // Detect sensitive domains
  const host = new URL(origin).hostname.toLowerCase();
  const isSensitive = SENSITIVE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  if (isSensitive && !stored.allowedOrigins?.includes(origin)) {
    const granted = await requestGrant(origin, true);
    if (!granted) {
      throw new Error(`High-risk sensitive site blocked for safety: ${origin}. You must explicitly approve this site in the side panel.`);
    }
    return;
  }

  if (stored.allowAll) return;
  const allowed = stored.allowedOrigins || [];
  if (allowed.includes(origin)) return;

  const granted = await requestGrant(origin, false);
  if (!granted) {
    throw new Error(`Site not allowed: ${origin}. Click the Agent in Chrome icon and choose Allow for this site.`);
  }
}

function requestGrant(origin, isHighRisk = false) {
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
  chrome.action.setBadgeBackgroundColor({ color: isHighRisk ? "#dc2626" : "#2563eb" });
  chrome.storage.local.set({ pendingOrigin: origin, pendingHighRisk: isHighRisk });
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
    await sleep(150);
  }
  throw new Error(`Could not reach page: ${lastError}`.trim());
}

function waitForNavigation(tabId, url) {
  const expected = url.split("#")[0];
  return new Promise((resolve) => {
    let sawLoad = false;
    const timer = setTimeout(() => finish("timeout"), 25000);
    const poll = setInterval(() => {
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.status === "complete" && tab.url && tab.url.split("#")[0].startsWith(expected.slice(0, Math.min(expected.length, 180)))) {
          if (sawLoad || Date.now() > started + 300) finish("complete");
        }
      }).catch(() => finish("missing"));
    }, 150);
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
    const groups = await chrome.tabGroups.query({ title: "Agent", windowId: tab.windowId });
    if (groups[0]) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: groups[0].id });
    } else {
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, { title: "Agent", color: "blue" });
    }
  } catch {}
}

async function logActivity(tool, detail) {
  const stored = await chrome.storage.local.get(["activity"]);
  const activity = stored.activity || [];
  activity.unshift({ t: Date.now(), tool: tool || "tool", detail: String(detail || "").slice(0, 180) });
  await chrome.storage.local.set({ activity: activity.slice(0, 40) });
}

function summarize(tool, args) {
  if (tool === "form_input") {
    const count = Array.isArray(args.fields) && args.fields.length ? args.fields.length : 1;
    return `filled ${count} field${count === 1 ? "" : "s"} on tab ${args.tabId}`;
  }
  if (tool === "type_text") return `typed on tab ${args.tabId}`;
  if (tool === "navigate") return `navigated tab ${args.tabId} to ${args.url}`;
  if (tool === "tabs_create") return `opened ${args.url || "blank tab"}`;
  if (tool === "click") return `clicked ${args.ref || args.selector || "element"} on tab ${args.tabId}`;
  if (tool === "screenshot") return `captured tab ${args.tabId}`;
  if (tool === "upload_file") return `uploaded file to tab ${args.tabId}`;
  if (tool === "handle_dialog") return `handled dialog on tab ${args.tabId}`;
  if (tool === "get_console_logs") return `read console logs on tab ${args.tabId}`;
  if (tool === "get_network_activity") return `read network activity on tab ${args.tabId}`;
  if (tool === "run_script") return `ran script on tab ${args.tabId}`;
  return `${tool} on tab ${args.tabId ?? ""}`.trim();
}

function requireTab(tabId) {
  if (typeof tabId !== "number" || !Number.isFinite(tabId)) {
    throw new Error("Missing tabId. Call tabs_context or tabs_create first to get a tabId.");
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
