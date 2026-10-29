// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Bhai side panel: the conversation with Bhai, docked next to the page.
// Page-controlled text (titles, selections, replies) is escaped before the
// small markdown pass or set via textContent; links are only ever http(s).

const $ = (id) => document.getElementById(id);
const thread = $('thread');
const input = $('input');
const sendBtn = $('btnSend');

let canChat = false;
let busy = false;
let activeTab = null; // { id, title, url, favIconUrl }
let shareTab = true; // send a screenshot of the current tab with the message
const extraTabs = new Map(); // tabs added with @ (id -> tab); their text goes along
let shareOpen = false;
let selection = ''; // text selected in the active tab
let selectionIgnored = false;

// Lets the background worker know when the panel closes (it removes any drawing).
chrome.runtime.connect({ name: 'sidepanel' });

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      void chrome.runtime.lastError; // worker may be waking up
      resolve(resp);
    });
  });
}

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const icon = (name, size = 14) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};

// ── Markdown (small and safe) ────────────────

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
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
      if (lines.length === 1 && /^#{1,4}\s+/.test(lines[0])) {
        html += `<h3>${inline(lines[0].replace(/^#{1,4}\s+/, ''))}</h3>`;
      } else if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
        html += `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('')}</ul>`;
      } else if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        html += `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
      } else if (lines.every((l) => /^&gt;\s?/.test(l))) {
        html += `<blockquote>${lines.map((l) => inline(l.replace(/^&gt;\s?/, ''))).join('<br>')}</blockquote>`;
      } else {
        html += `<p>${lines.map(inline).join('<br>')}</p>`;
      }
    }
  });
  return html;
}

// ── Thread ───────────────────────────────────

function tag(name, text) {
  const t = document.createElement('span');
  t.className = 'tag';
  const label = document.createElement('span');
  label.textContent = text;
  t.append(icon(name, 12), label);
  return t;
}

function messageEl(m) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  if (m.role === 'you') {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = m.text;
    el.append(bubble);
    const meta = m.meta || {};
    const tags = [];
    if (meta.drew) tags.push(tag('pen', 'Your drawing'));
    else if (meta.shared) tags.push(tag('tab', 'This tab'));
    if (meta.selection) tags.push(tag('quote', `“${meta.selection}”`));
    for (const t of meta.tabs || []) tags.push(tag('tab', t));
    if (tags.length) {
      const row = document.createElement('div');
      row.className = 'attach';
      row.append(...tags);
      el.append(row);
    }
  } else if (m.role === 'bhai') {
    const body = document.createElement('div');
    body.innerHTML = renderMarkdown(m.text);
    const tools = document.createElement('div');
    tools.className = 'reply-tools';
    const copy = document.createElement('button');
    copy.className = 'icon-btn';
    copy.title = 'Copy';
    copy.setAttribute('aria-label', 'Copy reply');
    copy.append(icon('copy', 15));
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(m.text).catch(() => {});
      copy.replaceChildren(icon('check', 15));
      setTimeout(() => copy.replaceChildren(icon('copy', 15)), 1200);
    });
    tools.append(copy);
    el.append(body, tools);
  } else {
    el.textContent = m.text;
  }
  return el;
}

let rendered = 0;
function renderChat(chat) {
  chat = chat || [];
  if (chat.length < rendered) { thread.querySelectorAll('.msg').forEach((el) => el.remove()); rendered = 0; }
  const working = $('workingRow');
  for (const m of chat.slice(rendered)) thread.insertBefore(messageEl(m), working || null);
  rendered = chat.length;
  $('welcome').hidden = chat.length > 0;
  thread.scrollTop = thread.scrollHeight;
}

function setBusy(on, text) {
  busy = on;
  sendBtn.classList.toggle('busy', on);
  sendBtn.title = on ? 'Stop' : 'Send';
  sendBtn.setAttribute('aria-label', sendBtn.title);
  let row = $('workingRow');
  if (!on) { row?.remove(); updateSendState(); return; }
  if (!row) {
    row = document.createElement('div');
    row.id = 'workingRow';
    row.className = 'working';
    row.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span></span>';
    thread.append(row);
  }
  row.lastElementChild.textContent = text || 'Thinking…';
  thread.scrollTop = thread.scrollHeight;
  updateSendState();
}

// ── Status, tab, selection ───────────────────

function renderStatus(resp) {
  const browserOn = !!resp?.connected;
  canChat = !!resp?.overlayConnected;
  const searching = !browserOn && (resp?.discoveryAttempts || 0) > 0 && (resp?.discoveryAttempts || 0) < 3;
  const dot = $('status');
  dot.dataset.state = canChat ? 'on' : searching ? '' : 'off';
  dot.title = canChat ? 'Connected to Bhai' : searching ? 'Connecting…' : browserOn ? 'Chat is reconnecting…' : "Bhai isn't running";
  $('offline').hidden = browserOn || searching;
  for (const b of document.querySelectorAll('.suggest button, #btnDraw, #btnAt')) b.disabled = !canChat;
  input.placeholder = canChat ? 'Ask Bhai…' : 'Open Bhai to chat';
  updateSendState();
}

function updateSendState() {
  sendBtn.disabled = !busy && (!canChat || !input.value.trim());
}

async function refreshTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (activeTab?.id !== tab.id) {
    shareTab = true;
    selection = '';
    selectionIgnored = false;
    renderSelection();
  }
  activeTab = tab;
  extraTabs.delete(tab.id); // the current tab is shared as itself
  const sharable = /^(https?|file):/.test(tab.url || '');
  renderSharing();
  const title = $('welcomeTitle');
  title.replaceChildren();
  if (sharable && host(tab.url)) {
    const b = document.createElement('b');
    b.textContent = host(tab.url);
    title.append("Hey, I'm looking at ", b, ' with you.');
  } else {
    title.append("Hey, I'm right here with you.");
  }
}

function renderSelection() {
  const show = !!selection && !selectionIgnored;
  $('selChip').hidden = !show;
  if (show) $('selText').textContent = `“${selection}”`;
}

// ── Sharing row (like Gemini's "Sharing 3 tabs") ──

const sharableTab = (t) => /^(https?|file):/.test(t?.url || '');

function favicon(t, cls) {
  if (/^https?:/.test(t.favIconUrl || '')) {
    const img = document.createElement('img');
    img.src = t.favIconUrl;
    img.alt = '';
    return img;
  }
  const ph = document.createElement('span');
  if (cls) ph.className = cls;
  ph.append(icon('tab', 10));
  return ph;
}

function sharedTabs() {
  const list = [];
  if (sharableTab(activeTab) && shareTab) list.push(activeTab);
  for (const t of extraTabs.values()) list.push(t);
  return list;
}

function renderSharing() {
  const tabs = sharedTabs();
  const canShareActive = sharableTab(activeTab);
  $('sharing').hidden = !tabs.length && !canShareActive;
  $('shareLabel').textContent = !tabs.length
    ? 'Not sharing any tab'
    : tabs.length === 1 && tabs[0] === activeTab ? 'Sharing this tab' : `Sharing ${tabs.length} tab${tabs.length === 1 ? '' : 's'}`;
  $('shareFavs').replaceChildren(...tabs.slice(0, 3).map((t) => favicon(t)));
  $('shareHead').setAttribute('aria-expanded', String(shareOpen));
  const list = $('shareList');
  list.hidden = !shareOpen;
  list.replaceChildren();
  const rows = canShareActive ? [activeTab, ...extraTabs.values()] : [...extraTabs.values()];
  for (const t of rows) {
    const isActive = t === activeTab;
    const off = isActive && !shareTab;
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 't';
    name.textContent = t.title || 'Untitled';
    const site = document.createElement('span');
    site.className = 'h';
    site.textContent = isActive ? 'This tab' : host(t.url);
    li.append(favicon(t, 'ph'), name, site);
    if (off) {
      li.style.opacity = '.55';
      const add = document.createElement('button');
      add.className = 'link-btn';
      add.textContent = 'Share';
      add.addEventListener('click', () => { shareTab = true; renderSharing(); });
      li.append(add);
    } else {
      const x = document.createElement('button');
      x.className = 'icon-btn';
      x.title = isActive ? "Don't share this tab" : 'Remove';
      x.setAttribute('aria-label', x.title);
      x.append(icon('x', 13));
      x.addEventListener('click', () => {
        if (isActive) shareTab = false;
        else extraTabs.delete(t.id);
        renderSharing();
      });
      li.append(x);
    }
    list.append(li);
  }
}

// ── Sending ──────────────────────────────────

async function sendMessage(message) {
  setBusy(true, message.type === 'send_page' ? 'Reading the page…' : 'Thinking…');
  const resp = await send({ ...message, noScreenshot: !shareTab, ignoreSelection: selectionIgnored });
  if (!resp?.ok) {
    setBusy(false);
    showHint("Couldn't reach Bhai. Is the app open?");
    return false;
  }
  if (resp.drawing) $('drawChip').hidden = true;
  if (resp.drawing) $('workingRow').lastElementChild.textContent = 'Looking at your drawing…';
  return true;
}

async function sendText() {
  const text = input.value.trim();
  if (!text || !canChat) return;
  const mentions = [...extraTabs.keys()];
  input.value = '';
  autosize();
  closeMenu();
  if (!(await sendMessage({ type: 'send_message', text, mentions }))) {
    input.value = text;
    autosize();
  }
}

function stop() {
  send({ type: 'send_message', text: 'stop' });
  setBusy(false);
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  updateSendState();
}

function showHint(text) {
  $('hint').textContent = text || '';
  if (text) setTimeout(() => { if ($('hint').textContent === text) $('hint').textContent = ''; }, 5000);
}

async function startDrawing() {
  const resp = await send({ type: 'start_draw' });
  if (!resp?.ok) return showHint(resp?.error || "Couldn't open drawing on this page.");
  $('drawChip').hidden = false;
  showHint('');
}

// ── @-mention a tab ──────────────────────────

const mentionMenu = $('mentionMenu');
let menuItems = [];
let menuIndex = 0;

function mentionQuery() {
  const upto = input.value.slice(0, input.selectionStart);
  const m = /(^|\s)@([^\s@]*)$/.exec(upto);
  return m ? { query: m[2].toLowerCase(), start: upto.length - m[2].length - 1 } : null;
}

function closeMenu() {
  mentionMenu.hidden = true;
  menuItems = [];
}

async function updateMenu() {
  const q = mentionQuery();
  if (!q) return closeMenu();
  const tabs = await chrome.tabs.query({ currentWindow: true });
  menuItems = tabs
    .filter((t) => t.id !== activeTab?.id && !extraTabs.has(t.id))
    .filter((t) => !q.query || (t.title || '').toLowerCase().includes(q.query) || host(t.url).includes(q.query))
    .slice(0, 8);
  menuIndex = 0;
  const head = document.createElement('div');
  head.className = 'mention-head';
  head.textContent = 'Share a tab with Bhai';
  mentionMenu.replaceChildren(head);
  if (!menuItems.length) {
    const empty = document.createElement('div');
    empty.className = 'mention-empty';
    empty.textContent = 'No other open tab to add';
    mentionMenu.append(empty);
  }
  menuItems.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'mention-item';
    row.setAttribute('role', 'option');
    if (/^https?:/.test(t.favIconUrl || '')) {
      const img = document.createElement('img');
      img.src = t.favIconUrl;
      img.alt = '';
      row.append(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'ph';
      row.append(ph);
    }
    const title = document.createElement('span');
    title.className = 'mention-title';
    title.textContent = t.title || 'Untitled';
    const site = document.createElement('span');
    site.className = 'mention-host';
    site.textContent = host(t.url);
    row.append(title, site);
    row.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(i); });
    mentionMenu.append(row);
  });
  highlightMenu();
  mentionMenu.hidden = false;
}

function highlightMenu() {
  [...mentionMenu.querySelectorAll('.mention-item')].forEach((el, i) => {
    el.classList.toggle('active', i === menuIndex);
    if (i === menuIndex) el.scrollIntoView({ block: 'nearest' });
  });
}

function pickMention(i) {
  const tab = menuItems[i];
  const q = mentionQuery();
  if (!tab || !q) return closeMenu();
  if (extraTabs.size >= 3) {
    showHint('You can share up to 3 other tabs.');
    return closeMenu();
  }
  extraTabs.set(tab.id, tab);
  const before = input.value.slice(0, q.start).replace(/\s+$/, '');
  const after = input.value.slice(input.selectionStart).replace(/^\s+/, '');
  input.value = before && after ? `${before} ${after}` : before || after;
  input.setSelectionRange(before.length + (before && after ? 1 : 0), before.length + (before && after ? 1 : 0));
  closeMenu();
  renderSharing();
  autosize();
  input.focus();
}

// ── Wiring ───────────────────────────────────

input.addEventListener('input', () => { autosize(); updateMenu(); });
input.addEventListener('click', updateMenu);
input.addEventListener('blur', () => setTimeout(closeMenu, 150));
input.addEventListener('keydown', (e) => {
  if (!mentionMenu.hidden && menuItems.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      menuIndex = (menuIndex + (e.key === 'ArrowDown' ? 1 : menuItems.length - 1)) % menuItems.length;
      return highlightMenu();
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pickMention(menuIndex); }
  }
  if (e.key === 'Escape') { if (!mentionMenu.hidden) return closeMenu(); if (busy) return stop(); }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) sendText(); }
});

sendBtn.addEventListener('click', () => (busy ? stop() : sendText()));
$('btnDraw').addEventListener('click', startDrawing);
$('btnDrawEdit').addEventListener('click', startDrawing);
$('btnDrawRemove').addEventListener('click', async () => {
  await send({ type: 'clear_draw' });
  $('drawChip').hidden = true;
});
$('btnAt').addEventListener('click', () => {
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const pad = before && !/\s$/.test(before) ? ' ' : '';
  input.value = `${before}${pad}@${input.value.slice(pos)}`;
  input.focus();
  input.setSelectionRange(pos + pad.length + 1, pos + pad.length + 1);
  updateMenu();
});
$('shareHead').addEventListener('click', () => {
  shareOpen = !shareOpen;
  renderSharing();
});
$('btnSelOff').addEventListener('click', () => {
  selectionIgnored = true;
  renderSelection();
});
for (const b of document.querySelectorAll('.suggest button')) {
  b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'summary') sendMessage({ type: 'send_page', question: 'Summarize this page for me.', display: 'Summarize this page' });
    else if (act === 'explain') sendMessage({ type: 'send_selection', question: 'Explain this simply.' });
    else startDrawing();
  });
}
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

// ── Live updates ─────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'chat_update') {
    renderChat(msg.chat);
    const last = msg.chat[msg.chat.length - 1];
    if (last && last.role !== 'you') setBusy(false);
  } else if (msg.type === 'atlas_progress') {
    setBusy(true, msg.text || 'Working…');
  } else if (msg.type === 'atlas_action') {
    setBusy(true, msg.entry?.detail || 'Working…');
  } else if (msg.type === 'page_selection' && sender.tab?.id === activeTab?.id) {
    selection = msg.text || '';
    selectionIgnored = false;
    renderSelection();
  }
});
chrome.tabs.onActivated.addListener(refreshTab);
chrome.tabs.onUpdated.addListener((id, info) => { if (id === activeTab?.id && (info.title || info.favIconUrl || info.url)) refreshTab(); });

async function refresh() {
  renderStatus(await send({ type: 'get_status' }));
}

send({ type: 'get_chat' }).then((resp) => renderChat(resp?.chat || []));
refreshTab();
refresh();
setInterval(refresh, 3000);
input.focus();
