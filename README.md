# Grok in Chrome

A Chrome extension and a local MCP server. Grok and AGY can read, click, and fill forms in the Chrome you already use, with the logins already in that browser.

The extension does not send pages anywhere by itself. A tool result goes back to whichever agent called it, the same way any other MCP tool works.

## What you get

- List tabs, open a tab, and navigate
- Read the page and fill forms, including React-style inputs
- Click, type, press keys, and scroll
- Save a screenshot to `~/.grok-in-chrome/shots/`
- Ask before the agent uses a site

Agent tabs are grouped under **Grok**, including a tab the agent starts using after it is already open. When Grok clicks, types, or scrolls, a blue cursor labeled Grok moves on the page. That cursor is drawn in the page. It is not the Mac pointer. A red badge means a site is waiting for Allow.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose:

   `/Users/samir/MyHD/Code/grok-in-chrome/extension`

4. Click the puzzle piece, pin **Grok in Chrome**, and open the side panel.
5. Pair it. The token is created the first time Grok or AGY starts the server:

   ```bash
   node /Users/samir/MyHD/Code/grok-in-chrome/server/index.mjs --print-token
   ```

   Paste that token into the side panel, or choose the file `~/.grok-in-chrome/token`.
6. Restart Grok and AGY so they load the `chrome` MCP server. The side panel should say **Connected** once a session is running.

Grok is configured in `~/.grok/config.toml`. AGY is configured with `agy mcp add chrome`.

## Using it

In Grok or AGY, ask it to fill a form or use a site in Chrome. The first time it touches a site, the side panel asks you to allow that origin. Turn on **Allow every site** only if you want the agent to skip that question.

It will not submit a payment, change a password, or send a message unless you ask. File inputs still need you to choose the file. Pages inside a cross-origin frame are not filled from the top page.

## Safety

This lets a local agent act as you on sites you allow, including sites where you are signed in. Remove a site from the side panel when you are done. The pairing token is the shared secret between the agent and the extension. It stays in `~/.grok-in-chrome/token` with mode `600`.

## Tools

`tabs_context`, `tabs_create`, `tabs_close`, `navigate`, `read_page`, `get_page_text`, `form_input`, `click`, `type_text`, `press_key`, `scroll`, `screenshot`, `run_script`.

## Checks

```bash
node /Users/samir/MyHD/Code/grok-in-chrome/server/test.mjs
node /Users/samir/MyHD/Code/grok-in-chrome/server/smoke.mjs
```

`test.mjs` checks the MCP bridge. `smoke.mjs` loads the extension in a temporary Brave window and fills a local form. Install it in your normal Chrome from `chrome://extensions`. Google Chrome no longer accepts `--load-extension`.
