#!/usr/bin/env node
// MCP server for the Grok in Chrome extension.
// stdout is the MCP channel. Logs go to stderr only.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const HOST = "127.0.0.1";
const PORT = Number(process.env.GROK_CHROME_PORT || 47321);
const HOME = process.env.GROK_CHROME_HOME || path.join(os.homedir(), ".grok-in-chrome");
const TOKEN_PATH = path.join(HOME, "token");
const SHOT_DIR = path.join(HOME, "shots");
const TIMEOUT_MS = Number(process.env.GROK_CHROME_TIMEOUT_MS || 120000);
const IDLE_MS = 8000;

const INSTRUCTIONS = `You control the user's real Chrome through the Grok in Chrome extension. Existing logins are already in that browser.

Start with tabs_context. Open a new tab with tabs_create unless the user told you to use an existing tab. Never reuse a tab id from an earlier conversation.

Before clicking or typing, call read_page and use the refs it returns (e1, e2, ...). If a ref is missing, call read_page again.

If a tool says a site is not allowed, stop and tell the user to click the Grok in Chrome icon and choose Allow. Do not keep retrying.

Do not submit a payment, change a password, delete an account, or send a message unless the user explicitly asked. After filling a form, stop before the final submit unless they asked you to submit.

Avoid actions that open a JavaScript alert or confirm dialog. Those dialogs freeze the extension until the user dismisses them.

Close only tabs you created. Screenshot files are saved on disk; read the file path the tool returns.`;

const TOOLS = [
  {
    name: "tabs_context",
    description: "List open Chrome tabs (id, window, title, url). Call this first. Do not reuse tab ids from an earlier conversation.",
    schema: { type: "object", properties: {} },
  },
  {
    name: "tabs_create",
    description: "Open a new tab. Pass url to go there immediately. The site must be allowed in the extension, or the user is asked to allow it. The new tab is grouped under Grok.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http(s) URL. Omit to open a blank tab." },
        active: { type: "boolean", description: "Focus the tab. Default true." },
      },
    },
  },
  {
    name: "tabs_close",
    description: "Close a tab. Close only tabs you created with tabs_create.",
    schema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "navigate",
    description: "Go to a URL in an existing tab and wait for it to load. The site must be allowed, or the user is asked to allow it.",
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
    description: "List interactive elements on a tab with refs like e1, e2. Call this before form_input, click, or type_text. The site must be allowed.",
    schema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "get_page_text",
    description: "Read the visible text of a tab. The site must be allowed.",
    schema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "form_input",
    description: "Fill form fields. Pass tabId and fields: [{ref, value}]. A single ref and value also works. Refs come from read_page. This replaces the field value and does not submit the form. File inputs cannot be set. The site must be allowed.",
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
    description: "Click an element by ref from read_page, or by CSS selector. The site must be allowed.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        ref: { type: "string" },
        selector: { type: "string" },
      },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "type_text",
    description: "Type text into an element by ref or selector. Pass clear:true to replace existing text. Does not submit. The site must be allowed.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        ref: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        clear: { type: "boolean" },
      },
      required: ["tabId", "text"],
    },
    required: ["tabId", "text"],
  },
  {
    name: "press_key",
    description: "Press a key in a tab, such as Enter, Tab, or Escape. The site must be allowed.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        key: { type: "string" },
        ref: { type: "string", description: "Focus this element first." },
      },
      required: ["tabId", "key"],
    },
    required: ["tabId", "key"],
  },
  {
    name: "scroll",
    description: "Scroll a tab by dy pixels, or scroll a ref into view. The site must be allowed.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        ref: { type: "string" },
        dy: { type: "number" },
      },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "screenshot",
    description: "Capture the visible area of a tab, focus that window, and save a JPEG. The result includes a file path. The site must be allowed.",
    schema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
    },
    required: ["tabId"],
  },
  {
    name: "run_script",
    description: "Run a JavaScript function body in the page. Use this only when read_page, click, and form_input cannot do the job. The script may return a JSON value. The site must be allowed.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        code: { type: "string", description: "Function body. Use return to send a value back." },
      },
      required: ["tabId", "code"],
    },
    required: ["tabId", "code"],
  },
];

const toolMap = new Map(TOOLS.map((tool) => [tool.name, tool]));

function log(message) {
  console.error(`[grok-in-chrome] ${message}`);
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
  return "Chrome extension is not connected. In Chrome, open chrome://extensions, turn on Developer mode, Load unpacked, and choose the extension folder. Then click the Grok in Chrome icon and paste the pairing token from ~/.grok-in-chrome/token.";
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
  for (const old of files.slice(0, Math.max(0, files.length - 10))) {
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
      text = `${text}\nCould not save the screenshot: ${error.message}`;
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
      return textResult(`Missing ${key}.`, true);
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
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.schema,
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
        serverInfo: { name: "grok-in-chrome", version: "0.1.0" },
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
  log("skipped unexpected stdin");
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 15_000_000) {
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

function reply(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Private-Network": "true",
  });
  res.end(body);
}

async function handleHttp(req, res) {
  if (process.env.GROK_CHROME_DEBUG) log(`${req.method} ${req.url}`);
  if (req.method === "OPTIONS") {
    reply(res, 204, {});
    return;
  }
  const url = new URL(req.url || "/", `http://${HOST}`);

  if (req.method === "GET" && url.pathname === "/health") {
    reply(res, 200, { ok: true, connected: extensionIsConnected() });
    return;
  }

  if (!authorized(req)) {
    reply(res, 401, { error: "bad token" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/poll") {
    const job = await takeJob();
    reply(res, 200, job ? { job } : { timeout: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/result") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (!finishJob(body.id, body.result)) {
      reply(res, 404, { error: "unknown id" });
      return;
    }
    reply(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/call") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const result = await callTool(body.tool, body.args || {});
    reply(res, 200, { result });
    return;
  }

  reply(res, 404, { error: "not found" });
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
    return textResult("Pairing token was rejected by the running Chrome bridge.", true);
  }
  if (!response.ok) {
    return textResult(`Chrome bridge returned HTTP ${response.status}.`, true);
  }
  const payload = await response.json();
  return payload.result || textResult("Chrome bridge returned an empty result.", true);
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
        serverInfo: { name: "grok-in-chrome", version: "0.1.0" },
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
        result: textResult(`Could not reach the Chrome bridge on ${HOST}:${PORT}. ${error.message}`, true),
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
      log(`bad message: ${error.message}`);
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
