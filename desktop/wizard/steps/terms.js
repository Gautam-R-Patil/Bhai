// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";

    const TERMS_HTML = `
        <h4>Terms of service</h4>
        <p>A.T.L.A.S is a personal AI agent that acts on your behalf across the channels you connect. By accepting, you authorize the agent to read, write, and execute within the scopes you grant.</p>
        <h4>Privacy</h4>
        <p>Memory and conversation history are stored locally on this device. Telemetry is anonymized and aggregated.</p>
        <h4>Acceptable use</h4>
        <p>You agree not to use A.T.L.A.S for activities that violate applicable law or the rights of others.</p>
        <h4>Disclaimer</h4>
        <p>A.T.L.A.S is software and can make mistakes. You retain responsibility for actions it takes on your behalf.</p>
        <h4>Refund</h4>
        <p>Subscriptions are refundable within 7 days of purchase, no questions asked.</p>
    `;

    function render(root, ctx) {
        const Copy = window.Copy;
        const section = document.createElement("section");
        section.className = "step step-terms";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + Copy.get("terms", "eyebrow");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = Copy.get("terms", "title");
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = Copy.get("terms", "sub");
        section.appendChild(sub);

        const doc = document.createElement("div");
        doc.className = "terms-doc";
        doc.innerHTML = TERMS_HTML;
        section.appendChild(doc);

        const checks = document.createElement("div");
        checks.className = "terms-checks";
        const keys = ["check1", "check2", "check3", "check4", "check5"];
        const inputs = keys.map(function (k) {
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "checkbox";
            cb.checked = true;
            const span = document.createElement("span");
            span.textContent = Copy.get("terms", k);
            const row = document.createElement("label");
            row.className = "check-row";
            row.appendChild(cb);
            row.appendChild(span);
            checks.appendChild(row);
            return cb;
        });
        section.appendChild(checks);

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const grow = document.createElement("div");
        grow.className = "grow";
        const cta = document.createElement("button");
        cta.type = "button";
        cta.className = "btn btn-primary";
        cta.innerHTML = Copy.get("terms", "accept") + ' <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg></span>';
        cta.addEventListener("click", async function () {
            if (!inputs.every(function (i) { return i.checked; })) return;
            if (window.atlas && typeof window.atlas.setupSaveTermsAcceptance === "function") {
                try { await window.atlas.setupSaveTermsAcceptance({ accepted: true, version: window.WizardRouter.CURRENT_ACCEPTANCE_VERSION }); }
                catch (_) { /* best-effort */ }
            }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
        actions.appendChild(grow);
        actions.appendChild(cta);
        section.appendChild(actions);

        root.appendChild(section);
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.terms = { render: render };
    if (typeof module !== "undefined" && module.exports) module.exports = { render: render };
})();
