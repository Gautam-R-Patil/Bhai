// Copyright (c) 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// -- Web Chat Widget ------------------------------------------
// Self-contained embeddable chat widget served at /widget.js
// Connects to the overlay WebSocket to provide a floating chat bubble
// on any webpage. Authenticates via ?token= query parameter.

/**
 * Returns the self-contained widget JavaScript (inline HTML/CSS/JS)
 * that creates a floating chat bubble connecting to the overlay WebSocket.
 */
export function getWidgetScript(wsUrl: string): string {
    // The entire widget is a single self-executing IIFE served as a .js file.
    // It injects its own DOM elements, styles, and WebSocket logic.
    return `(function() {
  "use strict";
  // __atlasWidget: set by a cached pre-rename copy of this script on the same page.
  if (window.__bhaiWidget || window.__atlasWidget) return;
  window.__bhaiWidget = window.__atlasWidget = true;

  // -- Config --
  var SCRIPT = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var src = SCRIPT ? SCRIPT.src : "";
  var params = new URL(src).searchParams;
  var TOKEN = params.get("token") || "";
  var POSITION = params.get("position") || "bottom-right";
  var WS_URL = ${JSON.stringify(wsUrl)};

  // -- Styles --
  var STYLES = document.createElement("style");
  STYLES.textContent = \`
    :root {
      --bhai-primary: #6366f1;
      --bhai-primary-hover: #4f46e5;
      --bhai-bg: #ffffff;
      --bhai-bg-secondary: #f3f4f6;
      --bhai-text: #1f2937;
      --bhai-text-secondary: #6b7280;
      --bhai-border: #e5e7eb;
      --bhai-bubble-user: #6366f1;
      --bhai-bubble-user-text: #ffffff;
      --bhai-bubble-agent: #f3f4f6;
      --bhai-bubble-agent-text: #1f2937;
      --bhai-shadow: 0 8px 32px rgba(0,0,0,0.12);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bhai-primary: #818cf8;
        --bhai-primary-hover: #6366f1;
        --bhai-bg: #1f2937;
        --bhai-bg-secondary: #374151;
        --bhai-text: #f9fafb;
        --bhai-text-secondary: #9ca3af;
        --bhai-border: #4b5563;
        --bhai-bubble-user: #6366f1;
        --bhai-bubble-user-text: #ffffff;
        --bhai-bubble-agent: #374151;
        --bhai-bubble-agent-text: #f9fafb;
        --bhai-shadow: 0 8px 32px rgba(0,0,0,0.3);
      }
    }
    #bhai-widget-bubble {
      position: fixed;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--bhai-primary);
      color: #fff;
      border: none;
      cursor: pointer;
      box-shadow: var(--bhai-shadow);
      z-index: 999998;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s ease, background 0.2s ease;
      \${POSITION === "bottom-left" ? "left: 20px; bottom: 20px;" : "right: 20px; bottom: 20px;"}
    }
    #bhai-widget-bubble:hover {
      transform: scale(1.08);
      background: var(--bhai-primary-hover);
    }
    #bhai-widget-bubble svg {
      width: 28px;
      height: 28px;
      fill: currentColor;
    }
    #bhai-widget-window {
      position: fixed;
      width: 350px;
      height: 500px;
      border-radius: 12px;
      background: var(--bhai-bg);
      box-shadow: var(--bhai-shadow);
      z-index: 999999;
      display: none;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--bhai-border);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      \${POSITION === "bottom-left" ? "left: 20px; bottom: 86px;" : "right: 20px; bottom: 86px;"}
    }
    #bhai-widget-window.open { display: flex; }
    #bhai-widget-header {
      padding: 14px 16px;
      background: var(--bhai-primary);
      color: #fff;
      font-weight: 600;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    #bhai-widget-header .status {
      font-size: 11px;
      font-weight: 400;
      opacity: 0.85;
    }
    #bhai-widget-close {
      background: none;
      border: none;
      color: #fff;
      cursor: pointer;
      font-size: 18px;
      padding: 0 4px;
      line-height: 1;
      opacity: 0.8;
    }
    #bhai-widget-close:hover { opacity: 1; }
    #bhai-widget-messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .bhai-msg {
      max-width: 85%;
      padding: 8px 12px;
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.45;
      word-wrap: break-word;
      white-space: pre-wrap;
    }
    .bhai-msg.user {
      align-self: flex-end;
      background: var(--bhai-bubble-user);
      color: var(--bhai-bubble-user-text);
      border-bottom-right-radius: 4px;
    }
    .bhai-msg.agent {
      align-self: flex-start;
      background: var(--bhai-bubble-agent);
      color: var(--bhai-bubble-agent-text);
      border-bottom-left-radius: 4px;
    }
    .bhai-msg.system {
      align-self: center;
      background: transparent;
      color: var(--bhai-text-secondary);
      font-size: 12px;
      font-style: italic;
    }
    .bhai-msg code {
      background: rgba(0,0,0,0.1);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 12px;
    }
    @media (prefers-color-scheme: dark) {
      .bhai-msg code { background: rgba(255,255,255,0.1); }
    }
    #bhai-widget-input-area {
      display: flex;
      padding: 10px 12px;
      border-top: 1px solid var(--bhai-border);
      gap: 8px;
      flex-shrink: 0;
      background: var(--bhai-bg);
    }
    #bhai-widget-input {
      flex: 1;
      border: 1px solid var(--bhai-border);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 13px;
      background: var(--bhai-bg-secondary);
      color: var(--bhai-text);
      outline: none;
      resize: none;
      font-family: inherit;
      min-height: 36px;
      max-height: 80px;
    }
    #bhai-widget-input:focus {
      border-color: var(--bhai-primary);
    }
    #bhai-widget-input::placeholder {
      color: var(--bhai-text-secondary);
    }
    #bhai-widget-send {
      background: var(--bhai-primary);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 8px 14px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.15s;
      align-self: flex-end;
    }
    #bhai-widget-send:hover { background: var(--bhai-primary-hover); }
    #bhai-widget-send:disabled { opacity: 0.5; cursor: default; }
    #bhai-widget-steps-bar {
      flex-shrink: 0;
      padding: 6px 12px;
      border-bottom: 1px solid var(--bhai-border);
      font-size: 12px;
      color: var(--bhai-text-secondary);
    }
    #bhai-widget-steps-bar[hidden], #bhai-widget-steps[hidden] { display: none; }
    #bhai-widget-steps-toggle {
      background: none;
      border: none;
      padding: 0;
      font: inherit;
      color: inherit;
      cursor: pointer;
      text-decoration: underline;
    }
    #bhai-widget-steps-toggle:disabled { cursor: default; text-decoration: none; }
    #bhai-widget-steps { max-height: 110px; overflow-y: auto; margin-top: 4px; }
    .bhai-step { padding: 1px 0; }
    .bhai-step.running { color: var(--bhai-text); }
    .bhai-step.failed { text-decoration: line-through; }
    @media (prefers-reduced-motion: reduce) {
      #bhai-widget-bubble, #bhai-widget-send { transition: none; }
      #bhai-widget-bubble:hover { transform: none; }
    }
  \`;
  document.head.appendChild(STYLES);

  // -- DOM --
  var bubble = document.createElement("button");
  bubble.id = "bhai-widget-bubble";
  bubble.setAttribute("aria-label", "Chat with Bhai");
  bubble.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/></svg>';
  document.body.appendChild(bubble);

  var win = document.createElement("div");
  win.id = "bhai-widget-window";
  win.innerHTML =
    '<div id="bhai-widget-header">' +
      '<div><span>Bhai</span><br><span class="status" id="bhai-widget-status">Connecting...</span></div>' +
      '<button id="bhai-widget-close" aria-label="Close chat">&times;</button>' +
    '</div>' +
    '<div id="bhai-widget-steps-bar" hidden>' +
      '<button type="button" id="bhai-widget-steps-toggle" aria-expanded="false" aria-controls="bhai-widget-steps">Steps</button>' +
      '<div id="bhai-widget-steps" hidden></div>' +
    '</div>' +
    '<div id="bhai-widget-messages"></div>' +
    '<div id="bhai-widget-input-area">' +
      '<textarea id="bhai-widget-input" placeholder="Type a message..." rows="1"></textarea>' +
      '<button id="bhai-widget-send" disabled>Send</button>' +
    '</div>';
  document.body.appendChild(win);

  var msgContainer = win.querySelector("#bhai-widget-messages");
  var input = win.querySelector("#bhai-widget-input");
  var sendBtn = win.querySelector("#bhai-widget-send");
  var statusEl = win.querySelector("#bhai-widget-status");
  var closeBtn = win.querySelector("#bhai-widget-close");
  var stepsBar = win.querySelector("#bhai-widget-steps-bar");
  var stepsToggle = win.querySelector("#bhai-widget-steps-toggle");
  var stepsList = win.querySelector("#bhai-widget-steps");

  // -- Markdown (simple) --
  function renderMarkdown(text) {
    // Chat-bar markers: a collapse becomes a bold title over its content; buttons and widgets are dropped.
    text = String(text).replace(/<!--\\s*COLLAPSE:([^>]*?)-->\\n?/g, "**$1**\\n").replace(/<!--\\s*\\/COLLAPSE\\s*-->/g, "").replace(/<!--\\s*(?:QUICK_ACTIONS|WIDGET)\\b[\\s\\S]*?-->/g, "");
    var s = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    // Code blocks
    s = s.replace(/\`\`\`[\\w]*\\n?([\\s\\S]*?)\`\`\`/g, "<pre><code>$1</code></pre>");
    // Inline code
    s = s.replace(/\`([^\`\\n]+)\`/g, "<code>$1</code>");
    // Bold
    s = s.replace(/\\*\\*(?!\\s)(.+?)(?<!\\s)\\*\\*/g, "<strong>$1</strong>");
    // Italic
    s = s.replace(/(?<!\\w)\\*(?!\\s)([^*\\n]+?)(?<!\\s)\\*(?!\\w)/g, "<em>$1</em>");
    return s;
  }

  function addMessage(text, role) {
    var div = document.createElement("div");
    div.className = "bhai-msg " + role;
    div.innerHTML = role === "user" ? text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") : renderMarkdown(text);
    msgContainer.appendChild(div);
    msgContainer.scrollTop = msgContainer.scrollHeight;
    return div;
  }

  // -- Live turn (turn_* from the bot) --
  // Same contract as the overlay's turnView/turnRoute: a message whose seq isn't newer changes
  // nothing, another turn's events don't take over a running one, the final response replaces
  // whatever was streamed. A guest never receives turn_note. Old bots send no turn_*; then none
  // of this runs.
  function turnView(state, msg) {
    if (!msg || typeof msg.type !== "string" || msg.type.indexOf("turn_") !== 0) return state;
    var same = !!state && state.turn === msg.turn;
    if (same && typeof msg.seq === "number" && msg.seq <= state.seq) return state;
    var s = same ? Object.assign({}, state) : { turn: msg.turn, seq: 0, status: null, steps: [], answer: "", attempt: 0 };
    if (typeof msg.seq === "number") s.seq = msg.seq;
    switch (msg.type) {
      case "turn_snapshot":
        s.status = msg.status || null;
        s.steps = Array.isArray(msg.steps) ? msg.steps.map(function(x) { return { id: x.id, text: x.text, state: x.state }; }) : [];
        s.answer = typeof msg.answer === "string" ? msg.answer : "";
        s.attempt = null;
        break;
      case "turn_status":
        s.status = { text: msg.text || "", step: msg.step || 0, elapsed: msg.elapsed || 0 };
        break;
      case "turn_step":
        var step = { id: msg.id, text: msg.text || "", state: msg.state };
        var i = s.steps.findIndex(function(x) { return x.id === msg.id; });
        s.steps = i < 0 ? s.steps.concat([step]) : s.steps.map(function(x, j) { return j === i ? step : x; });
        break;
      case "turn_answer":
        if (s.attempt === null) s.attempt = msg.attempt;
        if (msg.attempt < s.attempt) return state; // a withdrawn attempt's late text
        if (msg.attempt > s.attempt) { s.attempt = msg.attempt; s.answer = ""; }
        s.answer += msg.text || "";
        break;
      case "turn_answer_reset":
        s.answer = "";
        s.attempt = Math.max(s.attempt || 0, (msg.attempt || 0) + 1);
        break;
      default:
        return state;
    }
    return s;
  }

  // 'apply' | 'start' | 'finish' | 'plain' | 'ignore'; only a snapshot (a rejoin) may replace a running view.
  function turnRoute(liveTurn, running, msg) {
    if (msg.type === "response" || msg.type === "error") {
      if (!running) return "plain";
      return msg.type === "error" || !msg.turn || msg.turn === liveTurn ? "finish" : "ignore";
    }
    if (liveTurn !== null && msg.turn === liveTurn) return "apply";
    return running && msg.type !== "turn_snapshot" ? "ignore" : "start";
  }

  // A turn quicker than this shows no live line, steps bar or "..." and leaves no "Worked for" line.
  var SHOW_LIVE_AFTER_MS = 15000;
  var live = null; // { state, bubble, start, statusAt, frame, tick, stepsShown, quiet, done }

  function liveRunning() { return !!live && !live.done; }

  function liveStart(turn) {
    if (live) { cancelAnimationFrame(live.frame); clearInterval(live.tick); }
    if (!currentAgentMsg) currentAgentMsg = addMessage("...", "agent");
    live = {
      state: { turn: turn, seq: 0, status: null, steps: [], answer: "", attempt: 0 },
      bubble: currentAgentMsg, start: Date.now(), statusAt: 0, frame: 0, tick: 0, stepsShown: null, shown: "", quiet: true, done: false
    };
    live.tick = setInterval(liveLine, 1000);
    live.bubble.style.display = "none"; // until the answer's first words, or the line shows
    statusEl.textContent = "Online";
    stepsBar.hidden = true;
    stepsList.hidden = true;
    stepsToggle.setAttribute("aria-expanded", "false");
    stepsToggle.textContent = "Steps";
    stepsToggle.disabled = false;
    liveLine();
  }

  // The live line in the header: "Searching the web · step 2 · 14s", once the turn runs long.
  function liveLine() {
    if (!liveRunning()) return;
    var st = live.state.status;
    var secs = Math.floor(st ? st.elapsed + (Date.now() - live.statusAt) / 1000 : (Date.now() - live.start) / 1000);
    if (live.quiet) {
      if (secs * 1000 < SHOW_LIVE_AFTER_MS) return;
      live.quiet = false; // the turn ran long: the line, steps and "..." show with all they have
      live.stepsShown = null;
      liveRender();
    }
    var text = st && st.text ? String(st.text).substring(0, 40) : "Thinking...";
    statusEl.textContent = (text || "Thinking...") + " · " + (st && st.step > 0 ? "step " + st.step + " · " : "") + secs + "s";
  }

  // At most once per animation frame, however fast the deltas come.
  function liveRender() {
    if (!live) return;
    live.frame = 0;
    var s = live.state;
    if (s.answer !== live.shown) {
      live.shown = s.answer;
      live.bubble.innerHTML = s.answer ? renderMarkdown(s.answer) : "...";
    }
    live.bubble.style.display = live.quiet && !s.answer ? "none" : "";
    if (s.steps !== live.stepsShown) {
      live.stepsShown = s.steps;
      stepsBar.hidden = live.quiet || !s.steps.length;
      stepsList.textContent = "";
      s.steps.forEach(function(x) {
        var row = document.createElement("div");
        row.className = "bhai-step" + (x.state === "running" || x.state === "done" || x.state === "failed" ? " " + x.state : "");
        row.textContent = String(x.text);
        stepsList.appendChild(row);
      });
    }
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }

  function liveEnd(worked) {
    if (!live) return;
    liveRender();
    cancelAnimationFrame(live.frame);
    clearInterval(live.tick);
    live.done = true;
    live.bubble.style.display = "";
    var n = live.state.steps.length;
    if (live.quiet) stepsBar.hidden = true; // a quick turn: just its reply
    else if (worked) { // the turn's own reply: "Worked for…" stays, a toggle only when there are steps
      stepsBar.hidden = false;
      stepsToggle.textContent = "Worked for " + worked.secs + "s" + (worked.steps ? " · " + worked.steps + (worked.steps === 1 ? " step" : " steps") : "");
      stepsToggle.disabled = !n;
    } else if (!n) stepsBar.hidden = true;
    else stepsToggle.textContent = "Steps";
  }

  function onTurnEvent(msg) {
    var route = turnRoute(live ? live.state.turn : null, liveRunning(), msg);
    if (route === "ignore") return;
    if (route === "start") liveStart(msg.turn);
    if (live.done) return;
    var prev = live.state;
    live.state = turnView(prev, msg);
    if (live.state === prev) return;
    if (msg.type === "turn_status" || (msg.type === "turn_snapshot" && msg.status)) live.statusAt = Date.now();
    liveLine();
    if (!live.frame) live.frame = requestAnimationFrame(liveRender);
  }

  // -- WebSocket --
  var ws = null;
  var reconnectDelay = 1000;
  var currentAgentMsg = null;
  var connected = false;

  function connect() {
    var url = WS_URL + (WS_URL.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN) + "&source=web-widget";
    try { ws = new WebSocket(url); } catch(e) { return; }

    ws.onopen = function() {
      connected = true;
      reconnectDelay = 1000;
      statusEl.textContent = "Online";
      sendBtn.disabled = false;
    };

    ws.onclose = function() {
      connected = false;
      statusEl.textContent = "Reconnecting...";
      sendBtn.disabled = true;
      if (liveRunning() || currentAgentMsg) { // the reply was lost with the connection: never leave a dead live view or "..."
        var streamed = liveRunning() && live.state.answer;
        var dots = liveRunning() ? live.bubble : currentAgentMsg;
        if (liveRunning()) liveEnd(null);
        if (!streamed && dots.parentNode) dots.parentNode.removeChild(dots);
        addMessage(streamed ? "Lost the connection mid-answer. Ask me again." : "Connection lost. Ask me again.", "system");
        currentAgentMsg = null;
      }
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
    };

    ws.onerror = function() {
      // onclose will fire after this
    };

    ws.onmessage = function(event) {
      try {
        var msg = JSON.parse(event.data);
        if (msg.type === "ready") {
          statusEl.textContent = "Online";
        } else if (msg.type === "thinking") {
          // thinking_content (the model's reasoning) is never shown here.
          if (msg.turn && turnRoute(live ? live.state.turn : null, liveRunning(), msg) === "start") liveStart(msg.turn);
          else if (!liveRunning()) {
            statusEl.textContent = "Thinking...";
            if (!currentAgentMsg) currentAgentMsg = addMessage("...", "agent");
          }
        } else if (typeof msg.type === "string" && msg.type.indexOf("turn_") === 0) {
          onTurnEvent(msg);
        } else if (msg.type === "progress" && msg.text) {
          if (!liveRunning()) statusEl.textContent = msg.text.substring(0, 40);
        } else if (msg.type === "response" && msg.text) {
          var route = turnRoute(live ? live.state.turn : null, liveRunning(), msg);
          if (route === "ignore") return;
          statusEl.textContent = "Online";
          if (route === "finish") liveEnd(msg.worked);
          if (currentAgentMsg) {
            currentAgentMsg.innerHTML = renderMarkdown(msg.text);
            msgContainer.scrollTop = msgContainer.scrollHeight;
            currentAgentMsg = null;
          } else {
            addMessage(msg.text, "agent");
          }
        } else if (msg.type === "response" && liveRunning() && (!msg.turn || msg.turn === live.state.turn)) {
          // an empty reply: nothing to show, but the turn is over
          statusEl.textContent = "Online";
          liveEnd(null);
          if (!live.state.answer && live.bubble.parentNode) live.bubble.parentNode.removeChild(live.bubble);
          currentAgentMsg = null;
        } else if (msg.type === "error" && msg.text) {
          statusEl.textContent = "Online";
          if (liveRunning()) {
            var shown = live.state.answer;
            liveEnd(null);
            if (!shown && live.bubble.parentNode) live.bubble.parentNode.removeChild(live.bubble);
          }
          addMessage(msg.text, "system");
          currentAgentMsg = null;
        } else if (msg.type === "notification" && msg.text) {
          addMessage(msg.text, "agent");
        }
      } catch(e) { /* ignore parse errors */ }
    };
  }

  function sendMessage() {
    var text = input.value.trim();
    if (!text || !connected) return;
    addMessage(text, "user");
    if (liveRunning()) liveEnd(null);
    currentAgentMsg = null;
    ws.send(JSON.stringify({ type: "chat", text: text, meta: { source: "web-widget" } }));
    input.value = "";
    input.style.height = "36px";
    sendBtn.disabled = true;
    statusEl.textContent = "Sending...";
  }

  // -- Events --
  bubble.addEventListener("click", function() {
    var isOpen = win.classList.toggle("open");
    if (isOpen && !ws) connect();
    if (isOpen) input.focus();
  });

  closeBtn.addEventListener("click", function() {
    win.classList.remove("open");
  });

  sendBtn.addEventListener("click", sendMessage);

  input.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  input.addEventListener("input", function() {
    sendBtn.disabled = !input.value.trim() || !connected;
    input.style.height = "36px";
    input.style.height = Math.min(input.scrollHeight, 80) + "px";
  });

  stepsToggle.addEventListener("click", function() {
    var open = stepsList.hidden;
    stepsList.hidden = !open;
    stepsToggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  // Auto-connect if window starts open
  if (params.get("open") === "true") {
    win.classList.add("open");
    connect();
  }
})();`;
}

/**
 * Returns the HTML page for the /widget route (embed instructions + preview).
 */
export function getWidgetPage(host: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Bhai Chat Widget</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; color: #1f2937; }
  h1 { font-size: 1.5em; }
  pre { background: #f3f4f6; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
  code { font-family: "SF Mono", "Fira Code", monospace; }
  .note { color: #6b7280; font-size: 14px; }
</style>
</head>
<body>
  <h1>Bhai Chat Widget</h1>
  <p>Add the following script tag to your webpage to embed the chat widget:</p>
  <pre><code>&lt;script src="${host}/widget.js?token=YOUR_TOKEN"&gt;&lt;/script&gt;</code></pre>
  <p class="note">Replace <code>YOUR_TOKEN</code> with the value of your <code>WIDGET_TOKEN</code> environment variable.</p>
  <h2>Options</h2>
  <ul>
    <li><code>?position=bottom-left</code> -- Place bubble on the left (default: bottom-right)</li>
    <li><code>?open=true</code> -- Start with chat window open</li>
  </ul>
</body>
</html>`;
}

/**
 * Validates widget token against the configured WIDGET_TOKEN env var.
 * Fail-CLOSED: when WIDGET_TOKEN is unset OR shorter than 32 chars, refuse all
 * widget connections. Uses crypto.timingSafeEqual to avoid timing side-channels.
 */
import { timingSafeEqual } from "node:crypto";

const MIN_TOKEN_LEN = 32;
let _widgetWarnLogged = false;

export function validateWidgetToken(token: string | null): boolean {
    const expected = process.env.WIDGET_TOKEN;
    if (!expected || expected.length < MIN_TOKEN_LEN) {
        if (!_widgetWarnLogged) {
            if (!expected) {
                console.warn("⚠️  [WIDGET] WIDGET_TOKEN unset — widget WS/HTTP refused. Set WIDGET_TOKEN (≥32 chars) to enable.");
            } else {
                console.error(`❌ [WIDGET] WIDGET_TOKEN too short (${expected.length} < ${MIN_TOKEN_LEN}) — widget disabled.`);
            }
            _widgetWarnLogged = true;
        }
        return false;
    }
    if (!token || token.length !== expected.length) return false;
    try {
        const a = Buffer.from(token, "utf-8");
        const b = Buffer.from(expected, "utf-8");
        if (a.length !== b.length) return false;
        return timingSafeEqual(a, b);
    } catch {
        return false;
    }
}
