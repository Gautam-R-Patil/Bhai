// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Bhai Browser Bridge — Content Script
// Handles DOM interactions requested by the Bhai agent via the background service worker.
// Also provides page context capture for the overlay bridge (URL, title, selection, content).

// ── Cached Selection ────────────────────────────
// Debounced selection listener — caches the latest selected text
// so it's immediately available when the background script requests it.

let cachedSelection = "";
let selectionDebounceTimer = null;

document.addEventListener("selectionchange", () => {
  if (selectionDebounceTimer) clearTimeout(selectionDebounceTimer);
  selectionDebounceTimer = setTimeout(() => {
    const sel = window.getSelection();
    const next = sel ? sel.toString().trim() : "";
    // Tell Bhai's side panel, so it can show what it will focus on.
    if (next !== cachedSelection) {
      chrome.runtime.sendMessage({ type: "page_selection", text: next.slice(0, 300) }).catch(() => { /* panel closed */ });
    }
    cachedSelection = next;
  }, 250);
});

// ── Page Context Capture ────────────────────────
// Returns a snapshot of the current page for the overlay bridge.

function getPageContext() {
  const selection = window.getSelection();
  const selectedText = selection ? selection.toString().trim() : cachedSelection;

  // Extract page content — first 5000 chars of visible text
  let pageContent = "";
  try {
    // Prefer article/main content if available
    const mainEl = document.querySelector("article") ||
                   document.querySelector("main") ||
                   document.querySelector("[role='main']") ||
                   document.querySelector(".content") ||
                   document.querySelector("#content");

    if (mainEl) {
      pageContent = mainEl.innerText || "";
    } else {
      pageContent = document.body.innerText || "";
    }

    // Clean up whitespace and truncate
    pageContent = pageContent
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\t+/g, " ")
      .trim()
      .substring(0, 5000);
  } catch {
    pageContent = "";
  }

  return {
    url: window.location.href,
    title: document.title,
    selectedText: selectedText || cachedSelection,
    pageContent,
  };
}

// ── Click Indicator (visual feedback) ────────

function showClickIndicator(x, y, type = "click") {
  const circle = document.createElement("div");
  let bg = "rgba(59, 130, 246, 0.4)";
  let border = "rgba(59, 130, 246, 0.8)";

  if (type === "right") {
    bg = "rgba(239, 68, 68, 0.4)";
    border = "rgba(239, 68, 68, 0.8)";
  } else if (type === "hold") {
    bg = "rgba(34, 197, 94, 0.4)";
    border = "rgba(34, 197, 94, 0.8)";
  }

  circle.style.cssText = `
    position: fixed; left: ${x - 20}px; top: ${y - 20}px;
    width: 40px; height: 40px; border-radius: 50%;
    background: ${bg}; border: 2px solid ${border};
    pointer-events: none; z-index: 999999;
    transition: all 0.5s ease-out;
  `;
  document.body.appendChild(circle);

  setTimeout(() => {
    circle.style.transform = "scale(2)";
    circle.style.opacity = "0";
  }, 100);
  setTimeout(() => circle.remove(), 600);
}

// ── Get element at coordinates ───────────────

function getElementAt(x, y) {
  return document.elementFromPoint(x, y);
}

// ── Click at coordinates ─────────────────────

function handleClickAt(msg) {
  const { x, y, doubleClick, button, modifiers } = msg;

  showClickIndicator(x, y, button === "right" ? "right" : "click");

  const el = getElementAt(x, y);
  if (!el) return;

  const eventOpts = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: button === "right" ? 2 : button === "middle" ? 1 : 0,
    ctrlKey: (modifiers || []).includes("Control"),
    shiftKey: (modifiers || []).includes("Shift"),
    altKey: (modifiers || []).includes("Alt"),
    metaKey: (modifiers || []).includes("Meta"),
  };

  el.dispatchEvent(new MouseEvent("mousedown", eventOpts));
  el.dispatchEvent(new MouseEvent("mouseup", eventOpts));
  el.dispatchEvent(new MouseEvent("click", eventOpts));

  if (doubleClick) {
    el.dispatchEvent(new MouseEvent("mousedown", eventOpts));
    el.dispatchEvent(new MouseEvent("mouseup", eventOpts));
    el.dispatchEvent(new MouseEvent("click", eventOpts));
    el.dispatchEvent(new MouseEvent("dblclick", eventOpts));
  }

  if (el.focus && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.hasAttribute("contenteditable") || el.tabIndex >= 0)) {
    el.focus();
  }
}

// ── Type text ────────────────────────────────

function handleTypeText(msg) {
  const { text, selector } = msg;
  let target;

  if (selector) {
    target = document.querySelector(selector);
  } else {
    target = document.activeElement;
  }

  if (!target) return;

  if (target.focus) target.focus();

  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      target.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
      "value"
    ).set;

    nativeInputValueSetter.call(target, target.value + text);

    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (target.hasAttribute("contenteditable")) {
    document.execCommand("insertText", false, text);
  } else {
    for (const char of text) {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
    }
  }
}

// ── Scroll ───────────────────────────────────

function handleScroll(msg) {
  const { direction, amount, selector } = msg;
  const target = selector ? document.querySelector(selector) : window;

  const px = amount || 300;

  if (target === window || !target) {
    switch (direction) {
      case "up": window.scrollBy(0, -px); break;
      case "down": window.scrollBy(0, px); break;
      case "left": window.scrollBy(-px, 0); break;
      case "right": window.scrollBy(px, 0); break;
    }
  } else {
    switch (direction) {
      case "up": target.scrollTop -= px; break;
      case "down": target.scrollTop += px; break;
      case "left": target.scrollLeft -= px; break;
      case "right": target.scrollLeft += px; break;
    }
  }
}

// ── Keyboard ─────────────────────────────────

function handleKeyboard(msg) {
  const { key, modifiers, keyAction } = msg;
  const target = document.activeElement || document.body;

  const eventOpts = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    ctrlKey: (modifiers || []).includes("Control"),
    shiftKey: (modifiers || []).includes("Shift"),
    altKey: (modifiers || []).includes("Alt"),
    metaKey: (modifiers || []).includes("Meta"),
  };

  switch (keyAction) {
    case "down":
      target.dispatchEvent(new KeyboardEvent("keydown", eventOpts));
      break;
    case "up":
      target.dispatchEvent(new KeyboardEvent("keyup", eventOpts));
      break;
    case "press":
    default:
      target.dispatchEvent(new KeyboardEvent("keydown", eventOpts));
      target.dispatchEvent(new KeyboardEvent("keypress", eventOpts));
      target.dispatchEvent(new KeyboardEvent("keyup", eventOpts));
      break;
  }

  if (key === "Enter" && !keyAction || keyAction === "press") {
    if (target.tagName === "INPUT" && target.form) {
      target.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
  }

  if (key === "Tab" && (!keyAction || keyAction === "press")) {
    const focusables = Array.from(document.querySelectorAll(
      'input:not([type="hidden"]), textarea, select, button, a[href], [tabindex]:not([tabindex="-1"])'
    )).filter((el) => !el.disabled && el.offsetParent !== null);

    const idx = focusables.indexOf(target);
    if (idx >= 0) {
      const next = (modifiers || []).includes("Shift")
        ? focusables[idx - 1] || focusables[focusables.length - 1]
        : focusables[idx + 1] || focusables[0];
      if (next && next.focus) next.focus();
    }
  }
}

// ── Hover ────────────────────────────────────

function handleHover(msg) {
  const { x, y } = msg;
  const el = getElementAt(x, y);
  if (!el) return;

  el.dispatchEvent(new MouseEvent("mouseover", { clientX: x, clientY: y, bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseenter", { clientX: x, clientY: y, bubbles: true }));
  el.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
}

// ── Select Option ────────────────────────────

function handleSelectOption(msg) {
  const { selector, values } = msg;
  const el = document.querySelector(selector);
  if (!el || el.tagName !== "SELECT") return;

  for (const option of el.options) {
    option.selected = values.includes(option.value) || values.includes(option.text);
  }

  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// ── Message Handler ──────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  try {
    switch (msg.action) {
      // ── Page context capture for overlay bridge ──
      case "get_page_context":
        sendResponse(getPageContext());
        break;

      // ── Browser Bridge commands ──
      case "click_at":
        handleClickAt(msg);
        sendResponse({ success: true });
        break;

      case "type_text":
        handleTypeText(msg);
        sendResponse({ success: true });
        break;

      case "scroll":
        handleScroll(msg);
        sendResponse({ success: true });
        break;

      case "keyboard":
        handleKeyboard(msg);
        sendResponse({ success: true });
        break;

      case "hover":
        handleHover(msg);
        sendResponse({ success: true });
        break;

      case "select_option":
        handleSelectOption(msg);
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: `Unknown action: ${msg.action}` });
    }
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
  return true;
});
