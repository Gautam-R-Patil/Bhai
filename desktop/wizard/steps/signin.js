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
        // The terms clickwrap sits on this screen: sign-in unlocks once accepted.
        const R = window.WizardRouter;
        const termsApi = window.WizardSteps && window.WizardSteps.terms;
        const needTerms = !!(R && R.needsTerms && termsApi && R.needsTerms((ctx && ctx.state) || {}));
        if (needTerms) {
            cta.disabled = true;
            // One heading at a time: the terms first, then the sign-in pitch.
            [eyebrow, title, sub].forEach(function (n) { n.hidden = true; });
            const termsHost = document.createElement("div");
            termsHost.className = "signin-terms";
            section.appendChild(termsHost);
            termsApi.render(termsHost, {
                state: ctx && ctx.state,
                refreshState: ctx && ctx.refreshState,
                // Accepting doesn't leave the screen: it unlocks sign-in.
                onAdvance: function () {
                    termsHost.remove();
                    [eyebrow, title, sub].forEach(function (n) { n.hidden = false; });
                    cta.disabled = false;
                    cta.focus();
                },
            });
        }
        cta.innerHTML = 'Continue to login <span class="chev">' + svgArrow() + '</span>';
        // Shown while the sign-in window is open, so the user knows where to look.
        const waiting = document.createElement("p");
        waiting.className = "signin-fineprint";
        waiting.setAttribute("role", "status");
        waiting.setAttribute("aria-live", "polite");

        cta.addEventListener("click", async function () {
            if (!(window.atlas && typeof window.atlas.openAuthWindow === "function")) return;
            let res = null;
            try { res = await window.atlas.openAuthWindow(); } catch (_) { /* shown below */ }
            if (res && res.alreadySignedIn) {
                // Already signed in (e.g. re-running setup): just move on.
                if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
                return;
            }
            if (!res || res.success === false) {
                waiting.textContent = "Couldn't open the sign-in window. Please try again.";
                return;
            }
            // OTPless completes asynchronously; setup:account-status-change
            // fires refreshState in boot.js, which advances once signed in.
            waiting.textContent = "Finish signing in in the window that just opened. Closed it by mistake? Tap the button again.";
            cta.innerHTML = 'Open sign-in again <span class="chev">' + svgArrow() + '</span>';
        });
        pane.appendChild(cta);
        pane.appendChild(waiting);

        const fineprint = document.createElement("p");
        fineprint.className = "signin-fineprint";
        fineprint.textContent = Copy.get("signin", "fineprint") || "Sign in to finish setup and unlock your credits.";
        pane.appendChild(fineprint);

        section.appendChild(pane);

        // No "Back" button: signin sits AFTER install in the flow, so Back would
        // return to an already-completed install step, which auto-advances right
        // back here (a dead, flashing affordance). Signin is a required gate —
        // forward progress is via the login CTA + the async account-status-change
        // auto-advance in boot.js.

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
