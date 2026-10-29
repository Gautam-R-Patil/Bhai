// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Bhai side panel: the conversation with Bhai, docked next to the page.
// Text from pages and replies is escaped before the small markdown pass, and
// links are only ever http(s).

const $ = (id) => document.getElementById(id);
const messages = $('messages');
const input = $('input');
const sendBtn = $('btnSend');
const chips = [$('btnSummary'), $('btnExplain'), $('btnDraw')];

let canChat = false;

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      void chrome.runtime.lastError; // worker may be waking up
      resolve(resp);
    });
  });
}

// ── Markdown (small and safe) ────────────────

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function renderMarkdown(text) {
  const parts = escapeHtml(text).split(/```(?:[a-z0-9-]*)\n?([\s\S]*?)```/i);
  let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) { html += `<pre><code>${part}</code></pre>`; return; }
    for (const block of part.split(/\n{2,}/)) {
      const lines = block.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
        html += `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('')}</ul>`;
      } else {
        html += `<p>${lines.map(inline).join('<br>')}</p>`;
      }
    }
  });
  return html;
}

// ── Rendering ────────────────────────────────

function renderChat(chat) {
  messages.querySelectorAll('.msg').forEach((el) => el.remove());
  $('empty').classList.toggle('hidden', (chat || []).length > 0);
  for (const m of chat || []) {
    const el = document.createElement('div');
    el.className = `msg ${m.role}`;
    if (m.role === 'bhai') el.innerHTML = renderMarkdown(m.text);
    else el.textContent = m.text;
    messages.append(el);
  }
  messages.scrollTop = messages.scrollHeight;
}

function renderStatus(resp) {
  const browserOn = !!resp?.connected;
  canChat = !!resp?.overlayConnected;
  const searching = !browserOn && (resp?.discoveryAttempts || 0) > 0 && (resp?.discoveryAttempts || 0) < 3;
  const dot = $('dot');
  dot.className = `dot${canChat ? ' on' : searching ? '' : ' off'}`;
  dot.title = canChat ? 'Connected to Bhai' : searching ? 'Connecting…' : browserOn ? 'Chat is reconnecting…' : 'Bhai isn\'t running';
  $('offline').classList.toggle('hidden', browserOn || searching);
  sendBtn.disabled = !canChat;
  chips.forEach((c) => { c.disabled = !canChat; });
  input.placeholder = canChat ? 'Ask Bhai anything…' : 'Open Bhai to chat';
}

function setBusy(on, text) {
  $('working').classList.toggle('hidden', !on);
  if (on && text) $('workingText').textContent = text;
}

async function refresh() {
  renderStatus(await send({ type: 'get_status' }));
}

// ── Sending ──────────────────────────────────

async function sendText() {
  const text = input.value.trim();
  if (!text || !canChat) return;
  input.value = '';
  autosize();
  const resp = await send({ type: 'send_message', text });
  if (resp?.ok) {
    setBusy(true, resp.drawing ? 'Looking at your drawing…' : 'Thinking…');
    if (resp.drawing) $('drawNote').classList.add('hidden');
  } else { input.value = text; autosize(); }
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); }
});
sendBtn.addEventListener('click', sendText);

$('btnSummary').addEventListener('click', async () => {
  const resp = await send({ type: 'send_page', question: 'Summarize this page for me.', display: 'Summarize this page' });
  if (resp?.ok) setBusy(true, 'Reading the page…');
});
$('btnExplain').addEventListener('click', async () => {
  const resp = await send({ type: 'send_selection', question: 'Explain this simply.' });
  if (resp?.ok) setBusy(true, 'Thinking…');
});
function showHint(text) {
  $('hint').textContent = text || '';
  if (text) setTimeout(() => { if ($('hint').textContent === text) $('hint').textContent = ''; }, 5000);
}

async function startDrawing() {
  const resp = await send({ type: 'start_draw' });
  if (!resp?.ok) return showHint(resp?.error || "Couldn't open drawing on this page.");
  $('drawNote').classList.remove('hidden');
  showHint('');
}
$('btnDraw').addEventListener('click', startDrawing);
$('btnDrawEdit').addEventListener('click', startDrawing);
$('btnDrawRemove').addEventListener('click', async () => {
  await send({ type: 'clear_draw' });
  $('drawNote').classList.add('hidden');
});

$('btnStop').addEventListener('click', () => {
  send({ type: 'send_message', text: 'stop' });
  setBusy(false);
});
$('btnNew').addEventListener('click', async () => {
  await send({ type: 'clear_chat' });
  renderChat([]);
  setBusy(false);
  input.focus();
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
  if (msg.type === 'chat_update') {
    renderChat(msg.chat);
    const last = msg.chat[msg.chat.length - 1];
    if (last && last.role !== 'you') setBusy(false);
  } else if (msg.type === 'atlas_progress') {
    setBusy(true, msg.text || 'Working…');
  } else if (msg.type === 'atlas_action') {
    setBusy(true, msg.entry?.detail || 'Working…');
  }
});

send({ type: 'get_chat' }).then((resp) => renderChat(resp?.chat || []));
refresh();
setInterval(refresh, 3000);
input.focus();
