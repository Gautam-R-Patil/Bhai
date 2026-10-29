// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Ready Hub page bootstrap. Runs on ready-hub.html only — guarded by the
// presence of #hub-root so vitest/jsdom tests can import other files
// without auto-booting.
(function () {
    "use strict";
    async function boot() {
        const root = document.getElementById("hub-root");
        if (!root) return;
        const atlas = window.atlas || {};
        const RHB = window.ReadyHubBody;
        if (!RHB || typeof RHB.mountHub !== "function") {
            root.textContent = "Ready Hub shell failed to load (ReadyHubBody missing).";
            return;
        }
        let state = {};
        if (typeof atlas.setupDetect === "function") {
            try { state = await atlas.setupDetect(); }
            catch (err) { state = { __detectError: err.message || String(err) }; }
        }
        try {
            await RHB.mountHub(root, state);
        } catch (err) {
            // Never leave the user staring at a black void — surface the failure.
            root.textContent = "Ready Hub failed to render: " + (err && (err.message || err));
            root.classList.add("ready");
            return;
        }

        // The .step-root staggered-entry CSS (styles.css) starts every direct
        // child at opacity:0 and only reveals them once the container has the
        // `ready` class. In the wizard, boot.js adds it after each step
        // transition; the standalone ready-hub page has no router, so without
        // this the whole hub body renders invisible — a black screen below the
        // chrome header.
        const children = root.children;
        for (let i = 0; i < children.length; i++) {
            children[i].style.setProperty("--enter-delay", (60 + i * 70) + "ms");
        }
        requestAnimationFrame(function () {
            root.classList.remove("entering");
            requestAnimationFrame(function () { root.classList.add("ready"); });
        });
    }

    if (typeof document !== "undefined" && document.getElementById && document.getElementById("hub-root")) {
        boot();
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { boot: boot };
    }
})();
