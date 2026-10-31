// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Renderer bootstrap for the cinematic wizard. IIFE at bottom runs on page load
// when #step-root exists; pure helpers exposed on window.__WizardBoot for tests.
(function () {
    "use strict";

    function clearChildren(el) {
        while (el && el.firstChild) el.removeChild(el.firstChild);
    }

    function renderIndicator(host, allSteps, activeSteps, currentIdx, onDotClick) {
        clearChildren(host);
        // Awakening (if a flow still has it) doesn't show in the indicator strip.
        for (let i = activeSteps[0] === "awakening" ? 1 : 0; i < activeSteps.length; i++) {
            const id = activeSteps[i];
            const cls = "indicator-dot"
                + (i === currentIdx ? " active" : i < currentIdx ? " done" : "");
            const dot = document.createElement("span");
            dot.className = cls;
            dot.setAttribute("data-sp-step", id);
            // Only completed steps are clickable: jumping ahead would skip the
            // terms and sign-in gates.
            if (typeof onDotClick === "function" && i < currentIdx) {
                dot.addEventListener("click", function () { onDotClick(i); });
                dot.style.cursor = "pointer";
            }
            host.appendChild(dot);
        }
    }

    function setFolio(folioEl, currentIdx, total) {
        if (!folioEl) return;
        folioEl.textContent = String(currentIdx + 1).padStart(2, "0") + " / " + String(total).padStart(2, "0");
    }

    // Apply user's theme preference. Empty string ⇒ remove attribute ⇒ OS decides.
    function applyTheme(value) {
        const root = document.documentElement;
        if (!value || value === "system") root.removeAttribute("data-theme");
        else root.setAttribute("data-theme", value);
    }

    function decideInitialRoute(steps) {
        if (!Array.isArray(steps) || steps.length === 0) return { route: "ready-hub" };
        return { route: "step", stepIndex: 0 };
    }

    async function boot() {
        const stepEl  = document.getElementById("step-root");
        const indEl   = document.getElementById("indicator");
        const folioEl = document.getElementById("chrome-folio");
        if (!stepEl) return; // not the wizard page

        const bhai  = window.bhai || {};
        const router = window.WizardRouter;
        const Cin    = window.Cinematic || { scribeRule: function () {}, applyConfidence: function () {} };
        if (!router || !bhai.setupDetect) {
            stepEl.textContent = "Setup shell failed to load (router or IPC missing).";
            return;
        }

        let state;
        try { state = await bhai.setupDetect(); }
        catch (err) {
            stepEl.textContent = "Detection failed: " + (err.message || String(err));
            return;
        }
        let { steps } = router.getSteps(state);

        // Apply stored theme preference (empty = follow system).
        applyTheme((state.personalize && state.personalize.theme) || "");

        // Initialize audio enabled-state from persisted preference.
        if (window.WizardAudio && window.WizardAudio.setEnabled) {
            const enabled = (state.personalize && state.personalize.audio && state.personalize.audio.enabled) || false;
            window.WizardAudio.setEnabled(enabled);
            if (enabled) window.WizardAudio.preload();
        }

        const initial = decideInitialRoute(steps);
        if (initial.route === "ready-hub") {
            window.location.href = "ready-hub.html";
            return;
        }

        async function refreshState() {
            try { state = await bhai.setupDetect(); }
            catch { return; }
            const nxt = router.getSteps(state);
            steps = nxt.steps;
        }

        function goBack(fromIdx) {
            const p = router.prev(fromIdx);
            if (p !== -1) renderIndex(p);
        }

        async function advance(fromIdx) {
            if (window.WizardAudio && window.WizardAudio.play) window.WizardAudio.play("confirm");
            const n = router.next(fromIdx, steps);
            if (n === -1) {
                // End of the flow → Ready Hub. (install is no longer terminal: it
                // hands off via onAdvance to signin → permissions, which end here.)
                window.location.href = "ready-hub.html";
                return;
            }
            renderIndex(n);
        }

        function renderIndex(idx) {
            const id = steps[idx];

            // 1. Outgoing-step cleanup hook (used by awakening to clear timers/listeners).
            if (typeof stepEl._cleanup === "function") {
                try { stepEl._cleanup(); } catch (_) { /* swallow */ }
                stepEl._cleanup = null;
            }

            // 2. Leave animation
            stepEl.classList.add("leaving");
            setTimeout(function () {
                stepEl.classList.remove("leaving", "ready");
                stepEl.classList.add("entering");
                clearChildren(stepEl);
                document.body.setAttribute("data-step", id);

                Cin.applyConfidence(idx, steps.length);

                // 3. Render the step
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
                    onBack:    function () { goBack(idx); },
                    refreshState: refreshState,
                });

                // 4. Chrome + indicator
                setFolio(folioEl, idx, steps.length);
                renderIndicator(indEl, router.ALL_STEPS, steps, idx, function (newIdx) { renderIndex(newIdx); });

                // 5. Scribe the iridescent rule (awakening is the only step that skips this).
                if (id !== "awakening") Cin.scribeRule();

                // 6. Cascade entry — set per-child --enter-delay, then add .ready
                const children = stepEl.children;
                for (let i = 0; i < children.length; i++) {
                    children[i].style.setProperty("--enter-delay", (60 + i * 70) + "ms");
                }

                requestAnimationFrame(function () {
                    stepEl.classList.remove("entering");
                    requestAnimationFrame(function () { stepEl.classList.add("ready"); });
                });
            }, 220);
        }

        // Auto-advance once OTPless sign-in completes. The signin step opens
        // a popup that resolves asynchronously; main.js fires this event when
        // account:login succeeds. Signin now sits near the END of the flow
        // (after install), so the step that follows it is permissions (macOS) or
        // nothing (Windows → Ready Hub).
        if (typeof bhai.onAccountStatusChange === "function") {
            bhai.onAccountStatusChange(async function (data) {
                if (!data || data.signedIn !== true) return;
                if (document.body.getAttribute("data-step") !== "signin") return;
                // Capture the successor from the CURRENT (rendered) list BEFORE
                // refreshState() recomputes it — once signed in, signin is gated
                // out of the recomputed list, so its old index would be lost.
                const signinIdx = steps.indexOf("signin");
                const successor = (signinIdx >= 0 && signinIdx + 1 < steps.length)
                    ? steps[signinIdx + 1]
                    : null;
                await refreshState();
                if (!successor) {
                    // Signin was the last step → flow is done.
                    window.location.href = "ready-hub.html";
                    return;
                }
                const nextIdx = steps.indexOf(successor);
                if (nextIdx >= 0) renderIndex(nextIdx);
                else window.location.href = "ready-hub.html";
            });
        }

        // Audio toggle
        const audioBtn = document.getElementById("audio-toggle");
        if (audioBtn) {
            audioBtn.addEventListener("click", function () {
                const next = !((state.personalize && state.personalize.audio && state.personalize.audio.enabled) || false);
                if (bhai.setupSavePersonalize) {
                    bhai.setupSavePersonalize({
                        audio: { enabled: next },
                    }).catch(function () { /* best-effort */ });
                }
                if (window.WizardAudio && window.WizardAudio.setEnabled) window.WizardAudio.setEnabled(next);
                audioBtn.style.color = next ? "var(--ink-0)" : "";
            });
        }

        renderIndex(0);
    }

    if (typeof window !== "undefined") {
        window.__WizardBoot = {
            clearChildren: clearChildren,
            renderIndicator: renderIndicator,
            setFolio: setFolio,
            applyTheme: applyTheme,
            decideInitialRoute: decideInitialRoute,
        };
    }

    if (typeof document !== "undefined" && document.getElementById && document.getElementById("step-root")) {
        boot();
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            clearChildren: clearChildren,
            renderIndicator: renderIndicator,
            setFolio: setFolio,
            applyTheme: applyTheme,
            decideInitialRoute: decideInitialRoute,
        };
    }
})();
