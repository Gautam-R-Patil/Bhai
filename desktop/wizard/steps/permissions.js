// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";

    function render(root, ctx) {
        const platform = (ctx && ctx.state && ctx.state.platform) || "darwin";
        const isMac = platform === "darwin";

        const section = document.createElement("section");
        section.className = "step step-permissions";

        const title = document.createElement("h2");
        title.className = "step-title";
        title.textContent = "System permissions";
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = isMac
            ? "Grant whatever you want now — you can come back anytime."
            : "Windows will prompt when features are first used.";
        section.appendChild(sub);

        const gridHost = document.createElement("div");
        gridHost.id = "perm-grid";
        section.appendChild(gridHost);

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const back = document.createElement("button");
        back.id = "pm-back"; back.type = "button"; back.className = "btn-ghost"; back.textContent = "Back";
        const next = document.createElement("button");
        next.id = "pm-next"; next.type = "button"; next.className = "btn-primary"; next.textContent = "Continue";
        actions.appendChild(back);
        actions.appendChild(next);
        section.appendChild(actions);

        root.appendChild(section);

        // Mount PermissionsGrid (PascalCase constructor per Phase E).
        const C = window.SetupComponents || {};
        let grid = null;
        if (C.PermissionsGrid) {
            const skipped = (ctx && ctx.state && ctx.state.permissions && ctx.state.permissions.skipped) || {};
            grid = new C.PermissionsGrid({ platform: platform, skipped: skipped });
            // PermissionsGrid.mount is async; kick off but don't block render.
            Promise.resolve(grid.mount(gridHost)).catch(function () {});
        } else {
            const fallback = document.createElement("div");
            fallback.className = "info-card";
            fallback.textContent = "PermissionsGrid component unavailable.";
            gridHost.appendChild(fallback);
        }

        back.addEventListener("click", function () {
            if (grid && typeof grid.unmount === "function") { try { grid.unmount(); } catch {} }
            if (ctx && typeof ctx.onBack === "function") ctx.onBack();
        });

        next.addEventListener("click", async function () {
            if (grid && typeof grid.unmount === "function") { try { grid.unmount(); } catch {} }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.permissions = { render: render };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render };
    }
})();
