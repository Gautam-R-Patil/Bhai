// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
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
        RHB.mountHub(root, state);
    }

    if (typeof document !== "undefined" && document.getElementById && document.getElementById("hub-root")) {
        boot();
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { boot: boot };
    }
})();
