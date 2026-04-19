// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Rotating "Try this" prompt strip for the Ready Hub. Picks 3 prompts from
// a catalog, weighted by which integrations are connected, cross-fades every
// 6s. pickPrompts is deterministic given a seed (for tests + stable UI).
(function () {
    "use strict";

    const CATALOG = {
        overlay: [
            "What's the weather?",
            "Open Figma and make a new file",
            "Summarize this page",
            "Start a 25-minute focus timer",
        ],
        google: [
            "Summarize today's meetings",
            "Find emails from Sarah this week",
            "What's on my calendar tomorrow?",
            "Draft a reply to the latest email",
        ],
        messaging: [
            "Text Alex that I'm running late",
            "Send Mom a weather forecast",
            "Reply to the most recent Telegram message",
        ],
    };

    // Mulberry32 PRNG — deterministic given a seed.
    function rng(seed) {
        let t = (seed >>> 0);
        return function () {
            t = (t + 0x6d2b79f5) | 0;
            let r = Math.imul(t ^ (t >>> 15), 1 | t);
            r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
            return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
        };
    }

    function _hasAnyChannel(channels) {
        if (!channels || typeof channels !== "object") return false;
        for (const k of Object.keys(channels)) {
            if (channels[k] && channels[k].connected) return true;
        }
        return false;
    }

    function pickPrompts(state, catalog, seed) {
        const s = state || {};
        const cat = catalog || CATALOG;
        const pool = (cat.overlay || []).slice();
        if (s.google && s.google.connected) pool.push.apply(pool, cat.google || []);
        if (_hasAnyChannel(s.channels)) pool.push.apply(pool, cat.messaging || []);
        const rand = rng(seed);
        const shuffled = pool.slice();
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
        }
        return shuffled.slice(0, 3);
    }

    // Builds 3 prompt pill buttons via createElement + textContent (no innerHTML).
    function _renderPills(container, prompts, onClick) {
        while (container.firstChild) container.removeChild(container.firstChild);
        for (const text of prompts) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "prompt-pill";
            btn.textContent = text;
            if (typeof onClick === "function") {
                btn.addEventListener("click", function () { onClick(text); });
            }
            container.appendChild(btn);
        }
    }

    // Mounts into `container`. Returns a handle with .stop() that clears the timer.
    function mount(container, state, opts) {
        const options = opts || {};
        const rotateMs = typeof options.rotateMs === "number" ? options.rotateMs : 6000;
        const initialSeed = typeof options.seed === "number" ? options.seed : (Date.now() & 0xffff);
        const onClick = options.onClick;
        if (!container) return { stop: function () {} };

        let seed = initialSeed;
        let timer = null;

        function renderOnce() {
            const prompts = pickPrompts(state, CATALOG, seed++);
            // Cross-fade: add fade-out, swap, remove fade-out on next frame.
            container.classList.add("fade-out");
            setTimeout(function () {
                _renderPills(container, prompts, onClick);
                container.classList.remove("fade-out");
            }, 250);
        }

        // First render immediately (no fade delay) so the hub isn't briefly empty.
        _renderPills(container, pickPrompts(state, CATALOG, seed++), onClick);

        if (rotateMs > 0) {
            timer = setInterval(renderOnce, rotateMs);
        }

        return {
            stop: function () {
                if (timer) { clearInterval(timer); timer = null; }
            },
            renderNow: renderOnce,
        };
    }

    const api = { CATALOG: CATALOG, pickPrompts: pickPrompts, mount: mount };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") window.TryThis = api;
})();
