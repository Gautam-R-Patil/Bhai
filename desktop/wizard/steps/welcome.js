// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Stub — real implementation lands in Task C3.
(function () {
    "use strict";
    function render(container, ctx) {
        const div = document.createElement("div");
        div.className = "step-welcome";
        const h = document.createElement("h2"); h.textContent = (ctx && ctx.state && ctx.state.isReconfigure) ? "Reconfigure A.T.L.A.S" : "Welcome to A.T.L.A.S";
        const p = document.createElement("p"); p.textContent = "Setup will ask a few quick questions.";
        const btn = document.createElement("button"); btn.className = "sp-btn"; btn.textContent = "Get Started";
        btn.addEventListener("click", function () { if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance(); });
        div.appendChild(h); div.appendChild(p); div.appendChild(btn);
        container.appendChild(div);
    }
    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.welcome = { render: render };
})();
