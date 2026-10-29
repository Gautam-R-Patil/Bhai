// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Tiny renderer helper: ambient cinematic effects across the wizard.
// Browser: attaches to window.Cinematic. Tests: CommonJS require/import.
//
// Wrapped in an IIFE so the local `const api` doesn't collide with the
// identically-named globals in other top-level wizard modules (chips.js,
// copy.js) when this file is loaded as a classic <script>.
(function () {
    "use strict";

    function scribeRule() {
        const r = document.getElementById("iridescent-rule");
        if (!r) return;
        r.classList.remove("scribe");
        // Force a layout flush so the next class-add re-plays the animation
        // (CSS keyframes don't re-trigger when the class is already present).
        void r.offsetWidth;
        r.classList.add("scribe");
    }

    // W1: no-op. The iridescent rule is the single "alive" signal; we don't
    // also ramp orb-speed/accent-alpha. The signature is preserved so future
    // waves can wire it up without touching call sites.
    function applyConfidence(_stepIndex, _totalSteps) {
        /* intentionally empty in W1 */
    }

    const api = { scribeRule: scribeRule, applyConfidence: applyConfidence };
    if (typeof window !== "undefined") window.Cinematic = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
