// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
(function () {
    "use strict";

    function render(root, ctx) {
        const Copy = window.Copy;
        const platform = (ctx && ctx.state && ctx.state.platform) || "darwin";

        const section = document.createElement("section");
        section.className = "step step-permissions";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + Copy.get("permissions", "eyebrow");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = Copy.get("permissions", "title");
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = Copy.get("permissions", "sub");
        section.appendChild(sub);

        const gridHost = document.createElement("div");
        gridHost.id = "perm-grid";
        section.appendChild(gridHost);

        const footnote = document.createElement("p");
        footnote.style.fontSize = "12.5px";
        footnote.style.color = "var(--ink-3)";
        footnote.style.margin = "14px 0 0";
        footnote.style.textAlign = "center";
        footnote.textContent = Copy.get("permissions", "footnote");
        section.appendChild(footnote);

        // No "Back": permissions is the final step (post-install, after signin).
        // Back would return to the already-completed signin step, which only moves
        // forward on a fresh login event — a dead-end. Forward is Continue / Skip all.
        const actions = document.createElement("div");
        actions.className = "step-actions";
        const grow = document.createElement("div"); grow.className = "grow";
        const skipAll = document.createElement("button");
        skipAll.type = "button"; skipAll.className = "btn btn-link";
        skipAll.textContent = Copy.get("permissions", "skip_all");
        const cta = document.createElement("button");
        cta.type = "button"; cta.className = "btn btn-primary";
        cta.innerHTML = 'Continue <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg></span>';
        actions.appendChild(grow); actions.appendChild(skipAll); actions.appendChild(cta);
        section.appendChild(actions);

        root.appendChild(section);

        const C = window.SetupComponents || {};
        let grid = null;
        if (C.PermissionsGrid) {
            const skipped = (ctx && ctx.state && ctx.state.permissions && ctx.state.permissions.skipped) || {};
            grid = new C.PermissionsGrid({ platform: platform, skipped: skipped });
            Promise.resolve(grid.mount(gridHost)).catch(function () {});
        }

        cta.addEventListener("click", async function () {
            if (grid && typeof grid.unmount === "function") { try { grid.unmount(); } catch {} }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
        skipAll.addEventListener("click", async function () {
            // Mark every remaining permission as skipped so the Ready Hub shows amber.
            const keys = ["accessibility", "screen", "microphone", "location"];
            for (const k of keys) {
                if (window.bhai && window.bhai.setupMarkPermissionSkipped) {
                    try { await window.bhai.setupMarkPermissionSkipped(k, true); } catch { /* best-effort */ }
                }
            }
            if (grid && typeof grid.unmount === "function") { try { grid.unmount(); } catch {} }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.permissions = { render: render };
    if (typeof module !== "undefined" && module.exports) module.exports = { render: render };
})();
