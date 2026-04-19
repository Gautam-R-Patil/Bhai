// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Renderer bootstrap for the adaptive wizard. IIFE at bottom runs on page load
// (when #wizard-header exists); pure helpers are exposed on window.__WizardBoot
// for testing without auto-booting.
(function () {
    "use strict";

    function clearChildren(el) {
        while (el && el.firstChild) el.removeChild(el.firstChild);
    }

    function renderDots(dotsEl, allSteps, activeSteps, currentId, onDotClick) {
        clearChildren(dotsEl);
        for (const id of allSteps) {
            const d = document.createElement("span");
            d.className = "step-dot"
                + (id === currentId ? " active" : "")
                + (activeSteps.indexOf(id) < 0 ? " skipped" : "");
            d.title = id;
            d.setAttribute("data-sp-step", id);
            if (activeSteps.indexOf(id) >= 0 && typeof onDotClick === "function") {
                d.addEventListener("click", function () {
                    onDotClick(activeSteps.indexOf(id));
                });
            }
            dotsEl.appendChild(d);
        }
    }

    function renderChips(chipsEl, chips, onChipClick) {
        clearChildren(chipsEl);
        for (let i = 0; i < chips.length; i++) {
            const c = chips[i];
            const b = document.createElement("button");
            b.type = "button";
            b.className = "chip";
            b.textContent = (c.label || "") + " \u2713";
            b.setAttribute("data-sp-chip", c.id || c.label || "");
            if (typeof onChipClick === "function") {
                const chip = c;
                b.addEventListener("click", function () { onChipClick(chip); });
            }
            chipsEl.appendChild(b);
        }
    }

    // Decide whether to skip straight to Ready Hub, or render step 0.
    // Returns { route: "ready-hub" | "step", stepIndex?: number }.
    function decideInitialRoute(steps) {
        if (!Array.isArray(steps) || steps.length === 0) return { route: "ready-hub" };
        return { route: "step", stepIndex: 0 };
    }

    async function boot() {
        const headerEl = document.getElementById("wizard-header");
        const dotsEl = document.getElementById("step-dots");
        const chipsEl = document.getElementById("already-set-strip");
        const stepEl = document.getElementById("current-step");
        if (!headerEl || !dotsEl || !chipsEl || !stepEl) return; // not the wizard page

        const atlas = window.atlas || {};
        const router = window.WizardRouter;
        if (!router || !atlas.setupDetect) {
            stepEl.textContent = "Setup shell failed to load (router or IPC missing).";
            return;
        }

        let state;
        try { state = await atlas.setupDetect(); }
        catch (err) {
            stepEl.textContent = "Detection failed: " + (err.message || String(err));
            return;
        }
        let { steps, header } = router.getSteps(state);
        headerEl.textContent = header;

        const initial = decideInitialRoute(steps);
        if (initial.route === "ready-hub") {
            window.location.href = "ready-hub.html";
            return;
        }

        async function refreshState() {
            try { state = await atlas.setupDetect(); }
            catch { return; }
            const nxt = router.getSteps(state);
            steps = nxt.steps;
            headerEl.textContent = nxt.header;
            refreshChips();
        }

        function refreshChips() {
            const chips = (window.WizardChips && typeof window.WizardChips.buildChips === "function")
                ? window.WizardChips.buildChips(state)
                : [];
            renderChips(chipsEl, chips, function (chip) {
                const i = steps.indexOf(chip.stepTarget);
                if (i >= 0) renderIndex(i);
                else window.dispatchEvent(new CustomEvent("wizard:manage", { detail: chip }));
            });
        }

        function goBack(fromIdx) {
            const p = router.prev(fromIdx);
            if (p !== -1) renderIndex(p);
        }

        async function advance(fromIdx) {
            const n = router.next(fromIdx, steps);
            if (n === -1) {
                await refreshState();
                const installIdx = steps.indexOf("install");
                if (installIdx >= 0) { renderIndex(installIdx); return; }
                window.location.href = "ready-hub.html";
                return;
            }
            renderIndex(n);
        }

        function renderIndex(idx) {
            const id = steps[idx];
            renderDots(dotsEl, router.ALL_STEPS, steps, id, function (newIdx) { renderIndex(newIdx); });
            refreshChips();
            clearChildren(stepEl);
            const stepApi = window.WizardSteps && window.WizardSteps[id];
            if (!stepApi || typeof stepApi.render !== "function") {
                const msg = document.createElement("div");
                msg.textContent = "Unknown step: " + id;
                stepEl.appendChild(msg);
                return;
            }
            stepApi.render(stepEl, {
                state: state,
                onAdvance: function () { advance(idx); },
                onBack: function () { goBack(idx); },
                refreshState: refreshState,
            });
        }

        renderIndex(0);
    }

    // Expose testable helpers
    if (typeof window !== "undefined") {
        window.__WizardBoot = {
            clearChildren: clearChildren,
            renderDots: renderDots,
            renderChips: renderChips,
            decideInitialRoute: decideInitialRoute,
        };
    }

    // Auto-boot only if we're on a real wizard page with the expected container.
    // jsdom tests that import this file as a <script> text will not auto-trigger,
    // because they set up document.body first without the expected IDs.
    if (typeof document !== "undefined" && document.getElementById && document.getElementById("wizard-header")) {
        boot();
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            clearChildren: clearChildren,
            renderDots: renderDots,
            renderChips: renderChips,
            decideInitialRoute: decideInitialRoute,
        };
    }
})();
