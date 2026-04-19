// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";
    function render(root, ctx) {
        const section = document.createElement("section");
        section.className = "step step-signin";

        const title = document.createElement("h2");
        title.className = "step-title";
        title.textContent = "Sign in";

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = "Signing in activates credits and personal memory.";

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const btn = document.createElement("button");
        btn.id = "signin-btn";
        btn.type = "button";
        btn.className = "btn-primary";
        btn.textContent = "Sign in with OTPless";
        actions.appendChild(btn);

        const status = document.createElement("p");
        status.id = "signin-status";
        status.className = "step-note";
        status.setAttribute("aria-live", "polite");

        section.appendChild(title);
        section.appendChild(sub);
        section.appendChild(actions);
        section.appendChild(status);
        root.appendChild(section);

        let unlocked = false;
        btn.addEventListener("click", async function () {
            btn.disabled = true;
            status.textContent = "Opening secure sign-in…";
            try {
                if (window.atlas && typeof window.atlas.openAuthWindow === "function") {
                    await window.atlas.openAuthWindow();
                }
            } catch (err) {
                status.textContent = "Could not open auth window: " + (err.message || err);
                btn.disabled = false;
            }
        });

        if (window.atlas && typeof window.atlas.onAccountStatusChange === "function") {
            window.atlas.onAccountStatusChange(async function (d) {
                if (unlocked || !(d && d.signedIn)) return;
                unlocked = true;
                status.textContent = "Signed in ✓";
                if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
                if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
            });
        }
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.signin = { render: render };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render };
    }
})();
