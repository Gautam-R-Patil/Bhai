// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
(function () {
    "use strict";

    function render(root, ctx) {
        const re = !!(ctx && ctx.state && ctx.state.isReconfigure);
        const section = document.createElement("section");
        section.className = "step step-welcome";

        // Welcome is a placeholder until W1 Task 12 inserts the awakening step.
        // After that, welcome is only shown on Reconfigure flows.
        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + (re ? "Reconfigure" : "Welcome");

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = re ? "Reconfigure Bhai." : "Welcome to Bhai.";

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = re
            ? "Your current configuration will be preserved. Walk through to change anything."
            : "A proactive, personal AI agent. Setup takes under two minutes.";

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const cta = document.createElement("button");
        cta.id = "welcome-cta";
        cta.type = "button";
        cta.className = "btn btn-primary";
        cta.innerHTML = 'Begin <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg></span>';
        cta.addEventListener("click", function () {
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
        const grow = document.createElement("div");
        grow.className = "grow";
        actions.appendChild(grow);
        actions.appendChild(cta);

        section.appendChild(eyebrow);
        section.appendChild(title);
        section.appendChild(sub);
        section.appendChild(actions);
        root.appendChild(section);
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.welcome = { render: render };
    if (typeof module !== "undefined" && module.exports) module.exports = { render: render };
})();
