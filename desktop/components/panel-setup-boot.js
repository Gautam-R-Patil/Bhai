// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Panel Setup tab bootstrap. Lazy-mounts the Ready Hub into #panel-hub-root the
// first time the user clicks the Setup tab. Reuses the same components +
// SystemState that ready-hub.html uses, so the two surfaces are identical.
(function () {
    "use strict";

    async function mountSetupTab() {
        const root = document.getElementById("panel-hub-root");
        if (!root || root.getAttribute("data-sp-mounted") === "1") return;
        const bhai = (typeof window !== "undefined" && window.bhai) ? window.bhai : {};
        const RHB = (typeof window !== "undefined") ? window.ReadyHubBody : null;
        if (!RHB || typeof RHB.mountHub !== "function") {
            root.textContent = "Ready Hub unavailable in panel (components not loaded).";
            return;
        }
        let state = {};
        if (typeof bhai.setupDetect === "function") {
            try { state = await bhai.setupDetect(); }
            catch (err) { state = { __detectError: (err && err.message) ? err.message : String(err) }; }
        }
        RHB.mountHub(root, state, bhai);
        root.setAttribute("data-sp-mounted", "1");
    }

    function onTabClick(ev) {
        const target = ev && ev.target;
        if (!target || typeof target.closest !== "function") return;
        const btn = target.closest('[data-tab="setup"]');
        if (!btn) return;
        mountSetupTab();
    }

    if (typeof document !== "undefined" && document.getElementById && document.getElementById("panel-hub-root")) {
        document.addEventListener("click", onTabClick, true);
        // If the Setup tab is the default-active tab on page load, mount immediately.
        const activeTab = document.querySelector('[data-tab="setup"].active, [data-tab="setup"][aria-selected="true"]');
        if (activeTab) mountSetupTab();
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { mountSetupTab: mountSetupTab };
    }
})();
