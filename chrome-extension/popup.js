// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Bhai Bridge popup: is Bhai reachable, what is it doing, and a quick way to ask.
// Page-controlled text (titles, replies, step details) only ever goes in via
// textContent, never innerHTML.

const $ = (id) => document.getElementById(id);
const pill = $('pill');
const msgInput = $('msgInput');
const btnSend = $('btnSend');
const btnSummary = $('btnSummary');
const btnExplain = $('btnExplain');

let canChat = false;
let busy = false;

$('version').textContent = `Bhai Bridge ${chrome.runtime.getManifest().version}`;

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      void chrome.runtime.lastError; // popup may close mid-call
      resolve(resp);
    });
  });
}

function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ── Rendering ────────────────────────────────

function renderStatus(resp) {
  const browserOn = !!resp?.connected;
  canChat = !!resp?.overlayConnected;
  const searching = !browserOn && (resp?.discoveryAttempts || 0) > 0 && (resp?.discoveryAttempts || 0) < 3;

  pill.className = `pill${browserOn ? ' on' : searching ? '' : ' off'}`;
  pill.textContent = browserOn ? 'Connected' : searching ? 'Connecting…' : 'Not connected';
  $('offline').classList.toggle('hidden', browserOn || searching);

  for (const el of [msgInput, btnSend, btnSummary, btnExplain]) el.disabled = !canChat;
  msgInput.placeholder = canChat ? 'Ask Bhai to do something here…' : 'Open Bhai to chat';
  $('chatNote').textContent = browserOn && !canChat ? 'Chat is reconnecting…' : '';
}

function renderReply(text) {
  if (!text) return;
  $('reply').textContent = text;
  $('replyCard').classList.remove('hidden');
}

function renderSteps(log) {
  const box = $('stepsBox');
  const list = $('steps');
  list.replaceChildren();
  for (const entry of (log || []).slice(0, 5)) {
    const li = document.createElement('li');
    const what = document.createElement('span');
    const when = document.createElement('span');
    what.textContent = entry.detail;
    when.textContent = relTime(entry.ts);
    li.append(what, when);
    list.append(li);
  }
  box.classList.toggle('hidden', list.children.length === 0);
}

function setBusy(on, text) {
  busy = on;
  $('working').classList.toggle('hidden', !on);
  if (on && text) $('workingText').textContent = text;
}

async function refresh() {
  const resp = await send({ type: 'get_status' });
  renderStatus(resp);
  if (resp?.lastResponse) renderReply(resp.lastResponse);
  renderSteps(resp?.actionLog);
}

// ── Actions ──────────────────────────────────

async function flash(btn, label, message) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  const resp = await send(message);
  btn.textContent = resp?.ok ? 'Sent ✓' : "Couldn't send";
  if (resp?.ok) setBusy(true, label);
  setTimeout(() => { btn.textContent = original; btn.disabled = !canChat; }, 1500);
  return resp?.ok;
}

function sendTyped() {
  const text = msgInput.value.trim();
  if (!text || !canChat) return;
  msgInput.value = '';
  flash(btnSend, 'Thinking…', { type: 'send_message', text });
}

btnSend.addEventListener('click', sendTyped);
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendTyped(); }
});
btnSummary.addEventListener('click', () =>
  flash(btnSummary, 'Reading the page…', { type: 'send_page', question: 'Summarize this page for me.' }));
btnExplain.addEventListener('click', () =>
  flash(btnExplain, 'Thinking…', { type: 'send_selection', question: 'Explain this simply.' }));

$('btnStop').addEventListener('click', () => {
  send({ type: 'send_message', text: 'stop' });
  setBusy(false);
});

$('btnRetry').addEventListener('click', async () => {
  const btn = $('btnRetry');
  btn.disabled = true;
  btn.textContent = 'Looking for Bhai…';
  await send({ type: 'reconnect' });
  btn.disabled = false;
  btn.textContent = 'Try again';
  refresh();
});

// ── Live updates from the background worker ──

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'atlas_response') {
    renderReply(msg.text);
    setBusy(false);
  } else if (msg.type === 'atlas_progress') {
    setBusy(true, msg.text || 'Working…');
  } else if (msg.type === 'atlas_error') {
    setBusy(false);
    renderReply(msg.text || 'Something went wrong.');
  } else if (msg.type === 'atlas_action') {
    setBusy(true, msg.entry?.detail || 'Working…');
    refresh();
  }
});

refresh();
setInterval(refresh, 2500);
msgInput.focus();
