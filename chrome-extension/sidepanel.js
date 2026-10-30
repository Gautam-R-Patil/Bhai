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

(() => {
  const h = new Date().getHours();
  const line = h < 5 ? 'Up late? What do you need?'
    : h < 12 ? "Morning. What's first?"
    : h < 17 ? 'What should we do here?'
    : h < 22 ? 'Evening. What can I take off your plate?'
    : 'Still going? What do you need?';
  $('greeting').textContent = line;
})();

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
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(?<![="'>\w])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function renderMarkdown(text) {
  const parts = escapeHtml(text).split(/```(?:[a-z0-9-]*)\n?([\s\S]*?)```/i);
  let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) { html += `<pre><code>${part}</code></pre>`; return; }
    for (const block of part.split(/\n{2,}/)) {
      const lines = block.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;
      if (lines.length >= 2 && lines.every((l) => /^\s*\|.*\|\s*$/.test(l)) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[1])) {
        const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
        const head = cells(lines[0]).map((c) => `<th>${c}</th>`).join('');
        const body = lines.slice(2).map((l) => `<tr>${cells(l).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
        html += `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
      } else if (lines.length === 1 && /^#{1,4}\s+/.test(lines[0])) {
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

function tag(name, text, kind) {
  const t = document.createElement('span');
  t.className = `tag ${kind}`;
  const label = document.createElement('span');
  label.textContent = text;
  t.append(icon(name, 12), label);
  return t;
}

let lastChat = [];
const timeOf = (ts) => {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

function messageEl(m, arriving = false) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  if (m.ts > 1e12) el.title = timeOf(m.ts);
  if (m.role === 'you') {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = m.text;
    el.append(bubble);
    const meta = m.meta || {};
    const tags = [];
    if (meta.drew) tags.push(tag('pen', 'Your drawing', 'draw'));
    if (meta.pasted) tags.push(tag('image', 'Image', 'draw'));
    if (meta.selection) tags.push(tag('quote', `“${meta.selection}”`, 'sel'));
    for (const t of meta.tabs || []) tags.push(tag('tab', t, 'tab'));
    if (tags.length) {
      const row = document.createElement('div');
      row.className = 'attach';
      row.append(...tags);
      el.append(row);
    }
  } else if (m.role === 'bhai') {
    const body = document.createElement('div');
    body.innerHTML = renderMarkdown(m.text);
    for (const pre of body.querySelectorAll('pre')) {
      const b = document.createElement('button');
      b.className = 'code-copy';
      b.textContent = 'Copy';
      b.addEventListener('click', async () => {
        await navigator.clipboard.writeText(pre.querySelector('code')?.textContent || '').catch(() => {});
        b.textContent = 'Copied';
        setTimeout(() => { b.textContent = 'Copy'; }, 1200);
      });
      pre.append(b);
    }
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

    // Read aloud with the Mac's own voice (nothing leaves the computer).
    if ('speechSynthesis' in window) {
      const speak = document.createElement('button');
      speak.className = 'icon-btn';
      const setSpeak = (on) => {
        speak.title = on ? 'Stop reading' : 'Read aloud';
        speak.setAttribute('aria-label', speak.title);
        speak.setAttribute('aria-pressed', String(on));
        speak.replaceChildren(icon(on ? 'hush' : 'speak', 15));
      };
      setSpeak(false);
      speak.addEventListener('click', () => {
        if (speak.getAttribute('aria-pressed') === 'true') { speechSynthesis.cancel(); return; }
        speechSynthesis.cancel();
        document.querySelectorAll('.reply-tools [aria-pressed="true"]').forEach((b) => b.dispatchEvent(new Event('speech-end')));
        const u = new SpeechSynthesisUtterance(body.innerText);
        u.onend = u.onerror = () => setSpeak(false);
        speak.addEventListener('speech-end', () => setSpeak(false), { once: true });
        setSpeak(true);
        speechSynthesis.speak(u);
      });
      tools.append(speak);
    }

    // Ask again (latest reply only): sends the question before it once more.
    const again = document.createElement('button');
    again.className = 'icon-btn again';
    again.title = 'Ask again';
    again.setAttribute('aria-label', 'Ask again');
    again.append(icon('again', 15));
    again.addEventListener('click', () => {
      const i = lastChat.indexOf(m);
      const q = [...lastChat.slice(0, i)].reverse().find((c) => c.role === 'you');
      if (q && !busy) sendMessage({ type: 'send_message', text: q.text, mentions: [...extraTabs.keys()] });
    });
    tools.append(again);

    const actions = m.meta?.actions || [];
    const feedback = actions.filter((a) => a.action.startsWith('feedback:'));
    const forget = actions.filter((a) => a.action.startsWith('mem:forget:'));
    const followups = actions.filter((a) => !feedback.includes(a) && !forget.includes(a));
    if (feedback.length) {
      for (const [action, name, label] of [['feedback:good', 'up-thumb', 'This helped'], ['feedback:bad', 'down-thumb', "This didn't help"]]) {
        if (!feedback.some((a) => a.action === action)) continue;
        const b = document.createElement('button');
        b.className = 'icon-btn';
        b.title = label;
        b.setAttribute('aria-label', label);
        b.append(icon(name, 15));
        b.dataset.fb = '1';
        b.addEventListener('click', () => {
          send({ type: 'quick_action', action, label });
          tools.querySelectorAll('[data-fb]').forEach((x) => x.remove());
          const t = document.createElement('span');
          t.className = 'thanks';
          t.textContent = 'Thanks';
          tools.append(t);
        });
        tools.append(b);
      }
    }
    for (const f of forget) {
      const b = document.createElement('button');
      b.className = 'link-btn';
      b.textContent = 'Forget that';
      b.title = 'Bhai just remembered something from this. Take it back.';
      b.addEventListener('click', () => { b.remove(); runAction(f); });
      tools.append(b);
    }
    el.append(body);
    const safeLinks = (m.meta?.links || []).filter((u) => /^https?:\/\//.test(u));
    if (safeLinks.length) {
      const list = document.createElement('ul');
      list.className = 'links';
      for (const url of safeLinks) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        const text = document.createElement('span');
        text.textContent = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
        a.append(icon('link', 13), text);
        li.append(a);
        list.append(li);
      }
      el.append(list);
    }
    if (followups.length) {
      const row = document.createElement('div');
      row.className = 'followups';
      for (const f of followups.slice(0, 4)) {
        const b = document.createElement('button');
        b.textContent = f.label;
        b.addEventListener('click', () => runAction(f));
        row.append(b);
      }
      el.append(row);
    }
    el.append(tools);
    if (arriving) {
      el.classList.add('reveal');
      [...body.children].forEach((c, i) => c.style.setProperty('--d', String(Math.min(i, 8))));
    }
  } else {
    // An error: say it, and offer to send the last message again.
    const text = document.createElement('span');
    text.textContent = `${m.text} `;
    el.append(text);
    const retry = document.createElement('button');
    retry.className = 'link-btn';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => {
      const lastYou = [...lastChat].reverse().find((c) => c.role === 'you');
      if (lastYou) { retry.remove(); sendMessage({ type: 'send_message', text: lastYou.text, mentions: [...extraTabs.keys()] }); }
    });
    el.append(retry);
  }
  return el;
}

let rendered = 0;
function renderChat(chat) {
  chat = chat || [];
  lastChat = chat;
  if (chat.length < rendered) { thread.querySelectorAll('.msg').forEach((el) => el.remove()); rendered = 0; }
  const working = $('workingRow');
  const arriving = rendered > 0 && chat.length - rendered === 1; // one new message, not the first load
  const wasAtBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  let newest = null;
  for (const m of chat.slice(rendered)) {
    newest = messageEl(m, arriving && m.role === 'bhai');
    thread.insertBefore(newest, working || null);
  }
  rendered = chat.length;
  const rows = thread.querySelectorAll('.bhai .followups');
  rows.forEach((r, i) => { r.hidden = i !== rows.length - 1 || chat[chat.length - 1]?.role !== 'bhai'; });
  $('welcome').hidden = chat.length > 0;
  $('btnNew').hidden = chat.length === 0;
  // Only the newest reply offers "Ask again".
  const agains = thread.querySelectorAll('.bhai .again');
  agains.forEach((b, i) => { b.hidden = i !== agains.length - 1; });
  if (arriving && !wasAtBottom && newest?.classList.contains('bhai')) {
    $('btnJump').hidden = false; // reading further up: don't yank them away
  } else if (arriving && newest?.classList.contains('bhai') && newest.offsetHeight > thread.clientHeight * 0.6) {
    thread.scrollTop = newest.offsetTop - 12;
  } else {
    thread.scrollTop = thread.scrollHeight;
  }
}

let lastProgress = 0;
const cleanProgress = (t) => (t || '')
  .replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, '')
  .replace(/^step\s+\d+\s*·\s*/i, '')
  .replace(/\s*·\s*\d+\s*s$/i, '')
  .trim();
function setBusy(on, text) {
  busy = on;
  lastProgress = Date.now();
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
  row.lastElementChild.textContent = cleanProgress(text) || 'Thinking…';
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
  $('statusText').textContent = canChat ? 'Connected' : searching ? 'Connecting…' : browserOn ? 'Reconnecting…' : 'Offline';
  $('offline').hidden = browserOn || searching;
  for (const b of document.querySelectorAll('.suggest button, #btnDraw, #btnAt')) b.disabled = !canChat;
  document.querySelectorAll('.followups button').forEach((b) => { b.disabled = !canChat; });
  input.placeholder = canChat ? 'Ask Bhai…' : 'Open Bhai to chat';
  updateSendState();
}

function updateSendState() {
  sendBtn.disabled = !busy && (!canChat || !(input.value.trim() || pendingImage));
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
  renderSharing();
  renderSuggestions();
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
  // The current tab is shared by default; the row only appears when there's more to say.
  $('sharing').hidden = !extraTabs.size && (shareTab || !canShareActive);
  const toggle = $('tabToggle');
  toggle.hidden = !canShareActive;
  if (canShareActive) {
    toggle.replaceChildren(favicon(activeTab));
    toggle.setAttribute('aria-pressed', String(shareTab));
    toggle.title = shareTab ? `Bhai sees ${host(activeTab.url) || 'this tab'}. Click to stop sharing it.` : `Not sharing ${host(activeTab.url) || 'this tab'}. Click to share it.`;
    toggle.setAttribute('aria-label', toggle.title);
  }
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

// ── Suggestions that fit the site ────────────

function suggestionsFor(tab) {
  const h = host(tab?.url || '');
  const path = (() => { try { return new URL(tab.url).pathname; } catch { return ''; } })();
  const ask = (label, text, ic = 'ask') => ({ label, ic, run: () => sendMessage({ type: 'send_message', text }) });
  const summary = { label: 'Summarize this page', ic: 'doc', run: () => sendMessage({ type: 'send_page', question: 'Summarize this page for me.', display: 'Summarize this page' }) };
  const explain = { label: "Explain what's here", ic: 'ask', run: () => sendMessage({ type: 'send_selection', question: 'Explain this simply.' }) };
  const draw = { label: 'Circle something to ask about', ic: 'pen', run: startDrawing };
  if (/youtube\.com$/.test(h) && path.startsWith('/watch')) {
    return [ask('Summarize this video', 'Summarize this video for me.', 'doc'), ask('What are the key points?', 'What are the key points of this video?'), draw];
  }
  if (h === 'github.com') {
    return [ask('Explain this repo', 'Explain what this repo is and how it is organised.', 'doc'), ask('What changed recently?', 'What changed recently here?'), draw];
  }
  if (h === 'mail.google.com' || /^(mail|webmail)\./.test(h) || /(^|\.)(outlook\.(live|office)\.com|mail\.yahoo\.com|proton\.me)$/.test(h)) {
    return [ask('Summarize this email', 'Summarize this email for me.', 'doc'), ask('Draft a reply', 'Draft a reply to this email. Show it to me before sending.'), draw];
  }
  if (h === 'docs.google.com') {
    return [ask('Summarize this doc', 'Summarize this document.', 'doc'), ask('How can this be better?', 'Suggest concrete improvements to this document.'), draw];
  }
  if (/(^|\.)(amazon|flipkart|myntra|ebay)\./.test(h)) {
    return [ask('Is this a good deal?', 'Is this a good deal? Check the price, reviews and alternatives.', 'doc'), ask('Compare with similar ones', 'Compare this with 2-3 similar products.'), draw];
  }
  if (/(^|\.)google\./.test(h) && path.startsWith('/search')) {
    return [ask('Which result should I open?', 'Which of these results is the most useful for what I searched, and why?', 'doc'), explain, draw];
  }
  return [summary, explain, draw];
}

function renderSuggestions() {
  const list = $('suggest');
  list.replaceChildren();
  for (const [i, sgt] of suggestionsFor(activeTab).entries()) {
    const b = document.createElement('button');
    b.style.setProperty('--i', i);
    b.textContent = sgt.label;
    b.disabled = !canChat;
    b.addEventListener('click', sgt.run);
    list.append(b);
  }
}

function runAction(a) {
  setBusy(true, 'Thinking…');
  send({ type: 'quick_action', action: a.action, label: a.label }).then((r) => { if (!r?.ok) setBusy(false); });
}

// ── Pasted / dropped image ───────────────────

let pendingImage = null; // data URL

async function attachImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    pendingImage = c.toDataURL('image/jpeg', 0.85);
    $('attachImg').src = pendingImage;
    $('attachment').hidden = false;
    updateSendState();
  } catch {
    showHint("Couldn't use that image.");
  }
}

function clearImage() {
  pendingImage = null;
  $('attachment').hidden = true;
  $('attachImg').removeAttribute('src');
  updateSendState();
}

// ── Sending ──────────────────────────────────

async function sendMessage(message) {
  setBusy(true, message.type === 'send_page' ? 'Reading the page…' : 'Thinking…');
  const resp = await send({
    ...message,
    noScreenshot: !shareTab,
    ignoreSelection: selectionIgnored,
    ...(pendingImage && message.type === 'send_message' ? { image: pendingImage } : {}),
  });
  if (!resp?.ok) {
    setBusy(false);
    showHint("Couldn't reach Bhai. Is the app open?");
    return false;
  }
  if (resp.drawing) $('drawChip').hidden = true;
  if (message.type === 'send_message') clearImage();
  if (resp.drawing) $('workingRow').lastElementChild.textContent = 'Looking at your drawing…';
  return true;
}

async function sendText() {
  const text = input.value.trim() || (pendingImage ? 'What is this?' : '');
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
  if (e.key === 'ArrowUp' && !input.value) {
    const lastYou = [...lastChat].reverse().find((c) => c.role === 'you');
    if (lastYou) { e.preventDefault(); input.value = lastYou.text; autosize(); input.setSelectionRange(input.value.length, input.value.length); }
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) sendText(); }
});

sendBtn.addEventListener('click', () => (busy ? stop() : sendText()));
input.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) { e.preventDefault(); attachImage(file); }
});
const composer = document.querySelector('.composer');
composer.addEventListener('dragover', (e) => { if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) { e.preventDefault(); composer.classList.add('dragging'); } });
composer.addEventListener('dragleave', () => composer.classList.remove('dragging'));
composer.addEventListener('drop', (e) => {
  composer.classList.remove('dragging');
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (file) { e.preventDefault(); attachImage(file); }
});
$('btnAttachOff').addEventListener('click', clearImage);
$('btnJump').addEventListener('click', () => {
  thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' });
  $('btnJump').hidden = true;
});
thread.addEventListener('scroll', () => {
  if (thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40) $('btnJump').hidden = true;
});
setInterval(() => {
  const row = $('workingRow');
  if (busy && row && Date.now() - lastProgress > 45000) row.lastElementChild.textContent = 'Still working on it…';
}, 5000);
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
$('tabToggle').addEventListener('click', () => {
  shareTab = !shareTab;
  renderSharing();
});
$('shareHead').addEventListener('click', () => {
  shareOpen = !shareOpen;
  renderSharing();
});
$('btnSelOff').addEventListener('click', () => {
  selectionIgnored = true;
  renderSelection();
});
$('btnNew').addEventListener('click', async () => {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
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
