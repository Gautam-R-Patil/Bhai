// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Persona step — five cards in a 2×3 grid (explorer spans both columns
// at the bottom). Selecting a card writes profile.persona via
// bhai.saveProfile. Tone defaults to professional or friendly per
// persona, but only if the user hasn't explicitly set tone in
// Personalize → Personality (preserved in profile.tone if present).
(function () {
    "use strict";

    /* Persona definitions — IDs match the canonical Persona type in
       src/prompts/persona-bias.ts. Add a new persona here AND in
       persona-bias.ts (identity line + weight map). */
    const PERSONAS = ["developer", "founder", "creator", "researcher", "explorer"];

    /* Tone defaults — developer/founder/researcher feel professional;
       creator/explorer feel friendly. Used only when profile.tone isn't
       already set by the Personalize → Personality step. */
    const TONE_DEFAULTS = {
        developer:  "professional",
        founder:    "professional",
        researcher: "professional",
        creator:    "friendly",
        explorer:   "friendly",
    };

    function svgChev() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg>';
    }

    function buildCard(personaId, isSelected) {
        const Copy = window.Copy;
        const wrap = document.createElement("button");
        wrap.type = "button";
        // Class names mirror the existing CSS in desktop/styles.css —
        // `.persona-card`, `.persona-title`, `.persona-desc`, `.persona-caps`,
        // and the `.explorer` variant (which makes the card span 2 cols
        // at the bottom of the 2×3 grid).
        wrap.className = "persona-card" + (isSelected ? " active" : "")
                       + (personaId === "explorer" ? " explorer" : "");
        wrap.setAttribute("data-persona-id", personaId);

        const title = document.createElement("h3");
        title.className = "persona-title";
        title.textContent = Copy.get("persona", personaId + "_title") || personaId;
        wrap.appendChild(title);

        const desc = document.createElement("p");
        desc.className = "persona-desc";
        desc.textContent = Copy.get("persona", personaId + "_desc") || "";
        wrap.appendChild(desc);

        const caps = document.createElement("ul");
        caps.className = "persona-caps";
        for (let i = 1; i <= 3; i++) {
            const li = document.createElement("li");
            li.textContent = Copy.get("persona", personaId + "_cap_" + i) || "";
            caps.appendChild(li);
        }
        wrap.appendChild(caps);

        return wrap;
    }

    function render(root, ctx) {
        const Copy = window.Copy;
        const state = (ctx && ctx.state) || {};
        const profile = state.profile || {};
        const currentPersona = profile.persona || null;

        const section = document.createElement("section");
        section.className = "step step-persona";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + (Copy.get("persona", "eyebrow") || "How you work");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = Copy.get("persona", "title") || "Pick a starting shape.";
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = Copy.get("persona", "sub") || "";
        section.appendChild(sub);

        // Grid of cards. State lives in `selected`. Click handlers rerender
        // by toggling active class — no full re-render needed since the
        // grid structure is fixed.
        let selected = currentPersona;
        const grid = document.createElement("div");
        grid.className = "persona-grid";

        const cardEls = {};
        for (const pid of PERSONAS) {
            const card = buildCard(pid, selected === pid);
            card.addEventListener("click", function () {
                if (selected === pid) return;
                // Clear previous active
                if (selected && cardEls[selected]) cardEls[selected].classList.remove("active");
                selected = pid;
                card.classList.add("active");
                cta.disabled = false;
            });
            cardEls[pid] = card;
            grid.appendChild(card);
        }
        section.appendChild(grid);

        // Action row
        const actions = document.createElement("div");
        actions.className = "step-actions";
        const back = document.createElement("button");
        back.type = "button";
        back.className = "btn btn-text";
        back.textContent = "Back";
        back.addEventListener("click", function () {
            if (ctx && typeof ctx.onBack === "function") ctx.onBack();
        });
        const grow = document.createElement("div");
        grow.className = "grow";
        const cta = document.createElement("button");
        cta.type = "button";
        cta.className = "btn btn-primary";
        cta.innerHTML = 'Continue <span class="chev">' + svgChev() + '</span>';
        cta.disabled = !selected;
        actions.appendChild(back);
        actions.appendChild(grow);
        actions.appendChild(cta);
        section.appendChild(actions);

        const err = document.createElement("p");
        err.className = "step-error";
        err.setAttribute("aria-live", "polite");
        section.appendChild(err);

        root.appendChild(section);

        cta.addEventListener("click", async function () {
            if (!selected) return;
            cta.disabled = true;
            err.textContent = "";

            const existingTone = profile.tone;
            const tone = existingTone || TONE_DEFAULTS[selected] || "friendly";
            const existingName = profile.name || "";

            if (!window.bhai || typeof window.bhai.saveProfile !== "function") {
                err.textContent = "Save unavailable (IPC not ready).";
                cta.disabled = false;
                return;
            }

            const payload = {
                name: existingName,
                tone: tone,
                persona: selected,
                personaConfidence: 1.0,
                personaSelectedAt: Date.now(),
            };

            let res;
            try { res = await window.bhai.saveProfile(payload); }
            catch (e) { err.textContent = "Save failed: " + (e.message || e); cta.disabled = false; return; }
            if (!res || !res.success) {
                err.textContent = (res && res.error) || "Save failed.";
                cta.disabled = false;
                return;
            }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
    }

    if (typeof window !== "undefined") {
        window.WizardSteps = window.WizardSteps || {};
        window.WizardSteps.persona = { render: render };
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render, _internals: { PERSONAS: PERSONAS, TONE_DEFAULTS: TONE_DEFAULTS, buildCard: buildCard } };
    }
})();
