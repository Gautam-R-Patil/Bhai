// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Vision-tier wizard step.
// Shows three cards (Lite / Standard / Full), auto-selects the highest the
// system supports, and greys out any card the hardware can't run with a clear
// "this Mac doesn't have enough RAM" hint. Selected tier is stored in
// wizard state and drives optional install phases in installer/phases.js.
(function () {
    "use strict";

    const TIERS = [
        {
            id: "lite",
            title: "Lite",
            tagline: "Works everywhere",
            size: "0 MB",
            capability: "Finds buttons & menus by name in native apps (Safari, Mail, Finder, etc).",
            requirements: { ramGB: 0, gpu: "none", diskGB: 0 },
        },
        {
            id: "standard",
            title: "Standard",
            tagline: "Plus visual elements",
            size: "~500 MB",
            capability: "Adds vision-based element detection so A.T.L.A.S can also click things in apps that hide their UI (some Electron apps, in-game menus).",
            requirements: { ramGB: 8, gpu: "any", diskGB: 1 },
        },
        {
            id: "full",
            title: "Full",
            tagline: "Plus canvas apps",
            size: "~4.5 GB",
            capability: "Adds local 7B-param grounding model — clicks in Figma, Photoshop, Discord and other canvas-only UIs. Runs entirely on your Mac.",
            requirements: { ramGB: 12, gpu: "apple-silicon or discrete", diskGB: 6 },
        },
    ];

    function canRunTier(tier, detected) {
        if (!detected) return true;
        const req = tier.requirements;
        if (detected.ramGB && detected.ramGB < req.ramGB) return false;
        if (tier.id === "full") {
            // Full needs apple-silicon OR (Win/Linux with enough RAM)
            if (detected.gpuClass === "none") return false;
        }
        return true;
    }

    function whyUnavailable(tier, detected) {
        const req = tier.requirements;
        const parts = [];
        if (detected && detected.ramGB && detected.ramGB < req.ramGB) {
            parts.push(`needs ${req.ramGB}+ GB RAM (you have ${detected.ramGB} GB)`);
        }
        if (tier.id === "full" && detected && detected.gpuClass === "none") {
            parts.push("needs Apple-silicon or a discrete GPU");
        }
        return parts.length ? parts.join(", ") : "system doesn't meet requirements";
    }

    function render(root, ctx) {
        const state = (ctx && ctx.state) || {};
        const detected = state.visionTier || { max: "lite", ramGB: 0, gpuClass: "unknown" };
        const installed = state.visionDeps || { ollama: false, uiTarsModel: false, omniparser: false };

        const section = document.createElement("section");
        section.className = "step step-vision-tier";

        const title = document.createElement("h2");
        title.className = "step-title";
        title.textContent = "Vision intelligence";
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = "How A.T.L.A.S sees your screen. We picked the best option for your Mac — you can switch anytime.";
        section.appendChild(sub);

        const grid = document.createElement("div");
        grid.className = "tier-grid";
        section.appendChild(grid);

        // Pre-select the highest tier the system supports (= auto-detect default).
        // User can override but defaults guide the non-techy.
        let selectedId = state.visionTierChoice || detected.max || "lite";
        // Defensive — if persisted choice is unsupported, fall back to max supported.
        if (!canRunTier(TIERS.find((t) => t.id === selectedId), detected)) {
            selectedId = detected.max;
        }

        const cards = {};
        for (const tier of TIERS) {
            const canRun = canRunTier(tier, detected);
            const card = document.createElement("div");
            card.className = "tier-card" + (canRun ? "" : " tier-card--disabled");
            card.setAttribute("data-tier", tier.id);
            card.setAttribute("role", "radio");
            card.setAttribute("aria-checked", selectedId === tier.id ? "true" : "false");
            card.setAttribute("tabindex", canRun ? "0" : "-1");

            const head = document.createElement("div");
            head.className = "tier-card__head";

            const radio = document.createElement("span");
            radio.className = "tier-card__radio";
            head.appendChild(radio);

            const titleWrap = document.createElement("div");
            titleWrap.className = "tier-card__title-wrap";
            const titleEl = document.createElement("div");
            titleEl.className = "tier-card__title";
            titleEl.textContent = tier.title;
            const taglineEl = document.createElement("div");
            taglineEl.className = "tier-card__tagline";
            taglineEl.textContent = tier.tagline;
            titleWrap.appendChild(titleEl);
            titleWrap.appendChild(taglineEl);
            head.appendChild(titleWrap);

            const sizeEl = document.createElement("span");
            sizeEl.className = "tier-card__size";
            sizeEl.textContent = tier.size;
            head.appendChild(sizeEl);

            card.appendChild(head);

            const body = document.createElement("p");
            body.className = "tier-card__body";
            body.textContent = tier.capability;
            card.appendChild(body);

            // "Already installed" badge or "Not available" hint
            const footer = document.createElement("div");
            footer.className = "tier-card__footer";
            // Full needs ALL three (omniparser + ollama + uiTarsModel).
            // Standard needs omniparser. Lite needs nothing.
            const fullInstalled = installed.ollama && installed.uiTarsModel && installed.omniparser;
            const standardInstalled = installed.omniparser;
            // For Full tier with PARTIAL install, show the residual size so the
            // user understands what's actually queued — not the worst-case 4.5 GB.
            const visionModelReady = installed.ollama && installed.uiTarsModel;
            if (!canRun) {
                footer.textContent = "✕ This Mac is not capable for this option — " + whyUnavailable(tier, detected);
                footer.className += " tier-card__footer--unavailable";
            } else if (tier.id === "full" && fullInstalled) {
                footer.textContent = "✓ Already installed";
                footer.className += " tier-card__footer--installed";
            } else if (tier.id === "full" && visionModelReady && !installed.omniparser) {
                footer.textContent = "Will download ~500 MB (vision deps only — model already present)";
                footer.className += " tier-card__footer--neutral";
            } else if (tier.id === "full" && installed.omniparser && !visionModelReady) {
                footer.textContent = "Will download ~4.5 GB (model + runtime — deps already present)";
                footer.className += " tier-card__footer--neutral";
            } else if (tier.id === "standard" && standardInstalled) {
                footer.textContent = "✓ Already installed";
                footer.className += " tier-card__footer--installed";
            } else if (tier.id === "lite") {
                footer.textContent = "✓ Always available";
                footer.className += " tier-card__footer--installed";
            } else {
                footer.textContent = "Will download " + tier.size;
                footer.className += " tier-card__footer--neutral";
            }
            card.appendChild(footer);

            if (canRun) {
                card.addEventListener("click", function () {
                    selectedId = tier.id;
                    for (const id of Object.keys(cards)) {
                        const c = cards[id];
                        if (id === selectedId) {
                            c.classList.add("tier-card--selected");
                            c.setAttribute("aria-checked", "true");
                        } else {
                            c.classList.remove("tier-card--selected");
                            c.setAttribute("aria-checked", "false");
                        }
                    }
                });
                card.addEventListener("keydown", function (e) {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        card.click();
                    }
                });
            }

            if (canRun && selectedId === tier.id) card.classList.add("tier-card--selected");

            cards[tier.id] = card;
            grid.appendChild(card);
        }

        // Detection summary (small grey line below the grid)
        const detSummary = document.createElement("p");
        detSummary.className = "tier-detection-summary";
        detSummary.textContent =
            "Detected: " + detected.ramGB + " GB RAM" +
            (detected.gpuClass === "apple-silicon" ? " + Apple silicon" :
                detected.gpuClass === "none" ? " (no discrete GPU)" : "");
        section.appendChild(detSummary);

        // Actions
        const actions = document.createElement("div");
        actions.className = "step-actions";
        const back = document.createElement("button");
        back.id = "vt-back"; back.type = "button"; back.className = "btn-ghost"; back.textContent = "Back";
        const next = document.createElement("button");
        next.id = "vt-next"; next.type = "button"; next.className = "btn-primary";
        next.textContent = "Continue";
        actions.appendChild(back);
        actions.appendChild(next);
        section.appendChild(actions);

        const errEl = document.createElement("p");
        errEl.className = "step-error";
        errEl.id = "vt-err";
        section.appendChild(errEl);

        root.appendChild(section);

        back.addEventListener("click", function () {
            if (ctx && typeof ctx.onBack === "function") ctx.onBack();
        });

        next.addEventListener("click", async function () {
            next.disabled = true;
            errEl.textContent = "";
            const atlas = window.atlas || {};
            if (typeof atlas.setupSaveVisionTier === "function") {
                try {
                    await atlas.setupSaveVisionTier({ tier: selectedId });
                } catch (e) {
                    errEl.textContent = "Could not save selection: " + (e.message || e);
                    next.disabled = false;
                    return;
                }
            }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps["vision-tier"] = { render: render };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render, TIERS: TIERS, canRunTier: canRunTier };
    }
})();
