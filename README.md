<p align="center">
  <img src="extension/icons/icon.png" width="128" height="128" alt="Agent in Chrome" />
</p>

# Agent in Chrome

A powerful, Claude-like Chrome extension and Model Context Protocol (MCP) server. AI agents (Grok, AGY, Claude, etc.) can navigate, inspect, click, type, fill complex forms, upload files, read console errors, and control Google Chrome using the logins and sessions already active in your browser.

---

## Key Features & Claude-Grade Capabilities

- **Trusted Native Browser Inputs (CDP)**: Uses the Chrome DevTools Protocol (`chrome.debugger`) to generate real, trusted mouse events and keystrokes (`isTrusted: true`). Works on modern reactive apps (React 18+, Vue, Angular), Radix UI, canvas apps, and bot-protected forms where synthetic JavaScript events fail.
- **Deep Page Perception**:
  - Automatically traverses **Open Shadow DOM** and nested components.
  - Generates concise semantic element maps with refs (`e1`, `e2`, ...), accessible roles, names, and viewport bounding coordinates.
  - Prioritizes visible in-viewport elements without arbitrary 160-element truncation caps.
- **Fast, Non-Blocking Form Filling**: Batch-fills text, textareas, native/custom select dropdowns, checkboxes, radios, and contenteditables without artificial delays.
- **File Upload Automation (`upload_file`)**: Automatically sets files on `<input type="file">` controls using native CDP `DOM.setFileInputFiles` without requiring manual file picker interaction.
- **Dialog & Alert Management (`handle_dialog`)**: Captures JavaScript `alert()`, `confirm()`, and `prompt()` dialogs in real time without locking up the page event loop or freezing extension scripts.
- **Developer & Diagnostic Telemetry**:
  - `get_console_logs`: Inspect client-side errors, warnings, and uncaught exceptions.
  - `get_network_activity`: Monitor API endpoints and isolate failed HTTP 4xx/5xx responses.
- **Full-Page & Viewport Screenshots (`screenshot`)**: Captures either the visible viewport or the full scrolling page layout (`fullPage: true`), saving high-quality JPEGs to disk.
- **Security & Safety Guardrails**:
  - Per-site origin permission gates managed directly from the Chrome side panel.
  - **High-Risk Domain Protection**: Automatic detection and warning for sensitive domains (banking, financial platforms, password managers).
  - CORS-hardened local bridge rejecting unauthorized web origins.

---

## Available MCP Tools

| Tool | Description |
| :--- | :--- |
| `tabs_context` | List all open Chrome tabs with IDs, active window, title, URL, and group. |
| `tabs_create` | Open a new Chrome tab (optionally navigating to a URL immediately). |
| `tabs_close` | Close an existing tab by `tabId`. |
| `navigate` | Navigate an existing tab to a URL and wait for page load completion. |
| `read_page` | Extract interactive elements with refs (`e1`, `e2`, ...), bounding boxes, and viewport status. |
| `get_page_text` | Extract the full visible text content of the tab. |
| `form_input` | Fill form fields in batch or individually without artificial delay. |
| `click` | Click elements by ref, CSS selector, or direct `(x, y)` coordinates using trusted native CDP events. |
| `type_text` | Type text into active fields using real native keystrokes with optional `clear: true`. |
| `press_key` | Press keys (`Enter`, `Tab`, `Escape`, `Backspace`, `ArrowDown`) with optional modifiers (`ctrlKey`, `shiftKey`, `altKey`, `metaKey`). |
| `upload_file` | Upload local files directly into `<input type="file">` elements using CDP. |
| `scroll` | Scroll by pixel delta (`dy`, `dx`) or scroll a specific element ref into view. |
| `screenshot` | Capture viewport or full scrolling page (`fullPage: true`) and save to disk. |
| `handle_dialog` | Accept or dismiss JavaScript `alert()`, `confirm()`, or `prompt()` dialogs with optional text. |
| `get_console_logs` | Retrieve recent browser console logs, warnings, and uncaught JS exceptions. |
| `get_network_activity`| Retrieve recent network requests and isolate failed API calls (`failedOnly: true`). |
| `run_script` | Execute JavaScript in the page context and receive JSON-serialized return values. |

---

## Installation & Setup

### 1. Load the Extension in Google Chrome
1. Open `chrome://extensions` in Google Chrome (or Brave).
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the repository's `extension` directory:
   ```
   <path-to-agent-chrome>/extension
   ```
4. Click the puzzle icon in Chrome's toolbar, pin **Agent in Chrome**, and click it to open the side panel.

### 2. Pairing with the Agent MCP Server
1. The pairing token is generated automatically on the first server launch, or print it anytime:
   ```bash
   node server/index.mjs --print-token
   ```
2. In the Chrome side panel, paste the token into the **Token** field (or click **File** to choose `~/.agent-chrome/token`), then click **Save**.
3. When the MCP server runs, the side panel will display a green **Connected** status badge.

### 3. Configuring Your Agent

#### Antigravity (AGY)
```bash
agy mcp add chrome -- node <path-to-agent-chrome>/server/index.mjs
```

#### Grok (`~/.grok/config.toml`)
```toml
[mcp.servers.chrome]
command = "node"
args = ["<path-to-agent-chrome>/server/index.mjs"]
```

#### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": ["<path-to-agent-chrome>/server/index.mjs"]
    }
  }
}
```

---

## Automated Verification Tests

Run the full protocol test suite and browser smoke test:

```bash
# 1. MCP Protocol & Tool Tests (Tests all 17 tools and proxy mode)
node server/test.mjs

# 2. Live Browser Smoke Test (Launches headless Chrome/Brave, tests real form fill & click)
node server/smoke.mjs
```
