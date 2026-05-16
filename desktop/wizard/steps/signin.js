// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Sign-in step: single OTPless CTA. Tapping opens the OTPless popup
// (atlas.openAuthWindow). The wizard advances automatically once
// account.signedIn flips true (handled by boot.js refreshState).
(function () {
    "use strict";

    function svgArrow() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';
    }

    function svgGlyph() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    }

    function render(root, ctx) {
        const Copy = window.Copy;
        const section = document.createElement("section");
        section.className = "step step-signin";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + (Copy.get("signin", "eyebrow") || "Identity");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = Copy.get("signin", "title") || "Make this yours.";
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = Copy.get("signin", "sub")
            || "One tap to sync preferences and credits across your devices. No password to remember.";
        section.appendChild(sub);

        const pane = document.createElement("div");
        pane.className = "signin-pane";

        const glyph = document.createElement("div");
        glyph.className = "signin-glyph";
        glyph.innerHTML = svgGlyph();
        pane.appendChild(glyph);

        const cta = document.createElement("button");
        cta.type = "button";
        cta.className = "btn btn-primary signin-cta";
        cta.innerHTML = 'Continue to login <span class="chev">' + svgArrow() + '</span>';
        cta.addEventListener("click", function () {
            if (window.atlas && typeof window.atlas.openAuthWindow === "function") {
                window.atlas.openAuthWindow();
            }
            // OTPless popup completes asynchronously; setup:account-status-change
            // fires refreshState in boot.js which will advance once signed in.
        });
        pane.appendChild(cta);

        const fineprint = document.createElement("p");
        fineprint.className = "signin-fineprint";
        fineprint.textContent = Copy.get("signin", "fineprint") || "You can sign in later from Settings.";
        pane.appendChild(fineprint);

        section.appendChild(pane);

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const back = document.createElement("button");
        back.type = "button";
        back.className = "btn btn-text";
        back.textContent = "Back";
        back.addEventListener("click", function () { if (ctx && typeof ctx.onBack === "function") ctx.onBack(); });
        actions.appendChild(back);
        section.appendChild(actions);

        root.appendChild(section);
    }

    if (typeof window !== "undefined") {
        window.WizardSteps = window.WizardSteps || {};
        window.WizardSteps.signin = { render: render };
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render };
    }
})();
