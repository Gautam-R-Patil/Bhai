// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";

    function svgEmail() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 6 10-6"/></svg>';
    }
    function svgPhone() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg>';
    }
    function svgPerson() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    }

    function render(root, ctx) {
        const Copy = window.Copy;
        const section = document.createElement("section");
        section.className = "step step-signin";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + Copy.get("signin", "eyebrow");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = Copy.get("signin", "title");
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = Copy.get("signin", "sub");
        section.appendChild(sub);

        const pane = document.createElement("div");
        pane.className = "signin-pane";

        const glyph = document.createElement("div");
        glyph.className = "signin-glyph";
        glyph.innerHTML = svgPerson();
        pane.appendChild(glyph);

        const options = document.createElement("div");
        options.className = "signin-options";

        function openAuthAndAdvance() {
            if (window.atlas && typeof window.atlas.openAuthWindow === "function") {
                window.atlas.openAuthWindow();
            }
            // The OTPless flow lives in a popup; user returns to the wizard via
            // setup:account-status-change → boot.js refreshState. Don't auto-advance —
            // the router will redirect on next render once account.signedIn is true.
        }

        const emailBtn = document.createElement("button");
        emailBtn.className = "signin-option";
        emailBtn.innerHTML = svgEmail() + '<span>' + Copy.get("signin", "email_cta") + '</span>';
        emailBtn.addEventListener("click", openAuthAndAdvance);
        options.appendChild(emailBtn);

        const phoneBtn = document.createElement("button");
        phoneBtn.className = "signin-option";
        phoneBtn.innerHTML = svgPhone() + '<span>' + Copy.get("signin", "phone_cta") + '</span>';
        phoneBtn.addEventListener("click", openAuthAndAdvance);
        options.appendChild(phoneBtn);

        pane.appendChild(options);

        const fineprint = document.createElement("p");
        fineprint.className = "signin-fineprint";
        fineprint.textContent = Copy.get("signin", "fineprint");
        pane.appendChild(fineprint);

        section.appendChild(pane);

        // Back-only action row — the email/phone buttons ARE the primary action.
        // No "skip" CTA: the wizard advances automatically once OTPless completes,
        // and the fineprint covers the "I'll sign in later" case.
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

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.signin = { render: render };
    if (typeof module !== "undefined" && module.exports) module.exports = { render: render };
})();
