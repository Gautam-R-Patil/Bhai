// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Stub — real implementation lands in Task C11.
(function () {
    "use strict";
    function render(container, ctx) {
        const div = document.createElement("div");
        const h = document.createElement("h2"); h.textContent = "Installing...";
        const p = document.createElement("p"); p.textContent = "TODO: phase runner + log";
        const btn = document.createElement("button"); btn.className = "sp-btn"; btn.textContent = "Continue";
        btn.addEventListener("click", function () { if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance(); });
        div.appendChild(h); div.appendChild(p); div.appendChild(btn);
        container.appendChild(div);
    }
    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.install = { render: render };
})();
