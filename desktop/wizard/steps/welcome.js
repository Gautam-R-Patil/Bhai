// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";
    function render(root, ctx) {
        const re = !!(ctx && ctx.state && ctx.state.isReconfigure);
        const section = document.createElement("section");
        section.className = "step step-welcome";

        const title = document.createElement("h2");
        title.className = "step-title";
        title.textContent = re ? "Reconfigure A.T.L.A.S" : "Welcome to A.T.L.A.S";

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = re
            ? "Your current config will be preserved. Walk through to change anything."
            : "A calm, proactive personal AI. Setup takes under two minutes.";

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const cta = document.createElement("button");
        cta.id = "welcome-cta";
        cta.type = "button";
        cta.className = "btn-primary";
        cta.textContent = "Get Started";
        cta.addEventListener("click", function () {
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
        actions.appendChild(cta);

        section.appendChild(title);
        section.appendChild(sub);
        section.appendChild(actions);
        root.appendChild(section);
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.welcome = { render: render };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render };
    }
})();
