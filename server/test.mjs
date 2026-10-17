import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = await freePort();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-chrome-"));
const serverPath = path.join(root, "server", "index.mjs");

let proxy;
let stop = () => {};
const primary = spawn(process.execPath, [serverPath], {
  env: { ...process.env, GROK_CHROME_PORT: String(port), GROK_CHROME_HOME: home, GROK_CHROME_TIMEOUT_MS: "4000" },
  stdio: ["pipe", "pipe", "pipe"],
});

let primaryErr = "";
primary.stderr.on("data", (chunk) => {
  primaryErr += chunk.toString();
});

try {
  await waitFor(() => primaryErr.includes("listening"), "primary server");
  const token = fs.readFileSync(path.join(home, "token"), "utf8").trim();
  const primaryRpc = rpc(primary);

  const init = await primaryRpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert(init.result.serverInfo.name === "grok-in-chrome", "server name");
  const listed = await primaryRpc("tools/list");
  const names = listed.result.tools.map((tool) => tool.name);
  for (const name of ["tabs_context", "form_input", "click", "navigate", "read_page"]) {
    assert(names.includes(name), `missing tool ${name}`);
  }

  const offline = await primaryRpc("tools/call", { name: "tabs_context", arguments: {} });
  assert(offline.result.isError === true, "offline call should error");
  assert(offline.result.content[0].text.includes("not connected"), "offline message");

  const seen = [];
  stop = mockExtension(port, token, async (job) => {
    seen.push(job);
    if (job.tool === "tabs_context") {
      return { ok: true, text: "Open tabs (1):\ntab 7 window 1 active Example https://example.com" };
    }
    if (job.tool === "form_input") return { ok: true, text: "Filled e1." };
    if (job.tool === "screenshot") {
      return { ok: true, text: "Captured.", imageBase64: Buffer.from("jpeg-bytes").toString("base64") };
    }
    return { ok: false, error: `unexpected ${job.tool}` };
  });

  await waitFor(() => primaryErr.includes("extension connected"), "extension connect");
  const tabs = await primaryRpc("tools/call", { name: "tabs_context", arguments: {} });
  assert(tabs.result.isError === false, "tabs_context error");
  assert(tabs.result.content[0].text.includes("tab 7"), "tabs_context text");

  const shot = await primaryRpc("tools/call", { name: "screenshot", arguments: { tabId: 7 } });
  assert(shot.result.content[0].text.includes("Screenshot file:"), "screenshot path");
  const shotPath = shot.result.content[0].text.split("Screenshot file: ")[1].trim();
  assert(fs.readFileSync(shotPath, "utf8") === "jpeg-bytes", "screenshot bytes");

  proxy = spawn(process.execPath, [serverPath], {
    env: { ...process.env, GROK_CHROME_PORT: String(port), GROK_CHROME_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let proxyErr = "";
  proxy.stderr.on("data", (chunk) => {
    proxyErr += chunk.toString();
  });
  await waitFor(() => proxyErr.includes("already running"), "proxy server");
  const proxyRpc = rpc(proxy);
  await proxyRpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "proxy", version: "0" } });
  const filled = await proxyRpc("tools/call", {
    name: "form_input",
    arguments: { tabId: 7, fields: [{ ref: "e1", value: "ada@example.com" }] },
  });
  assert(filled.result.isError === false, `proxy form_input failed: ${filled.result.content?.[0]?.text}`);
  assert(filled.result.content[0].text.includes("Filled e1"), "fill result");
  assert(seen.some((job) => job.tool === "form_input" && job.args.fields[0].value === "ada@example.com"), "proxy reached extension");

  const missing = await primaryRpc("tools/call", { name: "navigate", arguments: { tabId: 7 } });
  assert(missing.result.isError === true, "missing url should error");

  stop();
  console.log("protocol tests passed");
} finally {
  stop();
  proxy?.kill();
  primary.kill();
  fs.rmSync(home, { recursive: true, force: true });
}

function rpc(proc) {
  let buffer = "";
  let nextId = 1;
  const waiters = new Map();
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id != null && waiters.has(message.id)) {
        waiters.get(message.id)(message);
        waiters.delete(message.id);
      }
    }
  });
  return (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 8000);
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
}

function mockExtension(serverPort, token, handler) {
  let stopped = false;
  poll();
  return () => {
    stopped = true;
  };

  async function poll() {
    while (!stopped) {
      try {
        const response = await fetch(`http://127.0.0.1:${serverPort}/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: "{}",
        });
        if (stopped) return;
        if (!response.ok) throw new Error(`poll HTTP ${response.status}`);
        const data = await response.json();
        if (!data.job) continue;
        const result = await handler(data.job);
        const posted = await fetch(`http://127.0.0.1:${serverPort}/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ id: data.job.id, result }),
        });
        if (!posted.ok) throw new Error(`result HTTP ${posted.status}`);
      } catch (error) {
        if (stopped) return;
        throw error;
      }
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
    server.on("error", reject);
  });
}

async function waitFor(check, label) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${label}\n${primaryErr}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
