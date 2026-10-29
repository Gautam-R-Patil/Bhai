// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Bhai's ghost cursor for computer use: one transparent, click-through,
 * focus-less, always-on-top window per display (agent-cursor.html) that shows
 * where Bhai is about to move, click, drag, scroll or type, plus a soft glow
 * round the screen edges while Bhai is in control.
 *
 * Fed by "##BHAI_CURSOR##{json}" lines on the bot's stdout (src/screen/agent-cursor.ts).
 * Events with an `id` are acked on the bot's stdin: moves once the glide is
 * done, "hide" once the windows are invisible (the bot is about to take its own
 * screenshot). The bot bounds every wait, so a slow ack never stalls it.
 */

const IDLE_END_MS = 90_000; // bot went quiet without ending the session (crash, hang)
const FADE_MS = 600; // matches the glow fade in agent-cursor.html
const HIDE_SETTLE_MS = 40; // let the window server composite the hidden frame

function parseCursorLine(line) {
    const m = /^##BHAI_CURSOR##(\{.*\})\s*$/.exec(line);
    if (!m) return null;
    try {
        const evt = JSON.parse(m[1]);
        return evt && typeof evt.t === "string" ? evt : null;
    } catch {
        return null;
    }
}

/** The display containing `p` (global DIP), else the nearest one. */
function pickDisplay(p, displays) {
    let best = null;
    let bestDist = Infinity;
    for (const d of displays) {
        const b = d.bounds;
        const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width - 1));
        const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height - 1));
        const dist = dx * dx + dy * dy;
        if (dist === 0) return d;
        if (dist < bestDist) {
            bestDist = dist;
            best = d;
        }
    }
    return best;
}

function toLocal(p, display) {
    return { x: p.x - display.bounds.x, y: p.y - display.bounds.y };
}

/** Glide time between two points: quick for hops, capped under the bot's 300ms wait. */
function glideMs(from, to) {
    if (!from) return 0;
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    if (d < 2) return 0;
    return Math.round(Math.min(280, 120 + d * 0.15));
}

function createAgentCursor({ BrowserWindow, screen, htmlPath, harden = () => {}, platform = process.platform, timers = globalThis }) {
    const views = new Map(); // display id -> { win, ready, queue }
    let displays = [];
    let pos = null; // last global DIP point
    let activeId = null; // display the ghost is on
    let sessionOn = false;
    let shown = false; // windows on screen (session on, or still fading out)
    let hidden = false; // a bot capture is in progress: keep opacity 0
    let idleTimer = null;
    let hideTimer = null;

    // macOS CGEvent points are already DIP. Windows tools post physical pixels.
    const toDip = (p) => (platform === "win32" && screen.screenToDipPoint ? screen.screenToDipPoint({ x: p.x, y: p.y }) : { x: p.x, y: p.y });
    const alive = (v) => v && !v.win.isDestroyed();

    function post(view, msg) {
        if (!alive(view)) return;
        if (!view.ready) return void view.queue.push(msg);
        view.win.webContents.executeJavaScript(`window.cursor(${JSON.stringify(msg)})`).catch(() => {});
    }
    const postAll = (msg) => { for (const v of views.values()) post(v, msg); };
    const setOpacity = (o) => { for (const v of views.values()) if (alive(v)) v.win.setOpacity(o); };

    function makeView(d) {
        const win = new BrowserWindow({
            ...d.bounds,
            frame: false,
            transparent: true,
            focusable: false,
            skipTaskbar: true,
            hasShadow: false,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            enableLargerThanScreen: true,
            show: false,
            backgroundColor: "#00000000",
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false },
        });
        harden(win);
        win.setIgnoreMouseEvents(true);
        // Belt and braces with the hide-before-capture handshake.
        win.setContentProtection(true);
        win.setAlwaysOnTop(true, "screen-saver");
        // skipTransformProcessType: don't flip the macOS process type (that
        // hides the dock and can re-activate the app).
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
        const view = { win, ready: false, queue: [] };
        win.webContents.on("did-finish-load", () => {
            view.ready = true;
            for (const m of view.queue.splice(0)) post(view, m);
        });
        win.loadFile(htmlPath);
        return view;
    }

    function syncDisplays() {
        displays = screen.getAllDisplays();
        const ids = new Set(displays.map((d) => d.id));
        for (const [id, v] of views) {
            if (ids.has(id) && alive(v)) continue;
            if (alive(v)) v.win.destroy();
            views.delete(id);
        }
        for (const d of displays) {
            const v = views.get(d.id);
            if (v) {
                v.win.setBounds(d.bounds);
                continue;
            }
            const nv = makeView(d);
            views.set(d.id, nv);
            if (shown) {
                nv.win.setOpacity(hidden ? 0 : 1);
                nv.win.showInactive();
                if (sessionOn) post(nv, { t: "session", on: true });
            }
        }
    }

    /** Make the windows now (app ready), and keep them in step with the displays. */
    function init() {
        syncDisplays();
        for (const ev of ["display-added", "display-removed", "display-metrics-changed"]) screen.on?.(ev, syncDisplays);
    }

    /** Move the ghost to global DIP point `p`; returns the glide time. */
    function glideTo(p, msg) {
        const d = pickDisplay(p, displays);
        if (!d) return 0;
        let ms = 0;
        if (activeId === d.id) ms = glideMs(pos, p);
        else if (activeId !== null) post(views.get(activeId), { t: "leave" });
        pos = p;
        activeId = d.id;
        post(views.get(d.id), { ...msg, ...toLocal(p, d), ms });
        return ms;
    }

    function startSession() {
        if (sessionOn) return;
        sessionOn = true;
        shown = true;
        timers.clearTimeout(hideTimer);
        pos = null;
        activeId = null;
        for (const v of views.values()) {
            if (!alive(v)) continue;
            v.win.setOpacity(hidden ? 0 : 1);
            v.win.showInactive();
        }
        postAll({ t: "session", on: true });
        // Start where the real pointer is, so the first glide reads naturally.
        glideTo(screen.getCursorScreenPoint(), { t: "move" });
    }

    function endSession() {
        if (!sessionOn) return;
        sessionOn = false;
        postAll({ t: "session", on: false });
        hideTimer = timers.setTimeout(() => {
            shown = false;
            for (const v of views.values()) if (alive(v)) v.win.hide();
        }, FADE_MS);
    }

    /** Apply one bot event; `ack(id)` answers events that carry an id. */
    function handle(evt, ack) {
        let wait = 0;
        switch (evt.t) {
            case "session":
                if (evt.on) startSession();
                else endSession();
                break;
            case "hide":
                hidden = true;
                if (shown && views.size) {
                    setOpacity(0);
                    wait = HIDE_SETTLE_MS;
                }
                break;
            case "show":
                hidden = false;
                setOpacity(1);
                break;
            case "type":
                post(views.get(activeId), { t: "type", on: !!evt.on });
                break;
            case "move":
            case "click":
            case "scroll": {
                startSession();
                const msg =
                    evt.t === "click"
                        ? { t: "click", button: evt.button || "left", count: evt.count || 1 }
                        : evt.t === "scroll"
                          ? { t: "scroll", dx: evt.dx || 0, dy: evt.dy || 0 }
                          : { t: "move" };
                wait = glideTo(toDip(evt), msg);
                break;
            }
            case "drag": {
                const pts = Array.isArray(evt.points) ? evt.points.map(toDip) : [];
                if (!pts.length) break;
                startSession();
                wait = glideTo(pts[0], { t: "move" });
                const d = displays.find((x) => x.id === activeId);
                if (d) post(views.get(activeId), { t: "drag", points: pts.map((p) => toLocal(p, d)), delay: wait });
                pos = pts[pts.length - 1];
                break;
            }
        }
        timers.clearTimeout(idleTimer);
        if (sessionOn) idleTimer = timers.setTimeout(endSession, IDLE_END_MS);
        if (evt.id == null) return;
        if (wait > 0) timers.setTimeout(() => ack(evt.id), wait);
        else ack(evt.id);
    }

    /** The bot exited: let go of the screen. */
    function reset() {
        timers.clearTimeout(idleTimer);
        hidden = false;
        setOpacity(1);
        endSession();
    }

    return { init, handle, reset };
}

module.exports = { createAgentCursor, parseCursorLine, pickDisplay, toLocal, glideMs, HIDE_SETTLE_MS };
