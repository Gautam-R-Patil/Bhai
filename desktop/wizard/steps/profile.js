// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";
    const ALLOWED_TONES = ["friendly", "professional", "playful"];

    function labeledField(labelText, controlEl) {
        const label = document.createElement("label");
        label.className = "field";
        const span = document.createElement("span");
        span.textContent = labelText;
        label.appendChild(span);
        label.appendChild(controlEl);
        return label;
    }

    function render(root, ctx) {
        const existingProfile = (ctx && ctx.state && ctx.state.profile) || {};
        const defaultName = existingProfile.name || (ctx && ctx.state && ctx.state.osUserName) || "";
        const defaultTone = existingProfile.tone || "friendly";

        const section = document.createElement("section");
        section.className = "step step-profile";

        const title = document.createElement("h2");
        title.className = "step-title";
        title.textContent = "Your name & tone";
        section.appendChild(title);

        const nameInput = document.createElement("input");
        nameInput.id = "prof-name";
        nameInput.type = "text";
        nameInput.maxLength = 64;
        nameInput.placeholder = "e.g. Dheeraj";
        nameInput.value = defaultName;
        section.appendChild(labeledField("Name", nameInput));

        const toneSelect = document.createElement("select");
        toneSelect.id = "prof-tone";
        ALLOWED_TONES.forEach(function (t) {
            const opt = document.createElement("option");
            opt.value = t;
            opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
            toneSelect.appendChild(opt);
        });
        toneSelect.value = ALLOWED_TONES.indexOf(defaultTone) >= 0 ? defaultTone : "friendly";
        section.appendChild(labeledField("Tone", toneSelect));

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const back = document.createElement("button");
        back.id = "prof-back"; back.type = "button"; back.className = "btn-ghost"; back.textContent = "Back";
        const next = document.createElement("button");
        next.id = "prof-next"; next.type = "button"; next.className = "btn-primary"; next.textContent = "Continue";
        actions.appendChild(back);
        actions.appendChild(next);
        section.appendChild(actions);

        const err = document.createElement("p");
        err.id = "prof-err"; err.className = "step-error"; err.setAttribute("aria-live", "polite");
        section.appendChild(err);

        root.appendChild(section);

        back.addEventListener("click", function () {
            if (ctx && typeof ctx.onBack === "function") ctx.onBack();
        });

        next.addEventListener("click", async function () {
            const n = nameInput.value.trim();
            const t = toneSelect.value;
            if (!n) { err.textContent = "Please enter a name."; return; }
            err.textContent = "";
            if (!window.atlas || typeof window.atlas.saveProfile !== "function") {
                err.textContent = "Save unavailable (IPC not ready).";
                return;
            }
            let res;
            try { res = await window.atlas.saveProfile({ name: n, tone: t }); }
            catch (e) { err.textContent = "Save failed: " + (e.message || e); return; }
            if (!res || !res.success) {
                err.textContent = (res && res.error) || "Save failed.";
                return;
            }
            // E3d-2: if reconfiguring (bot may already be running), bounce it so the
            // running bot picks up the new name/tone via src/setup/wizard-seed.ts on
            // its next boot. No-op on fresh install (bot not started yet). Best-effort:
            // a reseed failure doesn't block the user from advancing.
            if (ctx && ctx.state && ctx.state.isReconfigure && window.atlas && typeof window.atlas.setupReseedNow === "function") {
                try { await window.atlas.setupReseedNow(); }
                catch { /* next bot restart will still pick it up */ }
            }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.profile = { render: render };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render };
    }
})();
