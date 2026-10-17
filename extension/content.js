if (!globalThis.__agentChromeInstalled) {
  globalThis.__agentChromeInstalled = true;
  globalThis.__agentRefMap = new Map();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "page") return;
    handlePage(message.action, message.args || {})
      .then((data) => {
        if (typeof data === "object" && data !== null && "ok" in data) {
          sendResponse(data);
        } else {
          sendResponse({ ok: true, text: typeof data === "string" ? data : JSON.stringify(data), data });
        }
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  });
}

async function handlePage(action, args) {
  if (action === "read_page") return readPage();
  if (action === "get_page_text") return getPageText();
  if (action === "get_element_bounds") return getElementBounds(args);
  if (action === "form_input") return fillFields(args);
  if (action === "click") return clickElement(args);
  if (action === "type_text") return typeText(args);
  if (action === "press_key") return pressKey(args);
  if (action === "scroll") return scrollPage(args);
  throw new Error(`Unknown page action ${action}`);
}

function getPageText() {
  const title = document.title ? `Title: ${document.title}\n` : "";
  const url = `URL: ${location.href}\n\n`;
  const text = document.body ? document.body.innerText.slice(0, 25000) : "";
  return `${title}${url}${text}`;
}

// Deep query selector that traverses open shadow roots
function queryAllDeep(selector, root = document) {
  const results = [];
  function search(node) {
    if (!node) return;
    if (node.querySelectorAll) {
      try {
        const matches = node.querySelectorAll(selector);
        for (const el of matches) results.push(el);
      } catch {}
    }
    // Check shadowRoot
    if (node.shadowRoot) {
      search(node.shadowRoot);
    }
    // Traverse children for nested shadow roots
    const children = node.children || node.childNodes || [];
    for (const child of children) {
      if (child.shadowRoot) search(child.shadowRoot);
    }
  }
  search(root);
  return results;
}

function readPage() {
  const refMap = globalThis.__agentRefMap || new Map();
  refMap.clear();

  const selector = [
    "input",
    "textarea",
    "select",
    "button",
    "summary",
    "a[href]",
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='combobox']",
    "[role='option']",
    "[role='menuitem']",
    "[role='tab']",
    "[role='switch']",
    "[contenteditable='true']",
    "[tabindex='0']",
  ].join(", ");

  const nodes = queryAllDeep(selector);
  const elements = [];
  let count = 0;

  for (const el of nodes) {
    if (!isVisible(el)) continue;
    if (el instanceof HTMLInputElement && el.type === "hidden") continue;

    count += 1;
    if (count > 500) {
      break;
    }

    const ref = `e${count}`;
    refMap.set(ref, el);
    try {
      el.setAttribute("data-agent-ref", ref);
      el.setAttribute("data-grok-ref", ref);
    } catch {}

    const rect = el.getBoundingClientRect();
    const inViewport =
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.left <= (window.innerWidth || document.documentElement.clientWidth);

    elements.push({
      ref,
      element: el,
      inViewport,
      bounds: {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      desc: describe(el, ref, inViewport),
    });
  }

  // Sort in-viewport elements first for quick agent prioritization
  elements.sort((a, b) => (b.inViewport ? 1 : 0) - (a.inViewport ? 1 : 0));

  const lines = elements.map((item) => item.desc);
  const extra = count > 500 ? "\n... (more elements on page; scroll or use CSS selector)" : "";

  return (
    `Title: ${document.title}\n` +
    `URL: ${location.href}\n` +
    `Interactive Elements (${elements.length}):\n` +
    `${lines.join("\n") || "(no interactive elements)"}${extra}`
  );
}

function isVisible(el) {
  if (!(el instanceof Element) || el.hidden) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  if (el.closest("[aria-hidden='true']")) return false;

  const rect = el.getBoundingClientRect();
  const tiny = rect.width < 1 && rect.height < 1;
  const formControl =
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement;
  if (tiny && !formControl) return false;

  return true;
}

function labelFor(el) {
  const aria = el.getAttribute("aria-label");
  if (aria) return clean(aria);

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText || "")
      .join(" ");
    if (clean(text)) return clean(text);
  }

  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label?.innerText) return clean(label.innerText);
  }

  const wrap = el.closest("label");
  if (wrap?.innerText) return clean(wrap.innerText);

  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return clean(placeholder);

  const title = el.getAttribute("title");
  if (title) return clean(title);

  const name = el.getAttribute("name");
  if (name) return clean(name);

  return clean(el.innerText || el.textContent || "");
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 100);
}

function describe(el, ref, inViewport) {
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute("type");
  const role = el.getAttribute("role");
  const name = JSON.stringify(labelFor(el));
  let extra = "";

  if (el instanceof HTMLInputElement && el.type === "password") {
    extra = el.value ? " value=(set)" : "";
  } else if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.type !== "password" && el.value) {
    extra = ` value=${JSON.stringify(el.value.slice(0, 60))}`;
  } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    extra = el.checked ? " checked" : "";
  } else if (el instanceof HTMLSelectElement) {
    const options = [...el.options].slice(0, 10).map((opt) => opt.text.trim()).filter(Boolean);
    extra = ` selected=${JSON.stringify(el.value)} options=${JSON.stringify(options)}`;
  }

  if (el.disabled) extra += " disabled";
  const href = el instanceof HTMLAnchorElement && el.getAttribute("href") ? ` href=${JSON.stringify(el.getAttribute("href"))}` : "";
  const viewportTag = inViewport ? "" : " [offscreen]";
  const kind = role || tag;

  return `${ref}  ${kind}${type ? ` type=${type}` : ""} ${name}${extra}${href}${viewportTag}`;
}

function findElement(args) {
  const refMap = globalThis.__agentRefMap;
  if (args.ref && refMap && refMap.has(args.ref)) {
    const el = refMap.get(args.ref);
    if (document.contains(el)) return el;
  }

  if (args.ref) {
    const el =
      document.querySelector(`[data-agent-ref="${CSS.escape(args.ref)}"]`) ||
      document.querySelector(`[data-grok-ref="${CSS.escape(args.ref)}"]`);
    if (el) return el;
    throw new Error(`Element ${args.ref} not found on page. Call read_page again.`);
  }

  if (args.selector) {
    const el = document.querySelector(args.selector);
    if (el) return el;
    const deepMatches = queryAllDeep(args.selector);
    if (deepMatches[0]) return deepMatches[0];
    throw new Error(`No element matches ${args.selector}`);
  }

  throw new Error("Provide ref or selector. Call read_page for refs.");
}

function getElementBounds(args) {
  const el = findElement(args);
  el.scrollIntoView({ block: "center", inline: "nearest" });
  const rect = el.getBoundingClientRect();
  return {
    ok: true,
    bounds: {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    tag: el.tagName.toLowerCase(),
  };
}

async function fillFields(args) {
  const fields = Array.isArray(args.fields) && args.fields.length
    ? args.fields
    : [{ ref: args.ref, selector: args.selector, value: args.value }];

  if (!fields.length || fields.some((field) => field.value === undefined && field.value === null)) {
    throw new Error("Pass fields: [{ref, value}], or a single ref and value.");
  }

  const done = [];
  const failed = [];

  for (const field of fields) {
    try {
      const el = findElement(field);
      el.scrollIntoView({ block: "center", inline: "nearest" });
      moveCursorToNonBlocking(el);
      const problem = setValue(el, field.value);
      if (problem) failed.push(`${field.ref || field.selector}: ${problem}`);
      else done.push(field.ref || field.selector || el.tagName.toLowerCase());
    } catch (error) {
      failed.push(`${field.ref || field.selector}: ${error.message}`);
    }
  }

  const parts = [];
  if (done.length) parts.push(`Filled ${done.join(", ")}.`);
  if (failed.length) parts.push(`Failed ${failed.join("; ")}.`);
  if (failed.length && !done.length) throw new Error(parts.join(" "));
  return parts.join(" ");
}

// React 16+, Vue, Angular, and native value setter
function setValue(el, value) {
  if (el instanceof HTMLInputElement && el.type === "file") {
    return "use upload_file tool for file inputs.";
  }

  if (el instanceof HTMLSelectElement) {
    const wanted = String(value).trim().toLowerCase();
    const option = [...el.options].find(
      (item) => item.value === String(value) || item.text.trim().toLowerCase() === wanted,
    );
    if (!option) return `no option matching ${String(value)}`;
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return "";
  }

  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    const on = value === true || ["true", "on", "yes", "1"].includes(String(value).toLowerCase());
    el.checked = on;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return "";
  }

  if (el.isContentEditable) {
    el.focus();
    el.textContent = String(value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value), inputType: "insertText" }));
    return "";
  }

  const text = value == null ? "" : String(value);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, text);
  else el.value = text;

  el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return "";
}

async function clickElement(args) {
  const el = findElement(args);
  el.scrollIntoView({ block: "center", inline: "nearest" });
  moveCursorToNonBlocking(el);
  if (typeof el.focus === "function") el.focus();

  const rect = el.getBoundingClientRect();
  const event = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };

  el.dispatchEvent(new PointerEvent("pointerdown", event));
  el.dispatchEvent(new MouseEvent("mousedown", event));
  el.dispatchEvent(new PointerEvent("pointerup", event));
  el.dispatchEvent(new MouseEvent("mouseup", event));
  el.click();

  return `Clicked ${args.ref || args.selector}.`;
}

async function typeText(args) {
  const el = args.ref || args.selector ? findElement(args) : document.activeElement;
  if (!el || el === document.body || el === document.documentElement) {
    throw new Error("No element to type into. Pass a ref from read_page.");
  }

  el.scrollIntoView({ block: "center", inline: "nearest" });
  moveCursorToNonBlocking(el);
  el.focus();

  if (args.clear && "value" in el) setValue(el, "");

  if (el.isContentEditable) {
    document.execCommand("insertText", false, String(args.text ?? ""));
    return `Typed into ${args.ref || "the focused element"}.`;
  }

  if ("value" in el) {
    const next = args.clear ? String(args.text ?? "") : `${el.value || ""}${args.text ?? ""}`;
    setValue(el, next);
    return `Typed into ${args.ref || args.selector || "the focused element"}.`;
  }

  throw new Error("That element does not accept text.");
}

async function pressKey(args) {
  const key = String(args.key || "");
  if (!key) throw new Error("Missing key.");

  const targetEl = args.ref || args.selector ? findElement(args) : document.activeElement;
  if (targetEl instanceof Element) {
    targetEl.scrollIntoView({ block: "center", inline: "nearest" });
    moveCursorToNonBlocking(targetEl);
    if (typeof targetEl.focus === "function") targetEl.focus();
  }

  const target = document.activeElement || document.body;
  const init = {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    ctrlKey: Boolean(args.ctrlKey),
    altKey: Boolean(args.altKey),
    shiftKey: Boolean(args.shiftKey),
    metaKey: Boolean(args.metaKey),
  };

  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keypress", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));

  if (key === "Enter" && target instanceof HTMLInputElement && target.form) {
    target.form.requestSubmit ? target.form.requestSubmit() : target.form.submit();
  }

  return `Pressed ${key}.`;
}

async function scrollPage(args) {
  if (args.ref || args.selector) {
    const el = findElement(args);
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    moveCursorToNonBlocking(el);
    return `Scrolled ${args.ref || args.selector} into view.`;
  }

  const dy = Number(args.dy || 0);
  const dx = Number(args.dx || 0);
  window.scrollBy({ left: dx, top: dy, behavior: "smooth" });
  return `Scrolled ${dx}px horizontally, ${dy}px vertically.`;
}

// Visual cursor indicator - Non-blocking
const CURSOR_ID = "agent-chrome-cursor";

function ensureCursor() {
  const existing = document.getElementById(CURSOR_ID);
  if (existing) return existing;

  const node = document.createElement("div");
  node.id = CURSOR_ID;
  node.setAttribute("aria-hidden", "true");
  node.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "z-index:2147483647",
    "pointer-events:none",
    "display:flex",
    "align-items:flex-start",
    "gap:4px",
    "transform:translate(24px,24px)",
    "transition:transform 180ms ease-out",
    "filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))",
  ].join(";");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("viewBox", "0 0 22 22");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2 1.5 L2 16.5 L6.2 12.6 L9.4 19.2 L12 18.1 L8.7 11.6 L14.2 11.2 Z");
  path.setAttribute("fill", "#2563eb");
  path.setAttribute("stroke", "#ffffff");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);

  const label = document.createElement("span");
  label.textContent = "Agent";
  label.style.cssText =
    "margin-top:12px;background:#2563eb;color:#fff;font:600 11px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;padding:2px 6px;border-radius:999px";

  node.append(svg, label);
  (document.documentElement || document.body).appendChild(node);
  return node;
}

function moveCursorToNonBlocking(el) {
  try {
    const rect = el.getBoundingClientRect();
    const x = Math.max(4, Math.min(rect.left + rect.width / 2, window.innerWidth - 12));
    const y = Math.max(4, Math.min(rect.top + rect.height / 2, window.innerHeight - 12));
    const node = ensureCursor();
    node.style.transform = `translate(${x}px, ${y}px)`;
  } catch {}
}
