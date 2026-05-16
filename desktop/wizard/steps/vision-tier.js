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
            size: "0 MB",
            requirements: { ramGB: 0, gpu: "none", diskGB: 0 },
        },
        {
            id: "standard",
            size: "~500 MB",
            requirements: { ramGB: 8, gpu: "any", diskGB: 1 },
        },
        {
            id: "full",
            size: "~4.5 GB",
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
            parts.push("needs " + req.ramGB + "+ GB RAM (you have " + detected.ramGB + " GB)");
        }
        if (tier.id === "full" && detected && detected.gpuClass === "none") {
            parts.push("needs Apple-silicon or a discrete GPU");
        }
        return parts.length ? parts.join(", ") : "system doesn't meet requirements";
    }

    function render(root, ctx) {
        const Copy = window.Copy;
        const state = (ctx && ctx.state) || {};
        const detected = state.visionTier || { max: "lite", ramGB: 0, gpuClass: "unknown" };

        const section = document.createElement("section");
        section.className = "step step-vision-tier";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + Copy.get("vision-tier", "eyebrow");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = Copy.get("vision-tier", "title");
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = Copy.get("vision-tier", "sub");
        section.appendChild(sub);

        const list = document.createElement("div");
        list.className = "tier-list";
        section.appendChild(list);

        // Pre-select the highest tier the system supports (= auto-detect default).
        let selectedId = state.visionTierChoice || detected.max || "lite";
        if (!canRunTier(TIERS.find(function (t) { return t.id === selectedId; }), detected)) {
            selectedId = detected.max;
        }

        const cards = {};
        for (const tier of TIERS) {
            const canRun = canRunTier(tier, detected);
            const card = document.createElement("div");
            card.className = "tier" + (selectedId === tier.id ? " active" : "") + (canRun ? "" : " disabled");
            card.setAttribute("data-tier", tier.id);
            card.setAttribute("role", "radio");
            card.setAttribute("aria-checked", selectedId === tier.id ? "true" : "false");
            card.setAttribute("tabindex", canRun ? "0" : "-1");

            const radio = document.createElement("div");
            radio.className = "tier-radio";
            card.appendChild(radio);

            const body = document.createElement("div");
            body.className = "tier-body";

            const head = document.createElement("div");
            head.className = "tier-head";
            const name = document.createElement("h3");
            name.className = "tier-name";
            name.textContent = Copy.get("vision-tier", "tier_" + tier.id + "_name");
            const tag = document.createElement("span");
            tag.className = "tier-tag";
            tag.textContent = Copy.get("vision-tier", "tier_" + tier.id + "_tag");
            head.appendChild(name);
            head.appendChild(tag);
            body.appendChild(head);

            const desc = document.createElement("p");
            desc.className = "tier-desc";
            if (canRun) {
                desc.textContent = Copy.get("vision-tier", "tier_" + tier.id + "_desc");
            } else {
                desc.textContent = "Not available — " + whyUnavailable(tier, detected);
            }
            body.appendChild(desc);

            card.appendChild(body);

            const sizeEl = document.createElement("span");
            sizeEl.className = "tier-size";
            sizeEl.textContent = tier.size;
            card.appendChild(sizeEl);

            if (canRun) {
                card.addEventListener("click", function () {
                    selectedId = tier.id;
                    for (const id of Object.keys(cards)) {
                        const c = cards[id];
                        if (id === selectedId) {
                            c.classList.add("active");
                            c.setAttribute("aria-checked", "true");
                        } else {
                            c.classList.remove("active");
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

            cards[tier.id] = card;
            list.appendChild(card);
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
        back.id = "vt-back"; back.type = "button"; back.className = "btn btn-text"; back.textContent = "Back";
        const grow = document.createElement("div"); grow.className = "grow";
        const next = document.createElement("button");
        next.id = "vt-next"; next.type = "button"; next.className = "btn btn-primary";
        next.innerHTML = 'Continue <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg></span>';
        actions.appendChild(back);
        actions.appendChild(grow);
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
