---
name: agent-in-chrome
description: Control the user's real Google Chrome browser with Claude-like capabilities via the Agent in Chrome extension and MCP server. Use to navigate, click, fill complex forms, type, upload files, read console/network errors, take screenshots, and handle alerts.
---

# Agent in Chrome

The `chrome` MCP server drives the user's real Chrome using Chrome DevTools Protocol (CDP) trusted events. Their existing sessions, logins, and cookies are active.

## Core Interaction Loop

1. **Tabs Discovery**: Always call `tabs_context` first. Identify active tabs and tab IDs. Never reuse a tab ID from a previous conversation.
2. **Tab Creation / Navigation**: Use `tabs_create` to open new URLs or `navigate` to update an existing tab.
3. **Perception**: Call `read_page` before interacting. It extracts interactive elements with refs (`e1`, `e2`, ...), accessible roles, and viewport coordinates. It automatically pierces Open Shadow DOM and iframes.
4. **Form Filling**:
   - Use `form_input` with `fields: [{ ref: "e1", value: "..." }]` for fast batch filling of inputs, dropdowns, checkboxes, radios, and contenteditables.
   - For file uploads, use `upload_file` with `tabId`, `ref` or `selector`, and the absolute `filePath`.
5. **Actions**:
   - Use `click` with `ref` or direct `(x, y)` coordinates to trigger buttons and links with trusted native browser clicks (`isTrusted: true`).
   - Use `type_text` to type text into active fields with real keystrokes.
   - Use `press_key` with key names (`Enter`, `Tab`, `Escape`, `Backspace`, `ArrowDown`) and optional modifiers (`ctrlKey`, `shiftKey`, `altKey`, `metaKey`).
   - Use `scroll` to scroll elements into view or scroll by pixels (`dy`, `dx`).
6. **Diagnostics & Error Recovery**:
   - If a form doesn't submit or a click seems ineffective, call `get_console_logs` to inspect client-side JavaScript errors.
   - Call `get_network_activity` with `failedOnly: true` to check if API endpoints returned 4xx/5xx responses.
7. **Dialogs & Alerts**:
   - If a site triggers a JavaScript `alert()`, `confirm()`, or `prompt()`, it is automatically captured without freezing the browser. Use `handle_dialog` to accept or dismiss it with prompt text.
8. **Visual Inspection**:
   - Call `screenshot` with `fullPage: true` for the complete scrolling page, or without for the visible viewport. Inspect the saved JPEG at the returned file path.

## Safety & Boundaries

- **Permissions**: If a site is not allowed, stop. Prompt the user to open the side panel and click Allow.
- **Sensitive Domains**: High-risk financial sites (banks, crypto platforms, password managers) trigger strict security guardrails.
- **Irreversible Actions**: Stop and ask for explicit confirmation before final checkout/payment submissions, account deletions, sending emails/messages, or changing passwords.
- Close only tabs created with `tabs_create`.
