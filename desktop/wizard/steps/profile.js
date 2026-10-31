// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";

    function render(root, ctx) {
        const Copy = window.Copy;
        const existingProfile = (ctx && ctx.state && ctx.state.profile) || {};
        const defaultName = existingProfile.name || (ctx && ctx.state && ctx.state.osUserName) || "";

        const section = document.createElement("section");
        section.className = "step step-profile";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + Copy.get("profile", "eyebrow");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = Copy.get("profile", "title");
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = Copy.get("profile", "sub");
        section.appendChild(sub);

        const field = document.createElement("div");
        field.className = "field";
        const lbl = document.createElement("span");
        lbl.className = "field-label";
        lbl.textContent = Copy.get("profile", "label");
        const input = document.createElement("input");
        input.id = "prof-name";
        input.type = "text";
        input.maxLength = 64;
        input.placeholder = Copy.get("profile", "placeholder");
        input.value = defaultName;
        field.appendChild(lbl);
        field.appendChild(input);
        section.appendChild(field);

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const back = document.createElement("button");
        back.type = "button";
        back.className = "btn btn-text";
        back.textContent = "Back";
        back.addEventListener("click", function () { if (ctx && typeof ctx.onBack === "function") ctx.onBack(); });
        const grow = document.createElement("div");
        grow.className = "grow";
        const cta = document.createElement("button");
        cta.type = "button";
        cta.className = "btn btn-primary";
        cta.innerHTML = 'Continue <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg></span>';
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
            const n = input.value.trim();
            if (!n) { err.textContent = "Please enter a name."; return; }
            err.textContent = "";
            if (!window.bhai || typeof window.bhai.saveProfile !== "function") {
                err.textContent = "Save unavailable (IPC not ready).";
                return;
            }
            // Tone is preserved untouched in W1 (the existing profile.tone stays
            // whatever the user previously selected, or default "friendly"). W2
            // replaces this with the persona step.
            const tone = existingProfile.tone || "friendly";
            let res;
            try { res = await window.bhai.saveProfile({ name: n, tone: tone }); }
            catch (e) { err.textContent = "Save failed: " + (e.message || e); return; }
            if (!res || !res.success) {
                err.textContent = (res && res.error) || "Save failed.";
                return;
            }
            if (ctx && ctx.state && ctx.state.isReconfigure && window.bhai && typeof window.bhai.setupReseedNow === "function") {
                try { await window.bhai.setupReseedNow(); } catch { /* next bot restart picks up */ }
            }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.profile = { render: render };
    if (typeof module !== "undefined" && module.exports) module.exports = { render: render };
})();
