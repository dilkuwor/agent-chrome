---
name: grok-in-chrome
description: Drive the user's real Chrome, including sites they are signed into, through the Grok in Chrome extension. Use when they ask to fill a form, click, type, browse, or take a screenshot in Chrome, or when they name Grok in Chrome.
---

# Grok in Chrome

The `chrome` MCP server drives the user's real Chrome. Their logins are already there. Do not open a separate automated browser for this.

If the `chrome` tools are missing, say so. They need the extension loaded from `/Users/samir/MyHD/Code/grok-in-chrome/extension`, the pairing token saved in its side panel, and a restarted Grok session.

## Loop

1. Call `tabs_context` first. Never reuse a tab id from an earlier conversation.
2. Open a new tab with `tabs_create` unless the user told you to use an existing tab.
3. Call `read_page` before you click or type. Use the refs it returns (`e1`, `e2`, ...). If a ref is missing, call `read_page` again.
4. Fill fields with `form_input`. That replaces the value and does not submit.
5. Use `click`, `type_text`, `press_key`, and `scroll` for everything else. Use `run_script` only when those tools cannot reach the control.
6. Read a screenshot from the file path `screenshot` returns.

Clicks, typing, and scrolling draw a blue cursor labeled Grok on the page. That cursor is not the Mac pointer. The tab is grouped under Grok.

## Stop

- If a tool says the site is not allowed, stop. Tell the user to click the Grok in Chrome icon and choose Allow. Do not retry until they do.
- If the extension is not connected, stop and point them at the side panel. Do not keep calling tools.
- Do not submit a payment, change a password, delete an account, or send a message unless the user explicitly asked. After filling a form, stop before the final submit unless they asked you to submit.
- Do not trigger a JavaScript alert or confirm. Those dialogs freeze the extension until the user dismisses them.
- Close only tabs you created with `tabs_create`.
- File inputs cannot be set. Ask the user to choose the file.
