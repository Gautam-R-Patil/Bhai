// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Bhai Browser Bridge — Background Service Worker
// Maintains a WebSocket connection to the Bhai agent and routes
// commands between Bhai and the user's Chrome browser.
// Also provides overlay bridge: context menus, page capture, and
// forwarding user messages/selections/page context to the Bhai overlay chat.

// ── State ────────────────────────────────────

// Bridge socket (port 18800): command/response channel that lets Bhai drive
// Chrome. Auth via first message {type:"auth", token}.
let ws = null;
let authenticated = false;
// Default to the Chrome Bridge port. 18792 was the old default (overlay
// chat server), but that's a different service requiring localToken auth
// and speaking a different protocol — connecting there produces
// confusing ERR_CONNECTION_REFUSED / 4001-close errors. autoDiscover()
// will update serverUrl to whatever the bridge advertises.
let serverUrl = "ws://127.0.0.1:18800";
let discoveryUrl = "http://127.0.0.1:18800/discover";
let authToken = "";
let reconnectDelay = 1000;
let reconnectTimer = null;
let heartbeatTimer = null;
let discoveryTimer = null;
let connectionAttempts = 0;
let discoveryAttempts = 0;
let lastAtlasResponse = "";

// Overlay socket (port 18792): auxiliary chat/page-context relay. Separate
// from the bridge so the two never share connection state. Auth via the
// ?localToken= query param at handshake time (the overlay closes token-less
// handshakes with code 4001), mirroring overlay.html.
let overlayWs = null;
let overlayUrl = "ws://127.0.0.1:18792";
let overlayToken = "";
let overlayReconnectTimer = null;
let overlayReconnectDelay = 1000;

const MAX_RECONNECT_DELAY = 60000;
const HEARTBEAT_INTERVAL = 20000; // 20s keep-alive (within MV3 30s limit)
const DISCOVERY_INTERVAL = 5000;
const MAX_DISCOVERY_INTERVAL = 60000;

// Pin the active tab at the start of a command to prevent race conditions
// when the user manually switches tabs during command execution
async function withActiveTab(fn) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab");
  return fn(tab.id);
}

// ── WebSocket Connection ─────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  // The bridge requires the auth token in its first message; connecting without
  // one just trips the server's 5s auth timeout. Discover first instead.
  if (!authToken) {
    autoDiscover().then((found) => { if (!found) startDiscovery(); });
    return;
  }

  try {
    ws = new WebSocket(serverUrl);
  } catch (err) {
    console.error("[ATLAS Bridge] WebSocket creation failed:", err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[ATLAS Bridge] Connected to Bhai bridge");
    connectionAttempts = 0;
    reconnectDelay = 1000;
    ws.send(JSON.stringify({ type: "auth", token: authToken }));
    startHeartbeat();
    updateBadge(true);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (err) {
      console.error("[ATLAS Bridge] Invalid message:", err);
    }
  };

  ws.onclose = (event) => {
    console.log(`[ATLAS Bridge] Bridge disconnected: code=${event.code} reason=${event.reason}`);
    authenticated = false;
    stopHeartbeat();
    updateBadge(false);

    // 4003 = invalid token: the cached token is stale, re-discover to refresh it.
    if (event.code === 4003) {
      authToken = "";
      chrome.storage.local.remove(["authToken", "discoveredAt"]);
      setTimeout(() => { autoDiscover().then((found) => { if (!found) startDiscovery(); }); }, 500);
      return;
    }
    // 4001 = single-connection conflict: another extension instance holds the
    // bridge. Don't tight-loop reconnect.
    if (event.code === 4001) return;
    scheduleReconnect();
  };

  ws.onerror = () => {
    // The WS onerror event has no useful message; the real reason appears in onclose
    console.warn("[ATLAS Bridge] Bridge WebSocket error (Bhai may not be running yet)");
  };
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopHeartbeat();
  if (ws) {
    ws.close(1000, "User disconnect");
    ws = null;
  }
  authenticated = false;
  updateBadge(false);
}

// ── Overlay Socket (chat / page-context relay) ─

function connectOverlay() {
  if (overlayWs && (overlayWs.readyState === WebSocket.CONNECTING || overlayWs.readyState === WebSocket.OPEN)) {
    return;
  }
  if (!overlayToken) return; // no credential yet — discovery supplies it

  const url = `${overlayUrl}?localToken=${encodeURIComponent(overlayToken)}`;
  try {
    overlayWs = new WebSocket(url);
  } catch (err) {
    console.error("[ATLAS Bridge] Overlay WebSocket creation failed:", err);
    scheduleOverlayReconnect();
    return;
  }

  overlayWs.onopen = () => {
    console.log("[ATLAS Bridge] Connected to Bhai overlay");
    overlayReconnectDelay = 1000;
  };

  overlayWs.onmessage = (event) => {
    try {
      handleOverlayMessage(JSON.parse(event.data));
    } catch (err) {
      console.error("[ATLAS Bridge] Invalid overlay message:", err);
    }
  };

  overlayWs.onclose = (event) => {
    console.log(`[ATLAS Bridge] Overlay disconnected: code=${event.code} reason=${event.reason}`);
    // 4001 = rejected localToken; re-discover to refresh it rather than loop.
    if (event.code === 4001) {
      overlayToken = "";
      setTimeout(() => { autoDiscover(); }, 500);
      return;
    }
    scheduleOverlayReconnect();
  };

  overlayWs.onerror = () => {
    console.warn("[ATLAS Bridge] Overlay WebSocket error");
  };
}

function disconnectOverlay() {
  if (overlayReconnectTimer) {
    clearTimeout(overlayReconnectTimer);
    overlayReconnectTimer = null;
  }
  if (overlayWs) {
    overlayWs.close(1000, "User disconnect");
    overlayWs = null;
  }
}

function scheduleOverlayReconnect() {
  if (overlayReconnectTimer) return;
  const delay = Math.min(overlayReconnectDelay * 2, MAX_RECONNECT_DELAY);
  overlayReconnectDelay = delay;
  overlayReconnectTimer = setTimeout(() => {
    overlayReconnectTimer = null;
    connectOverlay();
  }, delay);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  connectionAttempts++;
  const delay = connectionAttempts < 3
    ? 1000
    : Math.min(reconnectDelay * Math.pow(2, Math.min(connectionAttempts - 3, 6)), MAX_RECONNECT_DELAY);
  console.log(`[ATLAS Bridge] Reconnecting in ${delay}ms (attempt ${connectionAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ── Badge / Status ───────────────────────────

function updateBadge(connected) {
  const color = connected ? "#22c55e" : "#ef4444";
  const text = connected ? "ON" : "";
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

let _badgeActivityTimer = null;
let _badgeFrameIdx = 0;
const _badgeFrames = ['⬤', '○'];   // Pulse between filled/hollow

function setBadgeActive(active) {
  if (active) {
    if (_badgeActivityTimer) return;
    chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" });
    _badgeFrameIdx = 0;
    _badgeActivityTimer = setInterval(() => {
      chrome.action.setBadgeText({ text: _badgeFrames[_badgeFrameIdx % 2] });
      _badgeFrameIdx++;
    }, 600);
  } else {
    if (_badgeActivityTimer) { clearInterval(_badgeActivityTimer); _badgeActivityTimer = null; }
    updateBadge(authenticated);
  }
}

// Track last N actions for the popup activity log
const _actionLog = [];
const MAX_ACTION_LOG = 6;

function logAction(type, detail) {
  const entry = { type, detail: (detail || '').substring(0, 60), ts: Date.now() };
  _actionLog.unshift(entry);
  if (_actionLog.length > MAX_ACTION_LOG) _actionLog.pop();
  chrome.runtime.sendMessage({ type: 'atlas_action', entry }).catch(() => {});
}

// ── Send Message to Bhai Overlay ────────────
// Sends a chat message through the WebSocket to the overlay chat server.
// Messages include meta.source = "chrome-extension" so the server can
// detect browser context and prepend URL info for the agent.

function sendToAtlas(text, meta = {}) {
  if (!overlayWs || overlayWs.readyState !== WebSocket.OPEN) {
    console.warn("[ATLAS Bridge] Cannot send — overlay not connected");
    return false;
  }

  const payload = {
    type: "chat",
    text,
    meta: {
      source: "chrome-extension",
      ...meta,
    },
  };

  overlayWs.send(JSON.stringify(payload));
  console.log(`[ATLAS Bridge] Sent to overlay: ${text.substring(0, 100)}...`);
  return true;
}

// ── Handle Messages from Bhai Server ────────

// Bridge socket (18800): auth handshake + command/response traffic only.
function handleServerMessage(msg) {
  if (msg.type === "auth_ok") {
    authenticated = true;
    console.log("[ATLAS Bridge] Bridge authenticated successfully");
    return;
  }

  if (msg.type === "auth_failed") {
    console.error("[ATLAS Bridge] Bridge authentication failed:", msg.error);
    authenticated = false;
    authToken = "";
    // Clear the stale cached token so the next boot doesn't reuse it
    chrome.storage.local.remove(["authToken", "discoveredAt"]);
    // Immediately re-discover to fetch the current session token
    if (ws) ws.close(1000, "re-auth");
    setTimeout(() => {
      autoDiscover().then((found) => { if (!found) startDiscovery(); });
    }, 500);
    return;
  }

  // Heartbeat ping from server
  if (msg.type === "ping") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "pong" }));
    }
    return;
  }

  // Command from Bhai (Browser Bridge mode)
  if (msg.id && msg.type) {
    handleCommand(msg);
  }
}

// Overlay socket (18792): chat replies relayed to the popup.
function handleOverlayMessage(msg) {
  if (msg.type === "ready") {
    console.log("[ATLAS Bridge] Overlay server ready");
    return;
  }

  if (msg.type === "response") {
    lastAtlasResponse = msg.text || "";
    chrome.runtime.sendMessage({
      type: "atlas_response",
      text: lastAtlasResponse,
    }).catch(() => { /* popup not open */ });
    return;
  }

  if (msg.type === "progress" || msg.type === "thinking" || msg.type === "thinking_content") {
    chrome.runtime.sendMessage({
      type: "atlas_progress",
      text: msg.text || "",
    }).catch(() => { /* popup not open */ });
    return;
  }

  if (msg.type === "error") {
    chrome.runtime.sendMessage({
      type: "atlas_error",
      text: msg.text || "Something went wrong",
    }).catch(() => { /* popup not open */ });
  }
}

// ── Context Menus ────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // Remove existing menus first to avoid duplicates
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "atlas-ask-page",
      title: "Ask Bhai about this page",
      contexts: ["page"],
    });

    chrome.contextMenus.create({
      id: "atlas-ask-selection",
      title: "Ask Bhai about this",
      contexts: ["selection"],
    });

    console.log("[ATLAS Bridge] Context menus registered");
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;

  const url = tab.url || "unknown";
  const title = tab.title || "Untitled";

  if (info.menuItemId === "atlas-ask-page") {
    const message = `[From browser: ${url}] User asks about this page: "${title}"`;
    sendToAtlas(message, { url, title, action: "ask_page" });
  }

  if (info.menuItemId === "atlas-ask-selection") {
    const selectedText = info.selectionText || "";
    const message = `[From browser: ${url}] User asks about: "${selectedText}"`;
    sendToAtlas(message, { url, title, selectedText, action: "ask_selection" });
  }
});

// ── Page Context Capture (via content script) ─

async function capturePageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.id) return null;

    // Skip restricted URLs
    if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) {
      return { url: tab.url, title: tab.title || "", selectedText: "", pageContent: "" };
    }

    const results = await chrome.tabs.sendMessage(tab.id, { action: "get_page_context" });
    return results;
  } catch (err) {
    // Content script not loaded — fall back to tab info
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return {
        url: tab?.url || "",
        title: tab?.title || "",
        selectedText: "",
        pageContent: "",
      };
    } catch {
      return null;
    }
  }
}

// ── Command Dispatcher (Browser Bridge) ──────

async function handleCommand(cmd) {
  const { id, type, payload } = cmd;

  // Activate badge + log action
  setBadgeActive(true);
  const actionLabels = {
    click_at: `Clicking (${payload?.x|0},${payload?.y|0})`,
    type_text: `Typing "${(payload?.text||'').substring(0,25)}"`,
    scroll: `Scrolling ${payload?.direction||'down'} ${payload?.amount||''}px`,
    navigate: `→ ${(payload?.url||'').replace(/^https?:\/\/(www\.)?/,'')}`,
    scan_elements: 'Scanning page elements',
    hover: `Hovering (${payload?.x|0},${payload?.y|0})`,
    screenshot: 'Taking screenshot',
    execute_js: 'Running script',
    keyboard: `Key: ${payload?.key||payload?.combo||''}`,
  };
  const actionDetail = actionLabels[type] || type;
  logAction(type, actionDetail);

  try {
    let result;

    switch (type) {
      case "get_active_tab":
        result = await getActiveTab();
        break;

      case "get_all_tabs":
        result = await getAllTabs();
        break;

      case "scan_elements":
        result = await scanElements(payload);
        break;

      case "click_at":
        // Pass element label text for HUD display if available
        payload.elementLabel = actionDetail.replace('Clicking ','');
        result = await clickAt(payload);
        break;

      case "type_text":
        result = await typeText(payload);
        break;

      case "scroll":
        result = await scroll(payload);
        break;

      case "execute_js":
        result = await executeJS(payload);
        break;

      case "navigate":
        result = await navigate(payload);
        break;

      case "go_back":
        result = await goBack();
        break;

      case "screenshot":
        result = await captureScreenshot(payload);
        break;

      case "switch_tab":
        result = await switchTab(payload);
        break;

      case "close_tab":
        result = await closeTab(payload);
        break;

      case "keyboard":
        result = await keyboard(payload);
        break;

      case "hover":
        result = await hover(payload);
        break;

      case "select_option":
        result = await selectOption(payload);
        break;

      case "wait_for":
        result = await waitFor(payload);
        break;

      case "cdp":
        result = await rawCDP(payload);
        break;

      case "captcha_frames":
        result = await captchaFrames();
        break;

      case "mouse_path":
        result = await mousePath(payload);
        break;

      default:
        throw new Error(`Unknown command: ${type}`);
    }

    sendResponse(id, true, result);
    setBadgeActive(false);
  } catch (err) {
    sendResponse(id, false, null, err.message || String(err));
    setBadgeActive(false);
  }
}

function sendResponse(id, success, data, error) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const msg = { id, success };
  if (data !== undefined && data !== null) msg.data = data;
  if (error) msg.error = error;
  ws.send(JSON.stringify(msg));
}

// ── Command Implementations ──────────────────

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return null;
  return {
    id: tab.id,
    index: tab.index,
    title: tab.title || "",
    url: tab.url || "",
    active: true,
    windowId: tab.windowId,
    // A click that starts a navigation: Bhai waits for it instead of reporting the old page.
    status: tab.status || "",
    pendingUrl: tab.pendingUrl || "",
  };
}

async function getAllTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: t.id,
    index: t.index,
    title: t.title || "",
    url: t.url || "",
    active: t.active || false,
    windowId: t.windowId,
  }));
}

async function scanElements(payload) {
  // Use lastFocusedWindow (not currentWindow) so we get the browser window,
  // not the DevTools or extension popup which may be focused instead.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab");

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: scanPageElements,
  });

  const allElements = [];
  const seenCoords = new Set();

  for (const frame of results) {
    if (!frame.result) continue;
    for (const el of frame.result) {
      const key = `${el.x},${el.y}`;
      if (seenCoords.has(key)) continue;
      seenCoords.add(key);
      allElements.push(el);
    }
  }

  allElements.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (Math.abs(b.y - a.y) > 5) return a.y - b.y;
    return a.x - b.x;
  });

  const labeled = allElements.slice(0, 400).map((el, i) => ({
    label: i + 1,
    x: el.x,
    y: el.y,
    tag: el.tag,
    text: el.text,
    atlasId: el.atlasId,
    editorType: el.editorType,
  }));

  return { elements: labeled };
}

function scanPageElements() {
  // Runs inside the page (executeScript serializes only this function), so its
  // helpers must live in here too: an outside helper is a ReferenceError there.
  function detectSpecialEditors() {
    const editors = [];
    const ts = Date.now();

    // ── Code Editors ──

    // Monaco Editor (VS Code, Scaler, GitHub editor, etc.)
    document.querySelectorAll('.monaco-editor').forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) return;
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const atlasId = `atlas-editor-monaco-${ts}-${i}`;
      el.setAttribute('data-atlas-id', atlasId);
      editors.push({ x, y, tag: 'code-editor', text: 'Code Editor (Monaco)', score: 25, atlasId, editorType: 'monaco' });
    });

    // CodeMirror 6
    document.querySelectorAll('.cm-editor').forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) return;
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const atlasId = `atlas-editor-cm6-${ts}-${i}`;
      el.setAttribute('data-atlas-id', atlasId);
      editors.push({ x, y, tag: 'code-editor', text: 'Code Editor (CodeMirror)', score: 25, atlasId, editorType: 'codemirror6' });
    });

    // CodeMirror 5 (skip if already detected as CM6)
    document.querySelectorAll('.CodeMirror').forEach((el, i) => {
      if (el.closest('.cm-editor')) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) return;
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const atlasId = `atlas-editor-cm5-${ts}-${i}`;
      el.setAttribute('data-atlas-id', atlasId);
      editors.push({ x, y, tag: 'code-editor', text: 'Code Editor (CodeMirror)', score: 25, atlasId, editorType: 'codemirror5' });
    });

    // Ace Editor
    document.querySelectorAll('.ace_editor').forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) return;
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const atlasId = `atlas-editor-ace-${ts}-${i}`;
      el.setAttribute('data-atlas-id', atlasId);
      editors.push({ x, y, tag: 'code-editor', text: 'Code Editor (Ace)', score: 25, atlasId, editorType: 'ace' });
    });

    // ── Rich Text Editors ──

    // Quill
    document.querySelectorAll('.ql-editor[contenteditable]').forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) return;
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const atlasId = `atlas-editor-quill-${ts}-${i}`;
      el.setAttribute('data-atlas-id', atlasId);
      editors.push({ x, y, tag: 'rich-editor', text: 'Rich Text Editor (Quill)', score: 25, atlasId, editorType: 'quill' });
    });

    // TinyMCE
    document.querySelectorAll('.tox-tinymce').forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) return;
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const atlasId = `atlas-editor-tinymce-${ts}-${i}`;
      el.setAttribute('data-atlas-id', atlasId);
      editors.push({ x, y, tag: 'rich-editor', text: 'Rich Text Editor (TinyMCE)', score: 25, atlasId, editorType: 'tinymce' });
    });

    // ProseMirror (also covers Tiptap which extends it)
    document.querySelectorAll('.ProseMirror[contenteditable]').forEach((el, i) => {
      const isTiptap = !!el.closest('.tiptap') || el.classList.contains('tiptap');
      const rect = el.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) return;
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const type = isTiptap ? 'tiptap' : 'prosemirror';
      const label = isTiptap ? 'Tiptap' : 'ProseMirror';
      const atlasId = `atlas-editor-${type}-${ts}-${i}`;
      el.setAttribute('data-atlas-id', atlasId);
      editors.push({ x, y, tag: 'rich-editor', text: `Rich Text Editor (${label})`, score: 25, atlasId, editorType: type });
    });

    // Slate
    document.querySelectorAll('[data-slate-editor]').forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) return;
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const atlasId = `atlas-editor-slate-${ts}-${i}`;
      el.setAttribute('data-atlas-id', atlasId);
      editors.push({ x, y, tag: 'rich-editor', text: 'Rich Text Editor (Slate)', score: 25, atlasId, editorType: 'slate' });
    });

    // Draft.js
    document.querySelectorAll('.DraftEditor-root').forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) return;
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const atlasId = `atlas-editor-draftjs-${ts}-${i}`;
      el.setAttribute('data-atlas-id', atlasId);
      editors.push({ x, y, tag: 'rich-editor', text: 'Rich Text Editor (Draft.js)', score: 25, atlasId, editorType: 'draftjs' });
    });

    return editors;
  }

  const els = Array.from(document.querySelectorAll("*"));

  const activeModals = els.filter((el) => {
    const role = el.getAttribute("role");
    if (role !== "dialog" && role !== "menu" && role !== "alertdialog" && role !== "listbox") return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    } catch { return false; }
    const rect = el.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) return false;
    return true;
  });

  let activeModalRect = null;
  if (activeModals.length > 0) {
    activeModalRect = activeModals[activeModals.length - 1].getBoundingClientRect();
  }

  const candidateMap = [];
  const seenCoords = new Set();

  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const className = el.className;
    const hasOnClick = el.hasAttribute("onclick");

    const isNativeInt = ["a", "button", "input", "textarea", "select", "summary"].includes(tag);
    const isRoleInt = ["button", "link", "tab", "menuitem", "checkbox", "radio", "switch", "option", "combobox", "listbox", "treeitem"].includes(role || "");
    const isContentEditable = el.hasAttribute("contenteditable");
    const hasTabIndex = el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1";
    const hasAriaPopup = el.hasAttribute("aria-haspopup");
    const hasAriaExpanded = el.hasAttribute("aria-expanded");
    const hasAriaControls = el.hasAttribute("aria-controls");

    let hasCursorPointer = false;
    let hasButtonClass = false;

    if (!isNativeInt && !isRoleInt && !hasOnClick && !isContentEditable && !hasAriaPopup && !hasAriaExpanded) {
      if (typeof className === "string") {
        const lowerClass = className.toLowerCase();
        if (lowerClass.includes("btn") || lowerClass.includes("button") || lowerClass.includes("dropdown")) {
          hasButtonClass = true;
        }
      }
      try {
        const style = window.getComputedStyle(el);
        if (style.cursor === "pointer") hasCursorPointer = true;
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      } catch { continue; }
    }

    if (!(isNativeInt || isRoleInt || hasOnClick || isContentEditable || hasTabIndex || hasCursorPointer || hasButtonClass || hasAriaPopup || hasAriaExpanded || hasAriaControls)) {
      continue;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) continue;

    const isInScrollableContainer = (() => {
      let parent = el.parentElement;
      while (parent && parent !== document.documentElement) {
        const ps = window.getComputedStyle(parent);
        if ((ps.overflowY === "auto" || ps.overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) {
          return true;
        }
        parent = parent.parentElement;
      }
      return false;
    })();

    if (!isInScrollableContainer) {
      if (rect.top > window.innerHeight * 2 || rect.bottom < -window.innerHeight) continue;
      if (rect.left > window.innerWidth * 2 || rect.right < -window.innerWidth) continue;
    }

    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

    if (activeModalRect) {
      if (x < activeModalRect.left || x > activeModalRect.right || y < activeModalRect.top || y > activeModalRect.bottom) {
        continue;
      }
    }

    const coordKey = `${x},${y}`;
    if (seenCoords.has(coordKey)) continue;
    seenCoords.add(coordKey);

    const text = el.innerText?.replace(/\n/g, " ").substring(0, 40)
      || el.placeholder
      || el.value?.substring(0, 40)
      || el.getAttribute("aria-label")
      || el.getAttribute("title")
      || "";

    let score = 0;
    if (isNativeInt || isRoleInt) score += 10;
    if (hasAriaPopup || hasAriaExpanded) score += 8;
    if (text.trim().length > 0) score += 5;
    if (hasCursorPointer) score += 3;
    if (hasButtonClass) score += 2;

    const atlasId = `atlas-el-${Date.now()}-${i}`;
    el.setAttribute("data-atlas-id", atlasId);

    candidateMap.push({ x, y, tag, text: text.trim(), score, atlasId });
  }

    // ── Shadow DOM traversal ──
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (!el.shadowRoot) continue;
      const shadowEls = Array.from(el.shadowRoot.querySelectorAll('*'));
      for (const shadowEl of shadowEls) {
        const sTag = shadowEl.tagName?.toLowerCase() || '';
        const sRole = shadowEl.getAttribute?.('role') || '';
        const isInt = ['a', 'button', 'input', 'textarea', 'select'].includes(sTag) ||
                      ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio'].includes(sRole) ||
                      shadowEl.hasAttribute?.('contenteditable');
        if (!isInt) continue;
        const sRect = shadowEl.getBoundingClientRect();
        if (sRect.width < 5 || sRect.height < 5) continue;
        const sx = Math.round(sRect.left + sRect.width / 2);
        const sy = Math.round(sRect.top + sRect.height / 2);
        const sKey = `${sx},${sy}`;
        if (seenCoords.has(sKey)) continue;
        seenCoords.add(sKey);
        const sText = shadowEl.innerText?.replace(/\n/g, ' ').substring(0, 40) ||
                      shadowEl.getAttribute?.('aria-label') || '';
        const sAtlasId = `atlas-shadow-${Date.now()}-${i}`;
        shadowEl.setAttribute('data-atlas-id', sAtlasId);
        candidateMap.push({ x: sx, y: sy, tag: sTag, text: sText.trim(), score: 10, atlasId: sAtlasId });
      }
    }

    // ── Merge editor detection ──
    const editorElements = detectSpecialEditors();
    const editorCoords = new Set(editorElements.map(e => `${e.x},${e.y}`));
    // Remove normal elements at same coords as editors (editors take priority)
    const filtered = candidateMap.filter(el => !editorCoords.has(`${el.x},${el.y}`));
    const merged = [...editorElements, ...filtered];

    merged.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (Math.abs(b.y - a.y) > 5) return a.y - b.y;
      return a.x - b.x;
    });

    return merged.slice(0, 150);
}

// ── Shared visual feedback injected into real tabs ──────────────────────────

function injectAtlasVisuals(tabId) {
  // Inject keyframes + HUD CSS once per tab
  chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: () => {
      if (document.getElementById('__atlasKF')) return;
      const s = document.createElement('style');
      s.id = '__atlasKF';
      s.textContent = `
        @keyframes atlasRipple{0%{transform:scale(.3);opacity:1}100%{transform:scale(2.2);opacity:0}}
        @keyframes atlasDot{0%{transform:scale(1.8);opacity:1}100%{transform:scale(.6);opacity:0}}
        @keyframes atlasFade{0%{opacity:.8}100%{opacity:0}}
        @keyframes atlasPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}
        @keyframes atlasScrollFadeDown{0%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(16px)}}
        @keyframes atlasScrollFadeUp{0%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(-16px)}}
      `;
      document.head.appendChild(s);
    }
  }).catch(() => {});
}

function showAtlasHUD(tabId, label, done = false) {
  chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: (lbl, isDone) => {
      const ID = '__atlasHUD';
      let hud = document.getElementById(ID);
      if (isDone) {
        if (hud) { hud.style.opacity = '0'; setTimeout(() => hud?.remove(), 300); }
        return;
      }
      if (!hud) {
        hud = document.createElement('div');
        hud.id = ID;
        hud.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:#3b82f6;display:inline-block;animation:atlasPulse 1.2s ease-in-out infinite;flex-shrink:0"></span>' +
                        '<span id="__atlasHUDtxt" style="margin-left:7px;font-size:11px;font-weight:500;color:#e2e8f0;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px"></span>';
        hud.style.cssText = 'position:fixed;top:10px;right:10px;display:flex;align-items:center;padding:6px 12px;border-radius:20px;background:rgba(15,23,42,0.92);border:1px solid #1e3a5f;backdrop-filter:blur(8px);pointer-events:none;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.4);transition:opacity .3s ease;opacity:0;';
        document.body.appendChild(hud);
        requestAnimationFrame(() => { hud.style.opacity = '1'; });
      }
      const txt = document.getElementById('__atlasHUDtxt');
      if (txt) txt.textContent = lbl;
    },
    args: [label, done]
  }).catch(() => {});
}

// A real click through CDP: trusted input the page can't tell from a person's,
// that lands in iframes too, and that page scripts can't break (the synthetic
// path below runs in the page and dies with whatever the page or another
// extension has patched). False when the debugger can't attach (chrome:// pages).
async function cdpClick(tabId, payload) {
  try {
    await holdCDP(tabId);
  } catch {
    return false;
  }
  const x = Number(payload.x) || 0, y = Number(payload.y) || 0;
  const button = payload.button === "right" ? "right" : payload.button === "middle" ? "middle" : "left";
  const buttons = button === "left" ? 1 : button === "right" ? 2 : 4;
  const modifiers = (payload.modifiers || []).reduce((m, k) => m | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[k] || 0), 0);
  const send = (type, extra) => chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type, x, y, modifiers, ...extra });
  await send("mouseMoved", { button: "none", buttons: 0 });
  for (let c = 1; c <= (payload.doubleClick ? 2 : 1); c++) {
    await send("mousePressed", { button, buttons, clickCount: c });
    await send("mouseReleased", { button, buttons: 0, clickCount: c });
  }
  return true;
}

async function clickAt(payload) {
  return withActiveTab(async (tabId) => {
    injectAtlasVisuals(tabId);
    const elementLabel = payload.elementLabel || '';
    if (elementLabel) showAtlasHUD(tabId, `🖱 Clicking "${elementLabel.substring(0, 30)}"`);

    if (await cdpClick(tabId, payload)) {
      // The click indicator only; the click itself already happened.
      chrome.scripting.executeScript({
        target: { tabId },
        func: (x, y) => {
          const ring = document.createElement('div');
          ring.style.cssText = `position:fixed;left:${x-24}px;top:${y-24}px;width:48px;height:48px;border-radius:50%;border:2px solid rgba(59,130,246,.9);pointer-events:none;z-index:2147483646;animation:atlasRipple .6s cubic-bezier(.4,0,.2,1) forwards;`;
          const dot = document.createElement('div');
          dot.style.cssText = `position:fixed;left:${x-4}px;top:${y-4}px;width:8px;height:8px;border-radius:50%;background:#3b82f6;pointer-events:none;z-index:2147483647;animation:atlasDot .4s cubic-bezier(.4,0,.2,1) forwards;`;
          [ring, dot].forEach(e => document.body.appendChild(e));
          setTimeout(() => [ring, dot].forEach(e => e.remove()), 650);
        },
        args: [payload.x, payload.y],
      }).catch(() => {});
      if (elementLabel) showAtlasHUD(tabId, '', true);
      return { success: true, method: "cdp" };
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (x, y, doubleClick, button, modifiers) => {
        // Redesigned click indicator: crosshair + ripple + dot
        const colors = { left: ['rgba(59,130,246,0.15)','rgba(59,130,246,.9)','#3b82f6'], right: ['rgba(239,68,68,.15)','rgba(239,68,68,.9)','#ef4444'], middle: ['rgba(168,85,247,.15)','rgba(168,85,247,.9)','#a855f7'] };
        const [, border, solid] = colors[button || 'left'] || colors.left;
        const ring = document.createElement('div');
        ring.style.cssText = `position:fixed;left:${x-24}px;top:${y-24}px;width:48px;height:48px;border-radius:50%;border:2px solid ${border};pointer-events:none;z-index:2147483646;animation:atlasRipple .6s cubic-bezier(.4,0,.2,1) forwards;`;
        const dot = document.createElement('div');
        dot.style.cssText = `position:fixed;left:${x-4}px;top:${y-4}px;width:8px;height:8px;border-radius:50%;background:${solid};pointer-events:none;z-index:2147483647;animation:atlasDot .4s cubic-bezier(.4,0,.2,1) forwards;`;
        const mkL = (h) => { const l = document.createElement('div'); l.style.cssText=`position:fixed;${h?`left:${x-12}px;top:${y-1}px;width:24px;height:2px;`:`left:${x-1}px;top:${y-12}px;width:2px;height:24px;`}background:${solid};opacity:.6;pointer-events:none;z-index:2147483647;animation:atlasFade .5s ease-out forwards;`; return l; };
        [ring, dot, mkL(true), mkL(false)].forEach(e => document.body.appendChild(e));
        setTimeout(() => [ring, dot].forEach(e => e.remove()), 650);
        setTimeout(() => document.querySelectorAll('[style*="atlasFade"]').forEach(e => e.remove()), 560);

        const el = document.elementFromPoint(x, y);
        if (!el) return { success: false, error: "No element at coordinates" };

        const opts = {
          bubbles: true, cancelable: true, clientX: x, clientY: y,
          button: button === "right" ? 2 : button === "middle" ? 1 : 0,
          ctrlKey: (modifiers || []).includes("Control"),
          shiftKey: (modifiers || []).includes("Shift"),
          altKey: (modifiers || []).includes("Alt"),
          metaKey: (modifiers || []).includes("Meta"),
        };

        // ── Pointer Events (modern frameworks) ──
        const pointerOpts = {
          bubbles: true, cancelable: true, clientX: x, clientY: y,
          button: button === "right" ? 2 : button === "middle" ? 1 : 0,
          pointerId: 1, pointerType: "mouse", isPrimary: true,
        };
        try {
          el.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
          el.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
        } catch (e) { /* PointerEvent not supported */ }

        el.dispatchEvent(new MouseEvent("mousedown", opts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
        el.dispatchEvent(new MouseEvent("click", opts));

        if (doubleClick) {
          el.dispatchEvent(new MouseEvent("mousedown", opts));
          el.dispatchEvent(new MouseEvent("mouseup", opts));
          el.dispatchEvent(new MouseEvent("click", opts));
          el.dispatchEvent(new MouseEvent("dblclick", opts));
        }

        // ── Pre-click scroll into view ──
        if (el.scrollIntoViewIfNeeded) {
          el.scrollIntoViewIfNeeded(true);
        } else if (el.scrollIntoView) {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        }

        // ── Editor-aware focus routing ──
        let focusHandled = false;
        let node = el;
        while (node && node !== document.body) {
          if (node.classList) {
            if (node.classList.contains('monaco-editor')) {
              const input = node.querySelector('.inputarea') || node.querySelector('textarea');
              if (input) { input.focus(); focusHandled = true; }
              break;
            }
            if (node.classList.contains('cm-editor')) {
              const content = node.querySelector('.cm-content');
              if (content) { content.focus(); focusHandled = true; }
              break;
            }
            if (node.classList.contains('CodeMirror')) {
              const code = node.querySelector('.CodeMirror-code') || node.querySelector('[contenteditable]');
              if (code) { code.focus(); focusHandled = true; }
              break;
            }
            if (node.classList.contains('ace_editor')) {
              const aceInput = node.querySelector('.ace_text-input');
              if (aceInput) { aceInput.focus(); focusHandled = true; }
              break;
            }
            // Rich text editors
            if (node.classList.contains('ql-editor') || node.classList.contains('ProseMirror') ||
                node.classList.contains('tiptap') || node.hasAttribute?.('data-slate-editor') ||
                node.classList.contains('DraftEditor-root')) {
              const ce = node.querySelector('[contenteditable="true"]') || node;
              if (ce) { ce.focus(); focusHandled = true; }
              break;
            }
          }
          node = node.parentElement;
        }

        if (!focusHandled && el.focus && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.hasAttribute("contenteditable") || el.tabIndex >= 0)) {
          el.focus();
        }

        return { success: true, tag: el.tagName, text: (el.innerText || "").substring(0, 50) };
      },
      args: [payload.x, payload.y, payload.doubleClick || false, payload.button || "left", payload.modifiers || []],
    });

    // Clear HUD after click
    if (elementLabel) showAtlasHUD(tabId, '', true);
    return results[0]?.result || { success: true };
  });
}

async function typeText(payload) {
  return withActiveTab(async (tabId) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (text, selector, editorTypeHint) => {
      // ── Editor Detection ──
      function findEditorContext(el) {
        let node = el;
        while (node && node !== document.body) {
          if (node.classList) {
            if (node.classList.contains('monaco-editor')) return 'monaco';
            if (node.classList.contains('cm-editor')) return 'codemirror6';
            if (node.classList.contains('CodeMirror')) return 'codemirror5';
            if (node.classList.contains('ace_editor')) return 'ace';
            if (node.classList.contains('ql-editor') || node.closest?.('.ql-container')) return 'quill';
            if (node.classList.contains('tox-tinymce') || node.closest?.('.tox-tinymce')) return 'tinymce';
            if (node.classList.contains('ProseMirror')) return 'prosemirror';
            if (node.classList.contains('tiptap') || node.closest?.('.tiptap')) return 'tiptap';
            if (node.hasAttribute?.('data-slate-editor')) return 'slate';
            if (node.classList.contains('DraftEditor-root') || node.closest?.('.DraftEditor-root')) return 'draftjs';
          }
          node = node.parentElement;
        }
        return editorTypeHint || null;
      }

      function typeIntoMonaco(editorEl, text) {
        try {
          if (typeof monaco !== 'undefined' && monaco.editor) {
            const editors = monaco.editor.getEditors ? monaco.editor.getEditors() : [];
            if (editors.length > 0) {
              const editor = editors[0];
              const model = editor.getModel();
              if (model) {
                const range = model.getFullModelRange();
                editor.executeEdits('atlas', [{ range, text, forceMoveMarkers: true }]);
                return true;
              }
            }
          }
        } catch (e) { /* API not available */ }
        // Fallback: hidden textarea
        const inputArea = editorEl.querySelector('.inputarea') || editorEl.querySelector('textarea');
        if (inputArea) {
          inputArea.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
          return true;
        }
        return false;
      }

      function typeIntoCodeMirror5(editorEl, text) {
        try {
          const cmInstance = editorEl.CodeMirror;
          if (cmInstance) { cmInstance.setValue(text); cmInstance.refresh(); return true; }
        } catch (e) { /* */ }
        const codeArea = editorEl.querySelector('.CodeMirror-code') || editorEl.querySelector('[contenteditable]');
        if (codeArea) { codeArea.focus(); document.execCommand('selectAll', false, null); document.execCommand('insertText', false, text); return true; }
        return false;
      }

      function typeIntoCodeMirror6(editorEl, text) {
        try {
          const cmContent = editorEl.querySelector('.cm-content');
          if (cmContent && cmContent.cmView && cmContent.cmView.view) {
            const view = cmContent.cmView.view;
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
            return true;
          }
        } catch (e) { /* */ }
        const cmContent = editorEl.querySelector('.cm-content');
        if (cmContent) { cmContent.focus(); document.execCommand('selectAll', false, null); document.execCommand('insertText', false, text); return true; }
        return false;
      }

      function typeIntoAce(editorEl, text) {
        try {
          const aceId = editorEl.id;
          if (aceId && typeof ace !== 'undefined') {
            const editor = ace.edit(aceId);
            if (editor) { editor.setValue(text, -1); return true; }
          }
        } catch (e) { /* */ }
        const textInput = editorEl.querySelector('.ace_text-input');
        if (textInput) { textInput.focus(); textInput.value = text; textInput.dispatchEvent(new Event('input', { bubbles: true })); return true; }
        return false;
      }

      function typeIntoRichEditor(editorEl, text, editorType) {
        // TinyMCE: use API
        if (editorType === 'tinymce') {
          try {
            if (typeof tinymce !== 'undefined' && tinymce.activeEditor) {
              tinymce.activeEditor.setContent(text);
              return true;
            }
          } catch (e) { /* */ }
          // Fallback: find iframe
          const iframe = editorEl.querySelector('iframe');
          if (iframe && iframe.contentDocument) {
            const body = iframe.contentDocument.body;
            if (body) { body.focus(); iframe.contentDocument.execCommand('selectAll', false, null); iframe.contentDocument.execCommand('insertText', false, text); return true; }
          }
        }
        // Quill, ProseMirror, Tiptap, Slate, Draft.js — all use contenteditable
        const ce = editorEl.querySelector('[contenteditable="true"]') || editorEl;
        if (ce && (ce.hasAttribute('contenteditable') || ce.contentEditable === 'true')) {
          ce.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
          return true;
        }
        return false;
      }

      let target = selector ? document.querySelector(selector) : document.activeElement;
      if (!target) return { success: false, error: 'No target element' };
      if (target.focus) target.focus();

      // Check for code/rich editor context
      const detectedEditor = findEditorContext(target);

      if (detectedEditor) {
        let editorEl = target;
        const editorClasses = {
          'monaco': '.monaco-editor', 'codemirror6': '.cm-editor', 'codemirror5': '.CodeMirror',
          'ace': '.ace_editor', 'quill': '.ql-container', 'tinymce': '.tox-tinymce',
          'prosemirror': '.ProseMirror', 'tiptap': '.tiptap', 'slate': '[data-slate-editor]',
          'draftjs': '.DraftEditor-root'
        };

        // Walk up to find the editor wrapper
        let node = target;
        const selector2 = editorClasses[detectedEditor];
        while (node && node !== document.body) {
          if (node.matches && node.matches(selector2)) { editorEl = node; break; }
          node = node.parentElement;
        }
        // If not found walking up, search the page
        if (editorEl === target || !editorEl.matches?.(selector2)) {
          editorEl = document.querySelector(selector2) || editorEl;
        }

        let success = false;
        if (detectedEditor === 'monaco') success = typeIntoMonaco(editorEl, text);
        else if (detectedEditor === 'codemirror5') success = typeIntoCodeMirror5(editorEl, text);
        else if (detectedEditor === 'codemirror6') success = typeIntoCodeMirror6(editorEl, text);
        else if (detectedEditor === 'ace') success = typeIntoAce(editorEl, text);
        else success = typeIntoRichEditor(editorEl, text, detectedEditor);

        if (success) return { success: true, editor: detectedEditor };
      }

      // ── Normal typing (existing logic) ──
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
        const proto = target.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) {
          setter.call(target, target.value + text);
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else if (target.hasAttribute("contenteditable") || target.contentEditable === "true") {
        document.execCommand("insertText", false, text);
      } else {
        // Generic keyboard event fallback
        for (const ch of text) {
          target.dispatchEvent(new KeyboardEvent("keydown", { key: ch, code: `Key${ch.toUpperCase()}`, bubbles: true }));
          target.dispatchEvent(new KeyboardEvent("keypress", { key: ch, code: `Key${ch.toUpperCase()}`, bubbles: true }));
          target.dispatchEvent(new KeyboardEvent("keyup", { key: ch, code: `Key${ch.toUpperCase()}`, bubbles: true }));
        }
      }
      return { success: true };
    },
    args: [payload.text, payload.selector || null, payload.editorType || null],
    });

    return results[0]?.result || { success: true };
  });
}

async function scroll(payload) {
  return withActiveTab(async (tabId) => {
    injectAtlasVisuals(tabId);
    showAtlasHUD(tabId, `↕ Scrolling ${payload.direction || 'down'} ${payload.amount || 300}px`);

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (direction, amount, selector) => {
        const px = amount || 300;
        const deltaX = direction === 'left' ? -px : direction === 'right' ? px : 0;
        const deltaY = direction === 'up' ? -px : direction === 'down' ? px : 0;

        // Scroll indicator pill
        const arrows = {up:'↑', down:'↓', left:'←', right:'→'};
        const pill = document.createElement('div');
        pill.textContent = (arrows[direction] || '↕') + ' ' + px + 'px';
        const fadeAnim = direction === 'up' ? 'atlasScrollFadeUp' : 'atlasScrollFadeDown';
        pill.style.cssText = `position:fixed;left:50%;transform:translateX(-50%);bottom:40px;padding:5px 14px;border-radius:20px;font-size:12px;font-weight:600;background:rgba(15,23,42,.88);color:#94a3b8;border:1px solid #334155;pointer-events:none;z-index:2147483647;backdrop-filter:blur(4px);animation:${fadeAnim} .75s ease-out forwards;font-family:-apple-system,sans-serif;`;
        document.body.appendChild(pill);
        setTimeout(() => pill.remove(), 780);

        const scrollTarget = selector ? document.querySelector(selector) : null;

        if (scrollTarget) {
          // Targeted element scroll — set scrollTop/Left directly
          scrollTarget.scrollTop += deltaY;
          scrollTarget.scrollLeft += deltaX;
        } else {
          // Page-level scroll — dispatch WheelEvent first (triggers virtual scroll
          // handlers in React/Vue infinite lists), then scrollBy as authoritative move.
          try {
            const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
            const target = document.elementFromPoint(cx, cy) || document.body;
            target.dispatchEvent(new WheelEvent('wheel', {
              deltaX, deltaY, deltaMode: 0,
              bubbles: true, cancelable: true,
              clientX: cx, clientY: cy,
            }));
          } catch(_) {}
          // scrollBy is the authoritative scroll — WheelEvent alone may not scroll
          window.scrollBy({ left: deltaX, top: deltaY, behavior: 'smooth' });
        }

        return { success: true, scrolled: direction, px };
      },
      args: [payload.direction, payload.amount || 300, payload.selector || null],
    });

    setTimeout(() => showAtlasHUD(tabId, '', true), 800);
    return { success: true };
  });
}

async function executeJS(payload) {
  // Optional tabId pins the script to one tab (the human-check wait watches the
  // tab the check is on, even if the user switches tabs). Default: the active tab.
  const [tab] = payload.tabId != null
    ? [await chrome.tabs.get(payload.tabId)]
    : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab");

  // Use CDP Runtime.evaluate — this runs in the page context and bypasses
  // ALL CSP restrictions (both page CSP and extension CSP).
  // ISOLATED world + new Function() fails on strict CSP pages (e.g. Gmail)
  // because `new Function()` is equivalent to `eval()` which requires unsafe-eval.
  let result;
  try {
    // Reuse a session rawCDP holds open (a CAPTCHA solve); otherwise attach just for this call.
    const held = cdpSessions.has(tab.id);
    if (!held) await chrome.debugger.attach({ tabId: tab.id }, "1.3").catch(() => {});
    result = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      "Runtime.evaluate",
      { expression: payload.code, returnByValue: true, awaitPromise: true }
    );
    if (!held) chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
  } catch (cdpErr) {
    // CDP unavailable — try ISOLATED world as last resort. `code` is an
    // expression, so wrap it in `return (...)` or the result is always undefined;
    // fall back to statement form if it doesn't parse as an expression.
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "ISOLATED",
      func: async (code) => {
        try {
          let fn;
          try { fn = new Function(`return (${code}\n)`); }
          catch (e) { if (!(e instanceof SyntaxError)) throw e; fn = new Function(code); }
          return { ok: true, value: await fn() };
        } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
      },
      args: [payload.code],
    });
    const out = results[0]?.result;
    if (!out || !out.ok) throw new Error(out?.error || "execute_js failed");
    return out.value;
  }

  // Throw (outside the try, so the fallback doesn't re-run the code) so the
  // bridge reports a real error instead of an {error} value callers misread.
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

// Raw CDP passthrough for nativeType, setFileInput, and other CDP methods.
// Allowlisted to prevent arbitrary CDP abuse.
const CDP_ALLOWED_METHODS = new Set([
  'Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent',
  'DOM.setFileInputFiles', 'DOM.getBoxModel', 'DOM.getContentQuads',
  'Page.captureScreenshot', 'Network.enable', 'Network.disable',
  'Accessibility.getFullAXTree',
]);

// One debugger session per tab while CDP calls keep coming (a CAPTCHA solve sends
// dozens of mouse events), dropped after a quiet spell so Chrome's "debugging this
// browser" bar doesn't stay up.
const cdpSessions = new Map(); // tabId -> idle-detach timer
const CDP_IDLE_MS = 15000;
chrome.debugger.onDetach.addListener((source) => {
  clearTimeout(cdpSessions.get(source.tabId));
  cdpSessions.delete(source.tabId);
});

async function holdCDP(tabId) {
  if (!cdpSessions.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (e) {
      if (!/already attached/i.test(String(e && e.message))) throw e;
    }
  }
  clearTimeout(cdpSessions.get(tabId));
  cdpSessions.set(tabId, setTimeout(() => {
    cdpSessions.delete(tabId);
    chrome.debugger.detach({ tabId }).catch(() => {});
  }, CDP_IDLE_MS));
}

async function rawCDP(payload) {
  if (!CDP_ALLOWED_METHODS.has(payload.method)) {
    throw new Error(`CDP method not allowed: ${payload.method}`);
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab");
  await holdCDP(tab.id);
  const result = await chrome.debugger.sendCommand({ tabId: tab.id }, payload.method, payload.params || {});
  return result || { success: true };
}

// A whole mouse gesture (move / click / drag) as trusted CDP input in one bridge
// call: one round trip instead of one per event, and paced here, not over the socket.
async function mousePath(payload) {
  const events = Array.isArray(payload.events) ? payload.events.slice(0, 200) : [];
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab");
  await holdCDP(tab.id);
  for (const e of events) {
    if (!["mouseMoved", "mousePressed", "mouseReleased"].includes(e.type)) continue;
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
      type: e.type, x: Number(e.x) || 0, y: Number(e.y) || 0,
      button: e.button || "left", buttons: e.buttons || 0, clickCount: e.clickCount || 0,
    });
    if (e.delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(e.delayMs, 2000)));
  }
  return { success: true, events: events.length };
}

// The CAPTCHA widget frames (reCAPTCHA anchor/bframe, hCaptcha checkbox/challenge)
// read from inside, for Bhai's picture-CAPTCHA solver. A fixed function, not eval:
// those frames' CSP forbids eval. Rects are in each frame's own viewport; Bhai maps
// them onto the page with the iframe's box. Keep the selectors in step with
// src/tools/browser/captcha-vision.ts.
async function captchaFrames() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab");
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const href = location.href;
      const kind = /\/recaptcha\/.*bframe|hcaptcha.*frame=challenge/.test(href) ? "challenge"
        : /\/recaptcha\/.*anchor|hcaptcha.*frame=checkbox/.test(href) ? "checkbox" : null;
      if (!kind) return null;
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 8 && r.height > 8 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
      };
      const all = (sels) => {
        for (const s of sels) {
          const rs = Array.from(document.querySelectorAll(s)).map(rect).filter(Boolean);
          if (rs.length) return rs;
        }
        return [];
      };
      const tds = Array.from(document.querySelectorAll("td.rc-imageselect-tile"));
      const settled = tds.every((td) => {
        if (td.classList.contains("rc-imageselect-dynamic-selected")) return false;
        const img = td.querySelector("img"), ov = td.querySelector(".rc-image-tile-overlay");
        return !!img && img.complete && img.naturalWidth > 0 && (!ov || Number(getComputedStyle(ov).opacity) === 0);
      });
      const dos = document.querySelector(".rc-doscaptcha-header-text");
      const prompt = document.querySelector(".rc-imageselect-desc-wrapper,.rc-imageselect-desc-no-canonical,.prompt-text,h2");
      const canvases = all(["canvas"]).sort((a, b) => b.w * b.h - a.w * a.h);
      return {
        kind, vw: innerWidth, vh: innerHeight,
        tiles: all(["td.rc-imageselect-tile", ".task-image", ".task-grid .task", ".challenge-view .task"]),
        submit: all(["#recaptcha-verify-button", ".button-submit"])[0] || null,
        tick: all(["#recaptcha-anchor", "#checkbox"])[0] || null,
        canvas: canvases[0] || null,
        header: all([".challenge-header"])[0] || null,
        instruction: ((prompt && prompt.innerText) || "").trim(),
        settled,
        blocked: !!dos && dos.offsetParent !== null,
      };
    },
  });
  return results.map((r) => r.result).filter(Boolean);
}

async function navigate(payload) {
  if (payload.newTab) {
    await chrome.tabs.create({ url: payload.url, active: true });
  } else {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.id) throw new Error("No active tab");
    await chrome.tabs.update(tab.id, { url: payload.url });
  }
  return { success: true };
}

async function goBack() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab");
  await chrome.tabs.goBack(tab.id);
  return { success: true };
}

async function captureScreenshot(payload) {
  const format = payload.format === "png" ? "png" : "jpeg";
  const quality = format === "jpeg" ? (payload.quality || 55) : undefined;

  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format, quality });
  const base64 = dataUrl.replace(/^data:image\/(png|jpeg);base64,/, "");

  return { base64 };
}

async function switchTab(payload) {
  if (payload.tabId) {
    const tab = await chrome.tabs.update(payload.tabId, { active: true });
    // focus:true also raises the window (CAPTCHA human handoff)
    if (payload.focus && tab?.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
  }
  return { success: true };
}

async function closeTab(payload) {
  if (payload.tabId) {
    await chrome.tabs.remove(payload.tabId);
  } else {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.id) {
      await chrome.tabs.remove(tab.id);
    }
  }
  return { success: true };
}

// Real key presses through CDP: a synthetic KeyboardEvent never submits a form on
// Enter, moves focus on Tab or types into fields, because browsers ignore untrusted
// key events for those. False when the debugger can't attach or the key is unknown.
const CDP_KEYS = {
  Enter: [13, "\r"], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], Insert: [45],
  ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39],
  Home: [36], End: [35], PageUp: [33], PageDown: [34], " ": [32, " "], Space: [32, " "],
  Control: [17], Shift: [16], Alt: [18], Meta: [91],
};
async function cdpKey(tabId, key, mods, action) {
  let code = key, keyCode, text = "";
  const modifiers = (mods || []).reduce((m, k) => m | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[k] || 0), 0);
  if (CDP_KEYS[key]) {
    [keyCode, text = ""] = CDP_KEYS[key];
    if (key === " " || key === "Space") code = "Space";
  } else if (typeof key === "string" && key.length === 1) {
    keyCode = key.toUpperCase().charCodeAt(0);
    code = /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : "";
    text = modifiers & 6 ? "" : key; // Ctrl/Cmd shortcuts don't type their letter
  } else {
    return false;
  }
  try {
    await holdCDP(tabId);
  } catch {
    return false;
  }
  const base = { key: key === "Space" ? " " : key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  const send = (type, extra) => chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type, ...base, ...extra });
  if (action !== "up") await send(text ? "keyDown" : "rawKeyDown", text ? { text, unmodifiedText: text } : {});
  if (action !== "down") await send("keyUp", {});
  return true;
}

async function keyboard(payload) {
  return withActiveTab(async (tabId) => {
    if (await cdpKey(tabId, payload.key, payload.modifiers || [], payload.action || "press")) {
      return { success: true, method: "cdp" };
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (key, modifiers, keyAction) => {
        const target = document.activeElement || document.body;
        const opts = {
          key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
          bubbles: true, cancelable: true,
          ctrlKey: (modifiers || []).includes("Control"),
          shiftKey: (modifiers || []).includes("Shift"),
          altKey: (modifiers || []).includes("Alt"),
          metaKey: (modifiers || []).includes("Meta"),
        };
        if (keyAction === "down") {
          target.dispatchEvent(new KeyboardEvent("keydown", opts));
        } else if (keyAction === "up") {
          target.dispatchEvent(new KeyboardEvent("keyup", opts));
        } else {
          target.dispatchEvent(new KeyboardEvent("keydown", opts));
          target.dispatchEvent(new KeyboardEvent("keypress", opts));
          target.dispatchEvent(new KeyboardEvent("keyup", opts));
        }
      },
      args: [payload.key, payload.modifiers || [], payload.action || "press"],
    });

    return { success: true };
  });
}

async function hover(payload) {
  return withActiveTab(async (tabId) => {
    injectAtlasVisuals(tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (x, y) => {
        // Subtle hover cursor dot
        const prev = document.getElementById('__atlasHoverDot');
        if (prev) prev.remove();
        const dot = document.createElement('div');
        dot.id = '__atlasHoverDot';
        dot.style.cssText = `position:fixed;left:${x-5}px;top:${y-5}px;width:10px;height:10px;border-radius:50%;background:rgba(99,102,241,.7);border:2px solid rgba(99,102,241,.9);pointer-events:none;z-index:2147483647;transition:all .15s ease;`;
        document.body.appendChild(dot);
        setTimeout(() => dot?.remove(), 1500);

        // Move mouse and fire events
        const el = document.elementFromPoint(x, y);
        if (!el) return;
        const events = ['mousemove','mouseover','mouseenter'];
        const opts = { clientX: x, clientY: y, bubbles: true, cancelable: true };
        events.forEach(ev => el.dispatchEvent(new MouseEvent(ev, opts)));
      },
      args: [payload.x, payload.y],
    });
    return { success: true };
  });
}

async function selectOption(payload) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab");

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector, values) => {
      const el = document.querySelector(selector);
      if (!el || el.tagName !== "SELECT") return;
      for (const option of el.options) {
        option.selected = values.includes(option.value) || values.includes(option.text);
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    args: [payload.selector, payload.values],
  });

  return { success: true };
}

async function waitFor(payload) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab");

  const timeout = payload.timeout || 10000;
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector, timeoutMs) => {
      return new Promise((resolve) => {
        if (document.querySelector(selector)) {
          resolve(true);
          return;
        }

        const observer = new MutationObserver(() => {
          if (document.querySelector(selector)) {
            observer.disconnect();
            resolve(true);
          }
        });

        observer.observe(document.body, { childList: true, subtree: true, attributes: true });

        setTimeout(() => {
          observer.disconnect();
          resolve(false);
        }, timeoutMs);
      });
    },
    args: [payload.selector, timeout],
  });

  if (!results[0]?.result) {
    throw new Error(`Selector "${payload.selector}" not found within ${timeout}ms`);
  }

  return { found: true };
}

// ── Tab Change Events ────────────────────────

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    ws.send(JSON.stringify({
      type: "event",
      event: {
        type: "tab_activated",
        data: {
          id: tab.id,
          index: tab.index,
          title: tab.title || "",
          url: tab.url || "",
          windowId: tab.windowId,
        },
      },
    }));
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!tab.active) return;
  if (!changeInfo.url && !changeInfo.title) return;

  ws.send(JSON.stringify({
    type: "event",
    event: {
      type: "tab_updated",
      data: {
        id: tab.id,
        index: tab.index,
        title: tab.title || "",
        url: tab.url || "",
        windowId: tab.windowId,
        changes: changeInfo,
      },
    },
  }));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: "event",
    event: { type: "tab_removed", data: { id: tabId } },
  }));
});

// ── Auto-Discovery ───────────────────────────

// Apply a discovered config: bring up the bridge socket (primary) and, if the
// server advertised an overlay channel, the overlay socket too.
function applyDiscovery(config) {
  const newToken = config.token;
  const newUrl = config.wsUrl || `ws://127.0.0.1:${config.port}`;
  const overlay = config.overlay;
  const newOverlayToken = overlay && overlay.localToken ? overlay.localToken : overlayToken;
  const newOverlayUrl = overlay && overlay.wsUrl ? overlay.wsUrl : overlayUrl;

  authToken = newToken;
  serverUrl = newUrl;
  overlayToken = newOverlayToken;
  overlayUrl = newOverlayUrl;

  chrome.storage.local.set({
    serverUrl,
    authToken,
    overlayUrl,
    overlayToken,
    discoveredAt: Date.now(),
  });

  stopDiscovery();
  discoveryAttempts = 0;

  // Idempotent: don't tear down a healthy socket that already holds the same
  // credentials. A redundant disconnect()+connect() here would close the
  // just-authenticated bridge (the server allows only one connection), which
  // looks like a connect→drop loop. Only (re)connect when actually needed.
  const bridgeHealthy = ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
  if (!bridgeHealthy) {
    connect();
  }

  const overlayHealthy = overlayWs && (overlayWs.readyState === WebSocket.OPEN || overlayWs.readyState === WebSocket.CONNECTING);
  if (!overlayHealthy && overlayToken) {
    connectOverlay();
  }
}

let _discovering = false;
async function autoDiscover() {
  // Coalesce concurrent discovery (boot + a still-pending poll tick can both
  // fire). Without this, two applyDiscovery() runs race and the second can
  // tear down the socket the first just opened.
  if (_discovering) return false;
  _discovering = true;
  try {
    return await _autoDiscover();
  } finally {
    _discovering = false;
  }
}

async function _autoDiscover() {
  try {
    const res = await fetch(discoveryUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const config = await res.json();

    if (config.token && config.wsUrl) {
      console.log("[ATLAS Bridge] Auto-discovered Bhai server");
      applyDiscovery(config);
      return true;
    }
    console.warn("[ATLAS Bridge] /discover returned no token/wsUrl:", JSON.stringify(config));
  } catch (err) {
    // Surface the real reason — silent failure here was the root of a long
    // "stuck Searching" debug. Network/CORS/PNA errors all land here.
    console.warn("[ATLAS Bridge] /discover fetch failed:", err && err.message ? err.message : String(err));
  }

  // Try native messaging as fallback
  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendNativeMessage("com.atlas.bridge", { action: "get_config" }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(resp);
        }
      });
    });

    if (response && response.success && response.token) {
      console.log("[ATLAS Bridge] Auto-discovered via native messaging");
      applyDiscovery(response);
      return true;
    }
  } catch {
    // Native messaging not available
  }

  // No fallback to the overlay port. 18792 is the overlay chat server — it
  // speaks a different protocol AND requires ?localToken= auth that this
  // extension does not hold. Connecting there used to silently fail with
  // ERR_CONNECTION_REFUSED-style errors when the bot wasn't fully booted,
  // and surface as 4001 closes after. Keep retrying /discover at 18800.
  return false;
}

function startDiscovery() {
  if (discoveryTimer) return;
  discoveryAttempts++;
  const delay = Math.min(DISCOVERY_INTERVAL * Math.pow(1.5, discoveryAttempts - 1), MAX_DISCOVERY_INTERVAL);
  discoveryTimer = setTimeout(async () => {
    discoveryTimer = null;
    const found = await autoDiscover();
    if (!found) {
      startDiscovery();
    }
  }, delay);
}

function stopDiscovery() {
  if (discoveryTimer) {
    clearTimeout(discoveryTimer);
    discoveryTimer = null;
  }
}

// ── Messages from Popup / Content Script ─────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "get_status") {
    sendResponse({
      connected: ws && ws.readyState === WebSocket.OPEN,
      authenticated,
      overlayConnected: overlayWs && overlayWs.readyState === WebSocket.OPEN,
      serverUrl,
      hasToken: !!authToken,
      discoveryAttempts,
      lastResponse: lastAtlasResponse,
      actionLog: _actionLog,
    });
    return true;
  }
  if (msg.type === "get_action_log") {
    sendResponse({ log: _actionLog });
    return true;
  }

  if (msg.type === "reconnect") {
    disconnect();
    disconnectOverlay();
    stopDiscovery();
    discoveryAttempts = 0;
    autoDiscover().then((found) => {
      if (!found) startDiscovery();
      sendResponse({ ok: true, found });
    });
    return true;
  }

  if (msg.type === "disconnect") {
    disconnect();
    disconnectOverlay();
    stopDiscovery();
    sendResponse({ ok: true });
    return true;
  }

  // ── Overlay Bridge: send page context to Bhai ──

  if (msg.type === "send_page") {
    capturePageContext().then((ctx) => {
      if (!ctx) {
        sendResponse({ ok: false, error: "Could not capture page context" });
        return;
      }
      const text = `[From browser: ${ctx.url}]\nPage title: "${ctx.title}"\n\nPage content:\n${ctx.pageContent || "(could not extract)"}`;
      const sent = sendToAtlas(text, {
        url: ctx.url,
        title: ctx.title,
        action: "send_page",
      });
      sendResponse({ ok: sent });
    });
    return true;
  }

  if (msg.type === "send_selection") {
    capturePageContext().then((ctx) => {
      if (!ctx) {
        sendResponse({ ok: false, error: "Could not capture page context" });
        return;
      }
      const selectedText = ctx.selectedText || "(no text selected)";
      const text = `[From browser: ${ctx.url}] User selected: "${selectedText}"`;
      const sent = sendToAtlas(text, {
        url: ctx.url,
        title: ctx.title,
        selectedText,
        action: "send_selection",
      });
      sendResponse({ ok: sent });
    });
    return true;
  }

  if (msg.type === "send_message") {
    capturePageContext().then((ctx) => {
      const url = ctx?.url || "";
      const title = ctx?.title || "";
      const prefix = url ? `[From browser: ${url}] ` : "";
      const text = `${prefix}${msg.text}`;
      const sent = sendToAtlas(text, {
        url,
        title,
        action: "send_message",
      });
      sendResponse({ ok: sent });
    });
    return true;
  }

  return false;
});

// ── Connection bootstrap ─────────────────────
// Discover first, always. The bridge token rotates per Bhai session, so a
// cached token can be stale; a fresh /discover yields both the current bridge
// token and the overlay localToken and brings up both sockets. Cached creds
// are only a last-resort fallback when discovery can't reach the server.
//
// Idempotent + cheap to call repeatedly: it's the single entry point used by
// boot AND by every service-worker wake-up (onStartup / onInstalled / alarm),
// because an MV3 service worker is frequently suspended and respawned — the
// old "run once at top level" boot never re-ran after a respawn, which left
// the extension permanently stuck "Searching".
async function ensureConnected() {
  const bridgeHealthy = ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
  if (bridgeHealthy) return;

  const found = await autoDiscover();
  if (found) return;

  // Discovery failed — fall back to cached creds (bridge alone is better than
  // nothing) and keep polling for the server to come up.
  const data = await chrome.storage.local.get(["serverUrl", "authToken", "overlayUrl", "overlayToken"]);
  if (data.authToken) {
    authToken = data.authToken;
    serverUrl = data.serverUrl || serverUrl;
    connect();

    setTimeout(() => {
      if (!authenticated) {
        autoDiscover().then((found) => {
          if (!found) startDiscovery();
        });
      }
    }, 3000);
  } else {
    // No saved token — go straight to discovery. The previous "try direct
    // connection first" path connected to the wrong server (18792 overlay,
    // different protocol + auth) and surfaced spurious ERR_CONNECTION_REFUSED
    // and 4001-close errors in the extension console.
    autoDiscover().then((found) => {
      if (!found) startDiscovery();
    });
  }
  if (data.overlayToken) {
    overlayToken = data.overlayToken;
    overlayUrl = data.overlayUrl || overlayUrl;
    connectOverlay();
  }
  startDiscovery();
}

// Run on first load (top-level), on browser start, on install/update, and on a
// periodic alarm so a respawned-then-idle service worker re-establishes the
// connection instead of sitting dormant.
ensureConnected();
chrome.runtime.onStartup.addListener(() => { ensureConnected(); });
chrome.runtime.onInstalled.addListener(() => { ensureConnected(); });
chrome.alarms.create("atlas-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "atlas-keepalive") ensureConnected();
});
