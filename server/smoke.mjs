import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "extension");
const chromePath = [
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate) => fs.existsSync(candidate));
if (!chromePath) throw new Error("Need Brave or Chrome to run the smoke test.");
const bridgePort = await freePort();
const debugPort = await freePort();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-chrome-smoke-"));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "grok-chrome-profile-"));
const form = `<!doctype html>
<meta charset="utf-8">
<title>Fixture</title>
<label for="email">Email</label>
<input id="email">
<label for="plan">Plan</label>
<select id="plan">
  <option value="free">Free</option>
  <option value="pro">Pro</option>
</select>
<label for="news">News</label>
<input id="news" type="checkbox">
<button id="go" type="button">Continue</button>
<p id="out"></p>
<script>
document.querySelector("#email").addEventListener("input", (event) => {
  event.target.dataset.seen = event.target.value;
});
document.querySelector("#go").addEventListener("click", () => {
  document.querySelector("#out").textContent = "clicked";
});
</script>`;

const fixture = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(form);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixturePort = fixture.address().port;
const pageUrl = `http://127.0.0.1:${fixturePort}/`;

const bridge = spawn(process.execPath, [path.join(root, "server", "index.mjs")], {
  env: { ...process.env, GROK_CHROME_PORT: String(bridgePort), GROK_CHROME_HOME: home, GROK_CHROME_TIMEOUT_MS: "30000" },
  stdio: ["pipe", "pipe", "pipe"],
});
let bridgeErr = "";
bridge.stderr.on("data", (chunk) => {
  bridgeErr += chunk.toString();
});

const chrome = spawn(chromePath, [
  `--user-data-dir=${profile}`,
  `--load-extension=${extension}`,
  `--disable-extensions-except=${extension}`,
  `--remote-debugging-port=${debugPort}`,
  "--headless=new",
  "--no-first-run",
  "--disable-gpu",
  "--disable-sync",
  "--no-default-browser-check",
  pageUrl,
], { stdio: "ignore", detached: true });

try {
  await waitFor(() => bridgeErr.includes("listening"), "bridge");
  const token = fs.readFileSync(path.join(home, "token"), "utf8").trim();
  const client = rpc(bridge);
  await client("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });

  const worker = await waitForTarget(
    debugPort,
    (target) => target.type === "service_worker" && target.url.includes("background.js"),
  );
  const workerCdp = await connect(worker.webSocketDebuggerUrl);
  await workerCdp.send("Runtime.enable");
  const manifest = await workerCdp.send("Runtime.evaluate", {
    expression: "chrome.runtime.getManifest().name",
    returnByValue: true,
  });
  if (manifest.result?.value !== "Grok in Chrome") {
    throw new Error(`unexpected service worker ${worker.url}: ${JSON.stringify(manifest)}`);
  }
  const stored = await workerCdp.send("Runtime.evaluate", {
    expression: `chrome.storage.local.set(${JSON.stringify({ token, port: bridgePort, allowAll: true })})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (stored.exceptionDetails) throw new Error(JSON.stringify(stored.exceptionDetails));

  await waitFor(() => bridgeErr.includes("extension connected"), "extension", 20000);
  const tabs = await client("tools/call", { name: "tabs_context", arguments: {} });
  if (tabs.result.isError) throw new Error(tabs.result.content[0].text);
  const match = tabs.result.content[0].text.match(/tab (\d+)[^\n]*127\.0\.0\.1/);
  if (!match) throw new Error(`fixture tab not found:\n${tabs.result.content[0].text}`);
  const tabId = Number(match[1]);

  const filled = await client("tools/call", {
    name: "form_input",
    arguments: {
      tabId,
      fields: [
        { selector: "#email", value: "ada@example.com" },
        { selector: "#plan", value: "Pro" },
        { selector: "#news", value: true },
      ],
    },
  });
  if (filled.result.isError) throw new Error(filled.result.content[0].text);

  const clicked = await client("tools/call", {
    name: "click",
    arguments: { tabId, selector: "#go" },
  });
  if (clicked.result.isError) throw new Error(clicked.result.content[0].text);

  const page = await waitForTarget(debugPort, (target) => target.type === "page" && target.url.includes(String(fixturePort)));
  const pageCdp = await connect(page.webSocketDebuggerUrl);
  await pageCdp.send("Runtime.enable");
  const value = await pageCdp.send("Runtime.evaluate", {
    expression: `({
      email: document.querySelector("#email").value,
      seen: document.querySelector("#email").dataset.seen,
      plan: document.querySelector("#plan").value,
      news: document.querySelector("#news").checked,
      out: document.querySelector("#out").textContent
    })`,
    returnByValue: true,
  });
  const state = value.result.value;
  const expected = {
    email: "ada@example.com",
    seen: "ada@example.com",
    plan: "pro",
    news: true,
    out: "clicked",
  };
  for (const [key, want] of Object.entries(expected)) {
    if (state[key] !== want) throw new Error(`${key}: expected ${want}, got ${state[key]}`);
  }
  console.log("chrome smoke test passed");
  workerCdp.ws.close();
  pageCdp.ws.close();
} catch (error) {
  console.error(bridgeErr);
  throw error;
} finally {
  try {
    process.kill(-chrome.pid, "SIGKILL");
  } catch {
    chrome.kill("SIGKILL");
  }
  bridge.kill("SIGKILL");
  fixture.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
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
      if (!line.startsWith("{")) continue;
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
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 25000);
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  return {
    ws,
    send(method, params = {}) {
      const msgId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`cdp timeout ${method}`)), 10000);
        pending.set(msgId, (message) => {
          clearTimeout(timer);
          if (message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result || {});
        });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    },
  };
}

async function waitForTarget(port, predicate) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const found = targets.find(predicate);
        if (found) return found;
      }
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  let listed = "";
  try {
    listed = await (await fetch(`http://127.0.0.1:${port}/json/list`)).text();
  } catch (error) {
    listed = String(error);
  }
  throw new Error(`timed out waiting for a Chrome target\n${listed}`);
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

async function waitFor(check, label, timeout = 8000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}\n${bridgeErr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
