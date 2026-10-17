if (!globalThis.__grokChromeInstalled) {
  globalThis.__grokChromeInstalled = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "page") return;
    handlePage(message.action, message.args || {})
      .then((text) => sendResponse({ ok: true, text }))
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  });
}

async function handlePage(action, args) {
  if (action === "read_page") return readPage();
  if (action === "get_page_text") return document.body ? document.body.innerText.slice(0, 12000) : "";
  if (action === "form_input") return fillFields(args);
  if (action === "click") return clickElement(args);
  if (action === "type_text") return typeText(args);
  if (action === "press_key") return pressKey(args);
  if (action === "scroll") return scrollPage(args);
  throw new Error(`Unknown page action ${action}`);
}

function readPage() {
  document.querySelectorAll("[data-grok-ref]").forEach((el) => el.removeAttribute("data-grok-ref"));
  const nodes = document.querySelectorAll(
    "input, textarea, select, button, summary, a[href], [role='button'], [role='link'], [role='textbox'], [role='checkbox'], [role='radio'], [role='combobox'], [role='option'], [contenteditable='true']",
  );
  const lines = [];
  let count = 0;
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    if (el instanceof HTMLInputElement && (el.type === "hidden" || el.type === "submit")) {
      if (el.type === "hidden") continue;
    }
    count += 1;
    if (count > 160) {
      lines.push("... more elements omitted. Scroll or use a selector.");
      break;
    }
    const ref = `e${count}`;
    el.setAttribute("data-grok-ref", ref);
    lines.push(describe(el, ref));
  }
  return `Title: ${document.title}\nURL: ${location.href}\nElements:\n${lines.join("\n") || "(no interactive elements)"}`;
}

function isVisible(el) {
  if (!(el instanceof Element) || el.hidden) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (el.closest("[aria-hidden='true']")) return false;
  const rect = el.getBoundingClientRect();
  const tiny = rect.width < 1 && rect.height < 1;
  const formControl = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
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
  return clean(el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("title") || el.innerText || "");
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function describe(el, ref) {
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute("type");
  const role = el.getAttribute("role");
  const name = JSON.stringify(labelFor(el));
  let extra = "";
  if (el instanceof HTMLInputElement && el.type === "password") {
    extra = " value=(set)" ;
    if (!el.value) extra = "";
  } else if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.type !== "password" && el.value) {
    extra = ` value=${JSON.stringify(el.value.slice(0, 80))}`;
  } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    extra = el.checked ? " checked" : "";
  } else if (el instanceof HTMLSelectElement) {
    const options = [...el.options].slice(0, 12).map((option) => option.text.trim()).filter(Boolean);
    extra = ` selected=${JSON.stringify(el.value)} options=${JSON.stringify(options)}`;
  }
  const href = el instanceof HTMLAnchorElement && el.getAttribute("href") ? ` href=${el.getAttribute("href")}` : "";
  const kind = role || tag;
  return `${ref}  ${kind}${type ? ` type=${type}` : ""} ${name}${extra}${href}`;
}

function findElement(args) {
  if (args.ref) {
    const el = document.querySelector(`[data-grok-ref="${CSS.escape(args.ref)}"]`);
    if (!el) throw new Error(`Element ${args.ref} is not on the page. Call read_page again.`);
    return el;
  }
  if (args.selector) {
    const el = document.querySelector(args.selector);
    if (!el) throw new Error(`No element matches ${args.selector}`);
    return el;
  }
  throw new Error("Provide ref or selector. Call read_page for refs.");
}

async function fillFields(args) {
  const fields = Array.isArray(args.fields) && args.fields.length
    ? args.fields
    : [{ ref: args.ref, selector: args.selector, value: args.value }];
  if (!fields.length || fields.some((field) => field.value == null)) {
    throw new Error("Pass fields: [{ref, value}], or a single ref and value.");
  }
  const done = [];
  const failed = [];
  for (const field of fields) {
    try {
      const el = findElement(field);
      el.scrollIntoView({ block: "center", inline: "nearest" });
      await moveCursorTo(el);
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

// Use the native value setter so React and Vue notice the change.
function setValue(el, value) {
  if (el instanceof HTMLInputElement && el.type === "file") {
    return "file inputs cannot be set by an extension. Ask the user to choose the file.";
  }
  if (el instanceof HTMLSelectElement) {
    const wanted = String(value).trim().toLowerCase();
    const option = [...el.options].find((item) => item.value === String(value) || item.text.trim().toLowerCase() === wanted);
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
  await moveCursorTo(el);
  if (typeof el.focus === "function") el.focus();
  await pulseCursor();
  const event = { bubbles: true, cancelable: true, view: window };
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
  await moveCursorTo(el);
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
    await moveCursorTo(targetEl);
    if (typeof targetEl.focus === "function") targetEl.focus();
  }
  const target = document.activeElement || document.body;
  const init = { key, code: key, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keypress", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  return `Pressed ${key}.`;
}

async function scrollPage(args) {
  if (args.ref || args.selector) {
    const el = findElement(args);
    el.scrollIntoView({ block: "center", inline: "nearest" });
    await moveCursorTo(el);
    return `Scrolled ${args.ref || args.selector} into view.`;
  }
  const dy = Number(args.dy || 0);
  window.scrollBy(0, dy);
  const node = document.getElementById(CURSOR_ID);
  const current = node ? cursorTranslate(node) : { x: 48, y: 48 };
  const nextY = Math.max(8, Math.min(window.innerHeight - 28, current.y + Math.max(-180, Math.min(180, dy))));
  await moveCursor(current.x, nextY);
  return `Scrolled ${dy} pixels.`;
}

const CURSOR_ID = "grok-agent-cursor";
let cursorPlaced = false;

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
    "transition:transform 320ms cubic-bezier(.2,.7,.2,1)",
    "filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))",
  ].join(";");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("viewBox", "0 0 22 22");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2 1.5 L2 16.5 L6.2 12.6 L9.4 19.2 L12 18.1 L8.7 11.6 L14.2 11.2 Z");
  path.setAttribute("fill", "#1d4ed8");
  path.setAttribute("stroke", "#ffffff");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  const label = document.createElement("span");
  label.textContent = "Grok";
  label.style.cssText = "margin-top:14px;background:#1d4ed8;color:#fff;font:600 11px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;padding:2px 6px;border-radius:999px";
  node.append(svg, label);
  (document.documentElement || document.body).appendChild(node);
  return node;
}

function cursorPoint(el) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + Math.min(Math.max(rect.width / 2, 8), 36);
  const y = rect.top + Math.min(Math.max(rect.height / 2, 8), 24);
  return {
    x: Math.max(4, Math.min(x, window.innerWidth - 8)),
    y: Math.max(4, Math.min(y, window.innerHeight - 8)),
  };
}

function cursorTranslate(node) {
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(node.style.transform || "");
  if (!match) return { x: 24, y: 24 };
  return { x: Number(match[1]), y: Number(match[2]) };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function moveCursor(x, y) {
  const node = ensureCursor();
  if (!cursorPlaced) {
    node.style.transition = "none";
    node.style.transform = "translate(24px, 24px)";
    node.getBoundingClientRect();
    node.style.transition = "transform 320ms cubic-bezier(.2,.7,.2,1)";
    cursorPlaced = true;
  }
  node.style.transform = `translate(${x}px, ${y}px)`;
  await wait(340);
}

async function moveCursorTo(el) {
  const point = cursorPoint(el);
  await moveCursor(point.x, point.y);
}

async function pulseCursor() {
  const svg = document.getElementById(CURSOR_ID)?.querySelector("svg");
  if (!svg) return;
  svg.style.transformOrigin = "2px 2px";
  svg.style.transition = "transform 80ms ease";
  svg.style.transform = "scale(0.82)";
  await wait(90);
  svg.style.transform = "scale(1)";
}
