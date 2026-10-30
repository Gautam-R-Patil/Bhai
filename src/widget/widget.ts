// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
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
  if (window.__atlasWidget) return;
  window.__atlasWidget = true;

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
      --atlas-primary: #6366f1;
      --atlas-primary-hover: #4f46e5;
      --atlas-bg: #ffffff;
      --atlas-bg-secondary: #f3f4f6;
      --atlas-text: #1f2937;
      --atlas-text-secondary: #6b7280;
      --atlas-border: #e5e7eb;
      --atlas-bubble-user: #6366f1;
      --atlas-bubble-user-text: #ffffff;
      --atlas-bubble-agent: #f3f4f6;
      --atlas-bubble-agent-text: #1f2937;
      --atlas-shadow: 0 8px 32px rgba(0,0,0,0.12);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --atlas-primary: #818cf8;
        --atlas-primary-hover: #6366f1;
        --atlas-bg: #1f2937;
        --atlas-bg-secondary: #374151;
        --atlas-text: #f9fafb;
        --atlas-text-secondary: #9ca3af;
        --atlas-border: #4b5563;
        --atlas-bubble-user: #6366f1;
        --atlas-bubble-user-text: #ffffff;
        --atlas-bubble-agent: #374151;
        --atlas-bubble-agent-text: #f9fafb;
        --atlas-shadow: 0 8px 32px rgba(0,0,0,0.3);
      }
    }
    #atlas-widget-bubble {
      position: fixed;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--atlas-primary);
      color: #fff;
      border: none;
      cursor: pointer;
      box-shadow: var(--atlas-shadow);
      z-index: 999998;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s ease, background 0.2s ease;
      \${POSITION === "bottom-left" ? "left: 20px; bottom: 20px;" : "right: 20px; bottom: 20px;"}
    }
    #atlas-widget-bubble:hover {
      transform: scale(1.08);
      background: var(--atlas-primary-hover);
    }
    #atlas-widget-bubble svg {
      width: 28px;
      height: 28px;
      fill: currentColor;
    }
    #atlas-widget-window {
      position: fixed;
      width: 350px;
      height: 500px;
      border-radius: 12px;
      background: var(--atlas-bg);
      box-shadow: var(--atlas-shadow);
      z-index: 999999;
      display: none;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--atlas-border);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      \${POSITION === "bottom-left" ? "left: 20px; bottom: 86px;" : "right: 20px; bottom: 86px;"}
    }
    #atlas-widget-window.open { display: flex; }
    #atlas-widget-header {
      padding: 14px 16px;
      background: var(--atlas-primary);
      color: #fff;
      font-weight: 600;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    #atlas-widget-header .status {
      font-size: 11px;
      font-weight: 400;
      opacity: 0.85;
    }
    #atlas-widget-close {
      background: none;
      border: none;
      color: #fff;
      cursor: pointer;
      font-size: 18px;
      padding: 0 4px;
      line-height: 1;
      opacity: 0.8;
    }
    #atlas-widget-close:hover { opacity: 1; }
    #atlas-widget-messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .atlas-msg {
      max-width: 85%;
      padding: 8px 12px;
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.45;
      word-wrap: break-word;
      white-space: pre-wrap;
    }
    .atlas-msg.user {
      align-self: flex-end;
      background: var(--atlas-bubble-user);
      color: var(--atlas-bubble-user-text);
      border-bottom-right-radius: 4px;
    }
    .atlas-msg.agent {
      align-self: flex-start;
      background: var(--atlas-bubble-agent);
      color: var(--atlas-bubble-agent-text);
      border-bottom-left-radius: 4px;
    }
    .atlas-msg.system {
      align-self: center;
      background: transparent;
      color: var(--atlas-text-secondary);
      font-size: 12px;
      font-style: italic;
    }
    .atlas-msg code {
      background: rgba(0,0,0,0.1);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 12px;
    }
    @media (prefers-color-scheme: dark) {
      .atlas-msg code { background: rgba(255,255,255,0.1); }
    }
    #atlas-widget-input-area {
      display: flex;
      padding: 10px 12px;
      border-top: 1px solid var(--atlas-border);
      gap: 8px;
      flex-shrink: 0;
      background: var(--atlas-bg);
    }
    #atlas-widget-input {
      flex: 1;
      border: 1px solid var(--atlas-border);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 13px;
      background: var(--atlas-bg-secondary);
      color: var(--atlas-text);
      outline: none;
      resize: none;
      font-family: inherit;
      min-height: 36px;
      max-height: 80px;
    }
    #atlas-widget-input:focus {
      border-color: var(--atlas-primary);
    }
    #atlas-widget-input::placeholder {
      color: var(--atlas-text-secondary);
    }
    #atlas-widget-send {
      background: var(--atlas-primary);
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
    #atlas-widget-send:hover { background: var(--atlas-primary-hover); }
    #atlas-widget-send:disabled { opacity: 0.5; cursor: default; }
    #atlas-widget-steps-bar {
      flex-shrink: 0;
      padding: 6px 12px;
      border-bottom: 1px solid var(--atlas-border);
      font-size: 12px;
      color: var(--atlas-text-secondary);
    }
    #atlas-widget-steps-bar[hidden], #atlas-widget-steps[hidden] { display: none; }
    #atlas-widget-steps-toggle {
      background: none;
      border: none;
      padding: 0;
      font: inherit;
      color: inherit;
      cursor: pointer;
      text-decoration: underline;
    }
    #atlas-widget-steps { max-height: 110px; overflow-y: auto; margin-top: 4px; }
    .atlas-step { padding: 1px 0; }
    .atlas-step.running { color: var(--atlas-text); }
    .atlas-step.failed { text-decoration: line-through; }
    @media (prefers-reduced-motion: reduce) {
      #atlas-widget-bubble, #atlas-widget-send { transition: none; }
      #atlas-widget-bubble:hover { transform: none; }
    }
  \`;
  document.head.appendChild(STYLES);

  // -- DOM --
  var bubble = document.createElement("button");
  bubble.id = "atlas-widget-bubble";
  bubble.setAttribute("aria-label", "Chat with Bhai");
  bubble.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/></svg>';
  document.body.appendChild(bubble);

  var win = document.createElement("div");
  win.id = "atlas-widget-window";
  win.innerHTML =
    '<div id="atlas-widget-header">' +
      '<div><span>Bhai</span><br><span class="status" id="atlas-widget-status">Connecting...</span></div>' +
      '<button id="atlas-widget-close" aria-label="Close chat">&times;</button>' +
    '</div>' +
    '<div id="atlas-widget-steps-bar" hidden>' +
      '<button type="button" id="atlas-widget-steps-toggle" aria-expanded="false" aria-controls="atlas-widget-steps">Steps</button>' +
      '<div id="atlas-widget-steps" hidden></div>' +
    '</div>' +
    '<div id="atlas-widget-messages"></div>' +
    '<div id="atlas-widget-input-area">' +
      '<textarea id="atlas-widget-input" placeholder="Type a message..." rows="1"></textarea>' +
      '<button id="atlas-widget-send" disabled>Send</button>' +
    '</div>';
  document.body.appendChild(win);

  var msgContainer = win.querySelector("#atlas-widget-messages");
  var input = win.querySelector("#atlas-widget-input");
  var sendBtn = win.querySelector("#atlas-widget-send");
  var statusEl = win.querySelector("#atlas-widget-status");
  var closeBtn = win.querySelector("#atlas-widget-close");
  var stepsBar = win.querySelector("#atlas-widget-steps-bar");
  var stepsToggle = win.querySelector("#atlas-widget-steps-toggle");
  var stepsList = win.querySelector("#atlas-widget-steps");

  // -- Markdown (simple) --
  function renderMarkdown(text) {
    var s = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    // Code blocks
    s = s.replace(/\`\`\`[\\w]*\\n?([\\s\\S]*?)\`\`\`/g, "<pre><code>$1</code></pre>");
    // Inline code
    s = s.replace(/\`([^\`\\n]+)\`/g, "<code>$1</code>");
    // Bold
    s = s.replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>");
    // Italic
    s = s.replace(/(?<!\\w)\\*([^*\\n]+?)\\*(?!\\w)/g, "<em>$1</em>");
    return s;
  }

  function addMessage(text, role) {
    var div = document.createElement("div");
    div.className = "atlas-msg " + role;
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

  var live = null; // { state, bubble, start, statusAt, frame, tick, stepsShown, done }
  var EMOJI_LEAD = /^[\\p{Extended_Pictographic}\\u200d\\ufe0f\\s]+/u;

  function liveRunning() { return !!live && !live.done; }

  function liveStart(turn) {
    if (live) { cancelAnimationFrame(live.frame); clearInterval(live.tick); }
    if (!currentAgentMsg) currentAgentMsg = addMessage("...", "agent");
    live = {
      state: { turn: turn, seq: 0, status: null, steps: [], answer: "", attempt: 0 },
      bubble: currentAgentMsg, start: Date.now(), statusAt: 0, frame: 0, tick: 0, stepsShown: null, shown: "", done: false
    };
    live.tick = setInterval(liveLine, 1000);
    stepsBar.hidden = true;
    stepsList.hidden = true;
    stepsToggle.setAttribute("aria-expanded", "false");
    stepsToggle.textContent = "Steps";
    liveLine();
  }

  // The live line in the header: "Searching the web · step 2 · 14s".
  function liveLine() {
    if (!liveRunning()) return;
    var st = live.state.status;
    var secs = Math.floor(st ? st.elapsed + (Date.now() - live.statusAt) / 1000 : (Date.now() - live.start) / 1000);
    var text = st && st.text ? String(st.text).replace(EMOJI_LEAD, "").substring(0, 40) : "Thinking...";
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
    if (s.steps !== live.stepsShown) {
      live.stepsShown = s.steps;
      stepsBar.hidden = !s.steps.length;
      stepsList.textContent = "";
      s.steps.forEach(function(x) {
        var row = document.createElement("div");
        row.className = "atlas-step" + (x.state === "running" || x.state === "done" || x.state === "failed" ? " " + x.state : "");
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
    var n = live.state.steps.length;
    if (!n) stepsBar.hidden = true;
    else if (worked) stepsToggle.textContent = "Worked for " + worked.secs + "s · " + worked.steps + (worked.steps === 1 ? " step" : " steps");
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
      if (liveRunning()) { // the reply was lost with the connection: never leave a dead live view
        var streamed = live.state.answer;
        liveEnd(null);
        if (streamed) addMessage("Lost the connection mid-answer. Ask me again.", "system");
        else if (live.bubble.parentNode) live.bubble.parentNode.removeChild(live.bubble);
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
