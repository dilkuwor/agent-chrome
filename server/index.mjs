#!/usr/bin/env node
// MCP server for the Agent in Chrome extension.
// Communicates with MCP clients via JSON-RPC stdio. Logs go to stderr only.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const HOST = "127.0.0.1";
const PORT = Number(process.env.AGENT_CHROME_PORT || process.env.GROK_CHROME_PORT || 47321);

function resolveHome() {
  if (process.env.AGENT_CHROME_HOME) return process.env.AGENT_CHROME_HOME;
  if (process.env.GROK_CHROME_HOME) return process.env.GROK_CHROME_HOME;
  const standardHome = path.join(os.homedir(), ".agent-chrome");
  if (fs.existsSync(standardHome)) return standardHome;
  const altHome = path.join(os.homedir(), ".agent-in-chrome");
  if (fs.existsSync(altHome)) return altHome;
  const legacyHome = path.join(os.homedir(), ".grok-in-chrome");
  if (fs.existsSync(legacyHome)) return legacyHome;
  return standardHome;
}

const HOME = resolveHome();
const TOKEN_PATH = path.join(HOME, "token");
const SHOT_DIR = path.join(HOME, "shots");
const TIMEOUT_MS = Number(process.env.AGENT_CHROME_TIMEOUT_MS || process.env.GROK_CHROME_TIMEOUT_MS || 120000);
const IDLE_MS = 12000;

const INSTRUCTIONS = `You control the user's Google Chrome browser through the Agent in Chrome extension.
The browser contains their active logins, cookies, and extensions.

Loop & Workflow:
1. Call tabs_context first to discover open tabs and active tab IDs. Do not reuse tab IDs from previous sessions.
2. Use tabs_create to open target websites or navigate existing tabs.
3. Call read_page to get interactive elements with refs (e1, e2, ...), accessibility roles, and bounding coordinates.
4. Fill forms using form_input for text, select dropdowns, checkboxes, and radio buttons.
5. Use click to trigger buttons and links with trusted native browser clicks.
6. Use type_text for input fields and press_key for Enter, Tab, Escape, and arrow keys.
7. Use upload_file for <input type="file"> to upload local files directly.
8. If an action seems to fail or a form won't submit, call get_console_logs and get_network_activity to diagnose errors.
9. If a browser alert, confirm, or prompt appears, inspect or dismiss it using handle_dialog.
10. Use screenshot (with optional fullPage: true) to inspect visual layouts.

Safety:
- Do not execute financial transactions, checkout purchases, password changes, or account deletions without explicit user confirmation.
- Respect sensitive site warnings.`;

const TOOLS = [
  {
    name: "tabs_context",
    description: "List all open Chrome tabs (id, window, title, url, active status, group). Call this first.",
    schema: { type: "object", properties: {} },
  },
  {
    name: "tabs_create",
    description: "Open a new Chrome tab. Pass url to navigate immediately. Tab is grouped under Agent.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http(s) URL. Omit for blank tab." },
        active: { type: "boolean", description: "Focus tab immediately. Default true." },
      },
    },
  },
  {
    name: "tabs_close",
    description: "Close a Chrome tab by tabId.",
    schema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "navigate",
    description: "Navigate an existing tab to a URL and wait for page load.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        url: { type: "string", description: "Absolute http(s) URL." },
      },
      required: ["tabId", "url"],
    },
    required: ["tabId", "url"],
  },
  {
    name: "read_page",
    description: "Inspect the page and list interactive elements with refs like e1, e2, roles, bounding boxes, and viewport visibility. Supports Open Shadow DOM and iframes.",
    schema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "get_page_text",
    description: "Extract the full visible text content of the tab.",
    schema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "form_input",
    description: "Fill form fields efficiently without artificial delay. Supports text, select dropdowns, checkboxes, radios, and contenteditables. Pass tabId and fields: [{ref, value}] or a single ref/selector and value.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        ref: { type: "string" },
        selector: { type: "string" },
        value: { type: ["string", "number", "boolean"] },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string" },
              selector: { type: "string" },
              value: { type: ["string", "number", "boolean"] },
            },
            required: ["value"],
          },
        },
      },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "click",
    description: "Click an element by ref (e1), CSS selector, or direct (x, y) coordinates using trusted native CDP events.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        ref: { type: "string" },
        selector: { type: "string" },
        x: { type: "number", description: "Viewport X coordinate" },
        y: { type: "number", description: "Viewport Y coordinate" },
      },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "type_text",
    description: "Type text into an element using trusted native keystrokes. Pass clear: true to replace existing content.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        ref: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        clear: { type: "boolean", description: "Clear field before typing" },
      },
      required: ["tabId", "text"],
    },
    required: ["tabId", "text"],
  },
  {
    name: "press_key",
    description: "Press a key (e.g. Enter, Tab, Escape, Backspace, ArrowDown) with optional modifiers (ctrlKey, shiftKey, altKey, metaKey).",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        key: { type: "string" },
        ref: { type: "string", description: "Focus this element first" },
        ctrlKey: { type: "boolean" },
        shiftKey: { type: "boolean" },
        altKey: { type: "boolean" },
        metaKey: { type: "boolean" },
      },
      required: ["tabId", "key"],
    },
    required: ["tabId", "key"],
  },
  {
    name: "upload_file",
    description: "Upload a local file to a file input element (<input type=\"file\">) using CDP DOM.setFileInputFiles.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        filePath: { type: "string", description: "Absolute path to the file on local disk" },
        ref: { type: "string" },
        selector: { type: "string" },
      },
      required: ["tabId", "filePath"],
    },
    required: ["tabId", "filePath"],
  },
  {
    name: "scroll",
    description: "Scroll the page by dy pixels, or scroll a specific element ref into view.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        ref: { type: "string" },
        dy: { type: "number", description: "Vertical scroll pixels (positive down, negative up)" },
        dx: { type: "number", description: "Horizontal scroll pixels" },
      },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "screenshot",
    description: "Capture the visible tab or full scrolling page. Saves JPEG to disk and returns file path.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        fullPage: { type: "boolean", description: "Capture the full height of the page" },
      },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "handle_dialog",
    description: "Accept or dismiss a JavaScript alert, confirm, or prompt dialog, with optional prompt text.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        accept: { type: "boolean", description: "True to accept/OK, false to dismiss/Cancel. Default true." },
        promptText: { type: "string", description: "Text response for prompt dialogs" },
      },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "get_console_logs",
    description: "Retrieve recent browser console logs, warnings, and uncaught exceptions to diagnose client-side errors.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        clear: { type: "boolean", description: "Clear log buffer after reading" },
      },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "get_network_activity",
    description: "Retrieve recent network activity and API calls. Set failedOnly: true to isolate HTTP 4xx/5xx errors.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        failedOnly: { type: "boolean", description: "Show only failed requests" },
        clear: { type: "boolean", description: "Clear network buffer after reading" },
      },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "run_script",
    description: "Execute a JavaScript snippet in the page context. Use return to send a value back.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        code: { type: "string", description: "JavaScript function body" },
      },
      required: ["tabId", "code"],
    },
    required: ["tabId", "code"],
  },
];

const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

function log(message) {
  console.error(`[agent-in-chrome] ${message}`);
}

function loadToken() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  if (fs.existsSync(TOKEN_PATH)) {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim();
  }
  const token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  return token;
}

const token = loadToken();

if (process.argv.includes("--print-token")) {
  process.stdout.write(`${token}\n`);
  process.exit(0);
}

let outboundFraming = "newline";
let buffer = "";
const queue = [];
const pending = new Map();
let pollWaiter = null;
let lastPollAt = 0;
let announced = false;

function send(message) {
  const json = JSON.stringify(message);
  if (outboundFraming === "content-length") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function extensionDownMessage() {
  return "Chrome extension is not connected. Open chrome://extensions in Chrome, ensure Developer mode is ON, and Load unpacked the extension directory. Open the side panel and ensure pairing token is configured.";
}

function notePoll() {
  lastPollAt = Date.now();
  if (!announced) {
    announced = true;
    log("extension connected");
  }
}

function extensionIsConnected() {
  return pollWaiter !== null || pending.size > 0 || Date.now() - lastPollAt < IDLE_MS;
}

function enqueue(tool, args) {
  if (!extensionIsConnected()) {
    return Promise.reject(new Error(extensionDownMessage()));
  }
  const id = crypto.randomUUID();
  const job = { id, tool, args: args || {} };
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${extensionDownMessage()} The last action timed out.`));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
  });

  if (pollWaiter) {
    const waiter = pollWaiter;
    pollWaiter = null;
    lastPollAt = Date.now();
    waiter.resolve(job);
  } else {
    queue.push(job);
  }
  return promise;
}

function takeJob() {
  notePoll();
  if (queue.length > 0) return Promise.resolve(queue.shift());
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pollWaiter && pollWaiter.resolve === finish) pollWaiter = null;
      resolve(null);
    }, 20000);
    const finish = (job) => {
      clearTimeout(timer);
      resolve(job);
    };
    pollWaiter = { resolve: finish, timer };
  });
}

function finishJob(id, result) {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(result);
  return true;
}

function saveShot(imageBase64) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `shot-${Date.now()}.jpg`);
  fs.writeFileSync(file, Buffer.from(imageBase64, "base64"));
  const files = fs.readdirSync(SHOT_DIR).filter((name) => name.startsWith("shot-")).sort();
  for (const old of files.slice(0, Math.max(0, files.length - 15))) {
    fs.rmSync(path.join(SHOT_DIR, old), { force: true });
  }
  return file;
}

function toMcp(result) {
  if (!result || result.ok === false) {
    return textResult(result?.error || "The Chrome extension returned an error.", true);
  }
  let text = result.text || "Done.";
  if (result.imageBase64) {
    try {
      const file = saveShot(result.imageBase64);
      text = `${text}\nScreenshot file: ${file}`;
    } catch (error) {
      text = `${text}\nCould not save screenshot: ${error.message}`;
    }
  }
  return textResult(text, false);
}

async function callTool(name, args) {
  const tool = toolMap.get(name);
  if (!tool) return textResult(`Unknown tool ${name}.`, true);
  const input = args || {};
  for (const key of tool.required || []) {
    if (input[key] == null || input[key] === "") {
      return textResult(`Missing required parameter: ${key}.`, true);
    }
  }
  log(`tool ${name}`);
  try {
    return toMcp(await enqueue(name, input));
  } catch (error) {
    return textResult(error.message, true);
  }
}

function toolList() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.schema,
  }));
}

async function handleRpc(message) {
  const { id, method, params } = message;
  if (id == null) return;

  if (method === "initialize") {
    const clientVersion = params?.protocolVersion;
    const protocolVersion = clientVersion || "2024-11-05";
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-in-chrome", version: "0.2.0" },
        instructions: INSTRUCTIONS,
      },
    });
    return;
  }

  if (method === "ping" || method === "logging/setLevel") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: toolList() } });
    return;
  }

  if (method === "tools/call") {
    const result = await callTool(params?.name, params?.arguments || {});
    send({ jsonrpc: "2.0", id, result });
    return;
  }

  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

function pullMessage() {
  buffer = buffer.replace(/^\uFEFF?/, "");
  if (!buffer.trim()) return null;
  const trimmed = buffer.replace(/^[\s]+/, "");
  if (!trimmed) return null;
  if (buffer !== trimmed) buffer = trimmed;

  if (/^content-length:/i.test(buffer)) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return null;
    const match = buffer.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      return null;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (Buffer.byteLength(buffer.slice(start), "utf8") < length) return null;
    const bodyBytes = Buffer.from(buffer.slice(start), "utf8").subarray(0, length);
    const consumed = bodyBytes.toString("utf8");
    buffer = buffer.slice(start + consumed.length);
    outboundFraming = "content-length";
    return JSON.parse(consumed);
  }

  if (buffer.startsWith("{")) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return null;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    outboundFraming = "newline";
    return JSON.parse(line);
  }

  const newline = buffer.indexOf("\n");
  if (newline < 0) return null;
  buffer = buffer.slice(newline + 1);
  return pullMessage();
}

function onStdin(chunk) {
  buffer += chunk;
  while (true) {
    let message;
    try {
      message = pullMessage();
    } catch (error) {
      log(`bad message: ${error.message}`);
      return;
    }
    if (!message) return;
    handleRpc(message).catch((error) => {
      log(`rpc failed: ${error.message}`);
      if (message.id != null) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: error.message },
        });
      }
    });
  }
}

function authorized(req) {
  return req.headers.authorization === `Bearer ${token}`;
}

function isOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Local curl or direct background fetch
  // Only allow Chrome extension origins or localhost
  return origin.startsWith("chrome-extension://") || origin.startsWith("http://127.0.0.1:") || origin.startsWith("http://localhost:");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 20_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res, status, payload, reqOrigin = "") {
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": reqOrigin || "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Private-Network": "true",
  };
  res.writeHead(status, headers);
  res.end(body);
}

async function handleHttp(req, res) {
  const reqOrigin = req.headers.origin || "";

  if (req.method === "OPTIONS") {
    reply(res, 204, {}, reqOrigin);
    return;
  }

  if (!isOriginAllowed(req)) {
    reply(res, 403, { error: "forbidden origin" });
    return;
  }

  const url = new URL(req.url || "/", `http://${HOST}`);

  if (req.method === "GET" && url.pathname === "/health") {
    reply(res, 200, { ok: true, connected: extensionIsConnected() }, reqOrigin);
    return;
  }

  if (!authorized(req)) {
    reply(res, 401, { error: "bad token" }, reqOrigin);
    return;
  }

  if (req.method === "POST" && url.pathname === "/poll") {
    const job = await takeJob();
    reply(res, 200, job ? { job } : { timeout: true }, reqOrigin);
    return;
  }

  if (req.method === "POST" && url.pathname === "/result") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (!finishJob(body.id, body.result)) {
      reply(res, 404, { error: "unknown job id" }, reqOrigin);
      return;
    }
    reply(res, 200, { ok: true }, reqOrigin);
    return;
  }

  if (req.method === "POST" && url.pathname === "/call") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const result = await callTool(body.tool, body.args || {});
    reply(res, 200, { result }, reqOrigin);
    return;
  }

  reply(res, 404, { error: "not found" }, reqOrigin);
}

function startProxy() {
  log(`using the Chrome bridge already running on ${HOST}:${PORT}`);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onProxyStdin);
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
}

const proxyState = { buffer: "", framing: "newline" };

function proxySend(message) {
  const json = JSON.stringify(message);
  if (proxyState.framing === "content-length") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

async function proxyCall(name, args) {
  const response = await fetch(`http://${HOST}:${PORT}/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ tool: name, args: args || {} }),
  });
  if (response.status === 401) {
    return textResult("Pairing token rejected by running bridge.", true);
  }
  if (!response.ok) {
    return textResult(`Chrome bridge returned HTTP ${response.status}.`, true);
  }
  const payload = await response.json();
  return payload.result || textResult("Empty response from Chrome bridge.", true);
}

async function handleProxyRpc(message) {
  const { id, method, params } = message;
  if (id == null) return;
  if (method === "initialize") {
    proxySend({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-in-chrome", version: "0.2.0" },
        instructions: INSTRUCTIONS,
      },
    });
    return;
  }
  if (method === "ping" || method === "logging/setLevel") {
    proxySend({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    proxySend({ jsonrpc: "2.0", id, result: { tools: toolList() } });
    return;
  }
  if (method === "tools/call") {
    try {
      const result = await proxyCall(params?.name, params?.arguments || {});
      proxySend({ jsonrpc: "2.0", id, result });
    } catch (error) {
      proxySend({
        jsonrpc: "2.0",
        id,
        result: textResult(`Could not reach bridge on ${HOST}:${PORT}: ${error.message}`, true),
      });
    }
    return;
  }
  proxySend({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

function pullProxyMessage() {
  const source = proxyState;
  source.buffer = source.buffer.replace(/^\uFEFF?/, "");
  if (!source.buffer.trim()) return null;
  const trimmed = source.buffer.replace(/^[\s]+/, "");
  if (source.buffer !== trimmed) source.buffer = trimmed;
  if (/^content-length:/i.test(source.buffer)) {
    const headerEnd = source.buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return null;
    const match = source.buffer.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
    if (!match) return null;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (Buffer.byteLength(source.buffer.slice(start), "utf8") < length) return null;
    const bodyBytes = Buffer.from(source.buffer.slice(start), "utf8").subarray(0, length);
    const consumed = bodyBytes.toString("utf8");
    source.buffer = source.buffer.slice(start + consumed.length);
    source.framing = "content-length";
    return JSON.parse(consumed);
  }
  if (source.buffer.startsWith("{")) {
    const newline = source.buffer.indexOf("\n");
    if (newline < 0) return null;
    const line = source.buffer.slice(0, newline).trim();
    source.buffer = source.buffer.slice(newline + 1);
    source.framing = "newline";
    return JSON.parse(line);
  }
  const newline = source.buffer.indexOf("\n");
  if (newline < 0) return null;
  source.buffer = source.buffer.slice(newline + 1);
  return pullProxyMessage();
}

function onProxyStdin(chunk) {
  proxyState.buffer += chunk;
  while (true) {
    let message;
    try {
      message = pullProxyMessage();
    } catch (error) {
      log(`bad proxy message: ${error.message}`);
      return;
    }
    if (!message) return;
    handleProxyRpc(message).catch((error) => log(`proxy rpc failed: ${error.message}`));
  }
}

async function main() {
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log(`http failed: ${error.message}`);
      if (!res.headersSent) reply(res, 500, { error: error.message });
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      startProxy();
      return;
    }
    throw error;
  }

  log(`listening on ${HOST}:${PORT}`);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onStdin);
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
}

main().catch((error) => {
  log(`fatal: ${error.stack || error.message}`);
  process.exit(1);
});
