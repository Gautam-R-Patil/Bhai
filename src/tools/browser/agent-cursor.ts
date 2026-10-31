// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Bhai's cursor + "working here" glow ───────
// So the owner can SEE Bhai in a tab: a named pointer that glides to each
// target before the real click/type/hover/scroll, a ripple on click, and a
// soft glow border + pill while a task is live on the tab.
//
// Everything lives in a CLOSED shadow root on an empty, aria-hidden host
// appended to <html> (not <body>): querySelectorAll, innerText, getByText,
// ariaSnapshot and body MutationObservers never see it, so it stays out of
// scans, Site Skill snapshots and recorded traces. pointer-events:none on
// every node, so a click at the cursor lands on the page element under it.
//
// BHAI_NO_AGENT_CURSOR=true turns it all off; BHAI_NO_AGENT_PRESENCE=true
// keeps the cursor but drops the glow + pill.

/** Host element id; the only node the page can see. */
export const AGENT_UI_HOST_ID = "__bhaiAgentUI";
/** Glow + pill fade after this long without a browser action. */
export const AGENT_PRESENCE_IDLE_MS = 15_000;
/** Most an action ever waits for the cursor (round trip + glide). */
export const AGENT_CURSOR_CAP_MS = 350;

// ({x?, y?, kind, idleMs, presence, end}) → glide ms. Idempotent; end removes it.
export const AGENT_UI_JS = `
({x, y, kind, idleMs, presence, end}) => {
    const ID = '${AGENT_UI_HOST_ID}';
    let host = document.getElementById(ID);
    if (end) { if (host) host.remove(); return 0; }
    let ui = host && host.__bhai;
    if (!ui) {
        if (host) host.remove();
        host = document.createElement('bhai-agent');
        host.id = ID;
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647';
        const root = host.attachShadow({ mode: 'closed' });
        // Built node by node (no innerHTML): Trusted Types pages (Gmail, YouTube,
        // Docs) throw on an innerHTML string. A constructed sheet also gets past
        // a style-src that forbids inline <style>.
        const css =
            '*{pointer-events:none;box-sizing:border-box}' +
            '.cur{position:fixed;left:0;top:0;opacity:0;will-change:transform;transition:transform var(--d,300ms) cubic-bezier(.22,.61,.36,1),opacity .4s ease}' +
            '.cur.on{opacity:1}' +
            '.cur svg{display:block;filter:drop-shadow(0 2px 6px rgba(0,0,0,.45));transform-origin:1px 1px}' +
            '.cur.typing svg{animation:bhaiPulse .9s ease-in-out infinite}' +
            '.tag{position:absolute;left:14px;top:19px;padding:2px 8px;border-radius:10px;background:rgba(15,23,42,.9);border:1px solid #1e3a5f;color:#e2e8f0;font:600 10px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.2px;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.35)}' +
            '.rip{position:fixed;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;border:2px solid var(--c);background:var(--b);animation:bhaiRipple .55s cubic-bezier(.4,0,.2,1) forwards}' +
            '.glow{position:fixed;inset:0;opacity:0;transition:opacity .5s ease;box-shadow:inset 0 0 0 2px rgba(59,130,246,.5),inset 0 0 26px 4px rgba(59,130,246,.3);animation:bhaiGlow 2.4s ease-in-out infinite}' +
            '.pill{position:fixed;top:10px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:20px;background:rgba(15,23,42,.9);border:1px solid #1e3a5f;backdrop-filter:blur(8px);box-shadow:0 4px 20px rgba(0,0,0,.4);color:#e2e8f0;font:500 11px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.2px;white-space:nowrap;opacity:0;transition:opacity .3s ease}' +
            '.pill i{width:6px;height:6px;border-radius:50%;background:#3b82f6;animation:bhaiPulse 1.2s ease-in-out infinite}' +
            '.glow.on,.pill.on{opacity:1}' +
            '@keyframes bhaiPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}' +
            '@keyframes bhaiRipple{0%{transform:scale(.3);opacity:1}100%{transform:scale(1.9);opacity:0}}' +
            '@keyframes bhaiGlow{50%{box-shadow:inset 0 0 0 2px rgba(59,130,246,.85),inset 0 0 42px 8px rgba(59,130,246,.42)}}' +
            '@media (prefers-reduced-motion:reduce){.cur{transition:opacity .2s}.glow,.pill i,.cur.typing svg,.rip{animation:none}}';
        try { const sheet = new CSSStyleSheet(); sheet.replaceSync(css); root.adoptedStyleSheets = [sheet]; }
        catch (e) { const st = document.createElement('style'); st.textContent = css; root.appendChild(st); }
        const add = (tag, cls, parent) => { const n = document.createElement(tag); n.className = cls; parent.appendChild(n); return n; };
        add('div', 'glow', root);
        const pill = add('div', 'pill', root);
        add('i', '', pill);
        pill.appendChild(document.createTextNode('Bhai is working here'));
        const cur = add('div', 'cur', root);
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        const path = document.createElementNS(NS, 'path');
        for (const [k, v] of [['width', '20'], ['height', '22'], ['viewBox', '0 0 20 22']]) svg.setAttribute(k, v);
        for (const [k, v] of [['d', 'M1 1v17l4.6-4.4 3 6.9 3-1.3-3-6.8H15z'], ['fill', '#3b82f6'], ['stroke', '#fff'],
                              ['stroke-width', '1.6'], ['stroke-linejoin', 'round']]) path.setAttribute(k, v);
        svg.appendChild(path);
        cur.appendChild(svg);
        add('span', 'tag', cur).textContent = 'Bhai';
        (document.documentElement || document.body).appendChild(host);
        ui = host.__bhai = { root, cur, x: innerWidth / 2, y: innerHeight / 2 };
        ui.cur.style.transform = 'translate(' + (ui.x - 1) + 'px,' + (ui.y - 1) + 'px)';
    }
    const r = ui.root;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let glide = 0;
    if (typeof x === 'number' && typeof y === 'number' && isFinite(x) && isFinite(y)) {
        const dist = Math.hypot(x - ui.x, y - ui.y);
        glide = reduce || dist < 3 ? 0 : Math.round(Math.min(320, 220 + dist * 0.12));
        ui.cur.style.setProperty('--d', glide + 'ms');
        ui.cur.style.transform = 'translate(' + (x - 1) + 'px,' + (y - 1) + 'px)';
        ui.x = x; ui.y = y;
    }
    if (kind !== 'presence') ui.cur.classList.add('on');
    ui.cur.classList.toggle('typing', kind === 'type');
    const colors = { click: ['#3b82f6', 'rgba(59,130,246,.15)'], double: ['#a855f7', 'rgba(168,85,247,.15)'],
                     right: ['#ef4444', 'rgba(239,68,68,.15)'], hold: ['#22c55e', 'rgba(34,197,94,.15)'] };
    if (colors[kind]) {
        const at = [ui.x, ui.y];
        setTimeout(() => {
            const rip = document.createElement('div');
            rip.className = 'rip';
            rip.style.cssText = 'left:' + at[0] + 'px;top:' + at[1] + 'px;--c:' + colors[kind][0] + ';--b:' + colors[kind][1];
            r.appendChild(rip);
            setTimeout(() => rip.remove(), 600);
        }, glide);
    }
    clearTimeout(ui.t1);
    ui.t1 = setTimeout(() => ui.cur.classList.remove('on', 'typing'), glide + 3000);
    const on = presence !== false;
    r.querySelector('.glow').classList.toggle('on', on);
    r.querySelector('.pill').classList.toggle('on', on);
    clearTimeout(ui.t2);
    ui.t2 = setTimeout(() => {
        r.querySelector('.glow').classList.remove('on');
        r.querySelector('.pill').classList.remove('on');
        ui.t3 = setTimeout(() => { if (ui.cur.classList.contains('on')) return; host.remove(); }, 600);
    }, Math.max(glide + 3000, idleMs || 15000));
    clearTimeout(ui.t3);
    return glide;
}
`;

type AnyPage = any;
type Box = { x: number; y: number; width: number; height: number } | null;
/** A point, or anything with Playwright's boundingBox() (Locator, ElementHandle, ChromeLocatorProxy). */
export type CursorTarget = { x: number; y: number } | { boundingBox: (o?: { timeout?: number }) => Promise<Box> };
export type CursorKind = "click" | "double" | "right" | "hold" | "hover" | "type" | "scroll" | "presence";

let activeUntil = 0;
const navHooked = new WeakSet<object>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

const enabled = () => process.env.BHAI_NO_AGENT_CURSOR !== "true";
const presenceOn = () => process.env.BHAI_NO_AGENT_PRESENCE !== "true";
const call = (arg: Record<string, unknown>) => `(${AGENT_UI_JS})(${JSON.stringify(arg)})`;

/**
 * Glide Bhai's cursor to `at` (centre of a box), then return so the caller
 * does the real action. Never throws; waits at most AGENT_CURSOR_CAP_MS (1s on the Chrome bridge).
 * Omit `at` to just pulse/refresh the tab-in-use glow where the cursor is.
 */
export async function agentCursor(page: AnyPage, at?: CursorTarget | null, kind: CursorKind = "click"): Promise<void> {
    if (!enabled() || !page || typeof page.evaluate !== "function") return;
    if (slowBridge.has(page)) return; // this bridge page already outran the cap once
    activeUntil = Date.now() + AGENT_PRESENCE_IDLE_MS;
    // Playwright: a navigation wipes the overlay; put the glow back on the new
    // document while the task is still live. The Chrome bridge re-shows it on
    // the next action instead.
    if (typeof page.on === "function" && !navHooked.has(page)) {
        navHooked.add(page);
        page.on("domcontentloaded", () => {
            if (!enabled() || Date.now() > activeUntil) return;
            page.evaluate(call({ kind: "presence", idleMs: activeUntil - Date.now(), presence: presenceOn() })).catch(
                () => {},
            );
        });
    }
    const t0 = Date.now();
    const left = () => AGENT_CURSOR_CAP_MS - (Date.now() - t0);
    const run = (async () => {
        let x: number | undefined;
        let y: number | undefined;
        if (at && "boundingBox" in at) {
            const b = await at.boundingBox({ timeout: AGENT_CURSOR_CAP_MS }).catch(() => null);
            if (b) {
                x = b.x + b.width / 2;
                y = b.y + b.height / 2;
            }
        } else if (at) {
            ({ x, y } = at);
        }
        if (left() <= 0) return; // cap spent finding the target: skip the overlay, don't race the action
        const glide = Number(
            await page.evaluate(call({ x, y, kind, idleMs: AGENT_PRESENCE_IDLE_MS, presence: presenceOn() })),
        );
        await sleep(Math.min(glide || 0, left()));
    })().catch(() => {});
    // The Chrome bridge (no page.on) attaches and detaches the debugger around
    // every eval, so one left in flight can detach in the middle of the real
    // action's command: wait for it there, but only up to a hard cap (its own
    // eval timeout is 15s). A page that outruns the cap gets no cursor from then
    // on, so an overlap happens at most once. Playwright queues a page's evals
    // in order, so stop waiting at the normal cap.
    if (!bridge(page)) {
        await Promise.race([run, sleep(AGENT_CURSOR_CAP_MS)]);
        return;
    }
    const finished = await Promise.race([run.then(() => true), sleep(BRIDGE_CAP_MS).then(() => false)]);
    if (!finished) slowBridge.add(page);
}

const BRIDGE_CAP_MS = 1000;
const slowBridge = new WeakSet<object>();
const bridge = (page: AnyPage) => typeof page.on !== "function";
// Counts captures in flight on the host, so overlapping captures restore the
// overlay only when the last one is done.
const HIDE_JS = (hide: boolean) => `(() => {
  const h = document.getElementById('${AGENT_UI_HOST_ID}');
  if (!h) return false;
  const n = Math.max(0, Number(h.dataset.hides || 0) + (${hide} ? 1 : -1));
  h.dataset.hides = String(n);
  h.style.visibility = n > 0 ? 'hidden' : '';
  return ${hide} && new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(() => r(true))); setTimeout(() => r(true), 100); });
})()`;

/**
 * Runs a screenshot / OCR / vision capture of the page with Bhai's overlay
 * hidden, so the cursor, tag, glow and pill never reach Bhai's own vision or
 * become OCR click targets. The Chrome bridge hides it inside the extension's
 * screenshot command instead (no extra debugger attach).
 */
export async function withAgentUIHidden<T = Buffer>(page: AnyPage, capture: () => Promise<T>): Promise<T> {
    const hidden =
        !!page &&
        typeof page.evaluate === "function" &&
        !bridge(page) &&
        (await page.evaluate(HIDE_JS(true)).catch(() => false));
    try {
        return await capture();
    } finally {
        if (hidden) await page.evaluate(HIDE_JS(false)).catch(() => {});
    }
}
