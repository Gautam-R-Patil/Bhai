// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Bhai Browser Bridge — Popup UI (redesigned)

const tabsList    = document.getElementById('tabsList');
const connPill    = document.getElementById('connPill');
const connLabel   = document.getElementById('connLabel');
const statusBanner= document.getElementById('statusBanner');
const statusIcon  = document.getElementById('statusIcon');
const statusText  = document.getElementById('statusText');
const statusSpinner=document.getElementById('statusSpinner');
const pageInfo    = document.getElementById('pageInfo');
const pageUrl     = document.getElementById('pageUrl');
const actionLog   = document.getElementById('actionLog');
const msgInput    = document.getElementById('msgInput');
const btnSend     = document.getElementById('btnSend');
const btnPage     = document.getElementById('btnPage');
const btnSel      = document.getElementById('btnSel');
const btnStop     = document.getElementById('btnStop');
const responseCard= document.getElementById('responseCard');
const responseText= document.getElementById('responseText');
const btnReconn   = document.getElementById('btnReconn');

let connected = false;
let isAgentBusy = false;

// ── Action type → icon map ───────────────────

const ACTION_ICONS = {
  click_at:     '🖱',
  type_text:    '⌨️',
  scroll:       '↕',
  navigate:     '→',
  scan_elements:'🔍',
  hover:        '👆',
  screenshot:   '📷',
  execute_js:   '⚡',
  keyboard:     '⌨️',
  default:      '•',
};

// ── Relative time ────────────────────────────

function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

// ── Render action log ────────────────────────

function renderActionLog(log) {
  if (!log || log.length === 0) {
    actionLog.innerHTML = '';
    return;
  }
  actionLog.innerHTML = log.map(entry => {
    const icon = ACTION_ICONS[entry.type] || ACTION_ICONS.default;
    const detail = (entry.detail || entry.type).replace(/^(Clicking|Typing|Scrolling|→)\s+/, match => `<span class="bold">${match}</span>`);
    return `
      <div class="action-item">
        <span class="action-icon">${icon}</span>
        <span class="action-text">${detail}</span>
        <span class="action-time">${relTime(entry.ts)}</span>
      </div>`;
  }).join('');
}

// ── Set connection state ─────────────────────

function setConnected(state, label) {
  connected = state === 'connected';
  connPill.className = `conn-pill ${state}`;
  connLabel.textContent = label;

  const on = connected;
  msgInput.disabled = !on;
  btnSend.disabled = !on;
  btnPage.disabled = !on;
  btnSel.disabled = !on;
  msgInput.placeholder = on ? 'Send a message to Bhai…' : 'Not connected to Bhai';
}

// ── Set agent busy/idle state ────────────────

function setAgentBusy(busy, action) {
  isAgentBusy = busy;
  statusSpinner.className = `status-spinner${busy ? ' visible' : ''}`;
  if (busy) {
    statusIcon.textContent = '⚡';
    statusText.innerHTML = `<span class="current-action">${action || 'Working…'}</span>`;
    btnStop.disabled = false;
  } else {
    statusIcon.textContent = '✅';
    statusText.textContent = 'Ready';
    setTimeout(() => {
      if (!isAgentBusy) {
        statusIcon.textContent = '💤';
        statusText.textContent = 'Waiting for task…';
      }
    }, 2500);
    btnStop.disabled = true;
  }
}

// ── Show Bhai response ──────────────────────

function showResponse(text) {
  if (!text) return;
  responseText.textContent = text.length > 200 ? text.substring(0, 197) + '…' : text;
  responseCard.className = 'response-card visible';
}

// ── Render open tabs ─────────────────────────

function renderTabs(tabs) {
  if (!tabs || tabs.length === 0) {
    tabsList.innerHTML = '';
    return;
  }
  tabsList.innerHTML = tabs.map((t, i) => {
    const domain = (() => {
      try { return new URL(t.url || '').hostname.replace(/^www\./, ''); } catch { return t.url || '?'; }
    })();
    const isActive = t.active;
    return `<div class="tab-item${isActive ? ' active' : ''}" data-idx="${i}" title="${t.url || ''}">
      <span class="tab-idx">${i + 1}</span>
      <span class="tab-dot"></span>
      <span class="tab-title">${t.title || 'Untitled'}</span>
      <span class="tab-url">${domain}</span>
    </div>`;
  }).join('');

  // Click tab to switch Bhai focus (sends a message)
  tabsList.querySelectorAll('.tab-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      chrome.runtime.sendMessage(
        { type: 'send_message', text: `switch to tab ${idx + 1}` },
        () => { void chrome.runtime.lastError; } // suppress unchecked lastError
      );
    });
  });
}

// ── Refresh status from background ──────────

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'get_status' }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      setConnected('disconnected', 'Offline');
      return;
    }
    if (resp.connected) {
      setConnected('connected', 'Connected');
    } else if (resp.discoveryAttempts > 0) {
      setConnected('connecting', 'Searching…');
    } else {
      setConnected('disconnected', 'Offline');
    }
    if (resp.lastResponse) showResponse(resp.lastResponse);
    if (resp.actionLog) renderActionLog(resp.actionLog);
  });

  // Show all open tabs
  chrome.tabs.query({ currentWindow: true }, (tabs) => {
    if (tabs) renderTabs(tabs);
  });
}

// ── Send quick message ───────────────────────

function sendQuickMessage() {
  const txt = msgInput.value.trim();
  if (!txt || !connected) return;
  btnSend.disabled = true;
  btnSend.textContent = '…';
  msgInput.value = '';
  chrome.runtime.sendMessage({ type: 'send_message', text: txt }, (resp) => {
    btnSend.disabled = false;
    btnSend.textContent = 'Send';
    if (resp?.ok) {
      btnSend.textContent = '✓';
      setTimeout(() => { btnSend.textContent = 'Send'; }, 1200);
    }
  });
}

// ── Button wiring ────────────────────────────

btnSend.addEventListener('click', sendQuickMessage);
msgInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendQuickMessage(); } });

btnPage.addEventListener('click', () => {
  if (!connected) return;
  btnPage.textContent = '📄 Sending…';
  btnPage.disabled = true;
  chrome.runtime.sendMessage({ type: 'send_page' }, (resp) => {
    btnPage.disabled = false;
    btnPage.textContent = resp?.ok ? '📄 ✓ Sent' : '📄 Send page';
    setTimeout(() => { btnPage.textContent = '📄 Send page'; }, 1500);
  });
});

btnSel.addEventListener('click', () => {
  if (!connected) return;
  btnSel.textContent = '✏️ Sending…';
  btnSel.disabled = true;
  chrome.runtime.sendMessage({ type: 'send_selection' }, (resp) => {
    btnSel.disabled = false;
    btnSel.textContent = resp?.ok ? '✏️ ✓ Sent' : '✏️ Selection';
    setTimeout(() => { btnSel.textContent = '✏️ Selection'; }, 1500);
  });
});

btnStop.addEventListener('click', () => {
  chrome.runtime.sendMessage(
    { type: 'send_message', text: 'stop' },
    () => { void chrome.runtime.lastError; }
  );
  setAgentBusy(false);
});

btnReconn.addEventListener('click', () => {
  btnReconn.textContent = 'Reconnecting…';
  btnReconn.disabled = true;
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
    setTimeout(() => {
      btnReconn.textContent = 'Reconnect';
      btnReconn.disabled = false;
      refreshStatus();
    }, 2000);
  });
});

// ── Live updates from background ────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'atlas_response') {
    showResponse(msg.text);
    setAgentBusy(false, '');
  }
  if (msg.type === 'atlas_progress') {
    setAgentBusy(true, msg.text || 'Working…');
  }
  if (msg.type === 'atlas_error') {
    statusIcon.textContent = '⚠️';
    statusText.textContent = msg.text || 'An error occurred';
    statusSpinner.className = 'status-spinner';
    isAgentBusy = false;
  }
  if (msg.type === 'atlas_action') {
    // Real-time action entry pushed from background
    chrome.runtime.sendMessage({ type: 'get_status' }, (resp) => {
      if (chrome.runtime.lastError) return; // popup may be closing, ignore
      if (resp?.actionLog) renderActionLog(resp.actionLog);
    });
    setAgentBusy(true, msg.entry?.detail || 'Working…');
  }
});

// ── Init ─────────────────────────────────────

refreshStatus();
setInterval(refreshStatus, 2500);
