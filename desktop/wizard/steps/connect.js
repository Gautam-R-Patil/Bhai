// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Connect step: while setup installs in the background, the user adds the
// Bhai extension to Chrome. Once install is done the bot starts, and the
// screen moves on by itself when the extension says hello. Skippable: the
// built-in browser works without it.
(function () {
    "use strict";

    const POLL_MS = 1500;

    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text) n.textContent = text;
        return n;
    }

    function render(root, ctx) {
        const bhai = window.bhai || {};
        const state = (ctx && ctx.state) || {};
        const section = el("section", "step step-connect");

        const eyebrow = el("div", "eyebrow");
        eyebrow.innerHTML = '<span class="iri-dot"></span>Chrome';
        section.appendChild(eyebrow);
        section.appendChild(el("h1", "step-title", "Let Bhai use your Chrome."));
        section.appendChild(
            el("p", "step-sub", "Add the Bhai extension so Bhai can work in the browser you're signed in to. You can skip this and add it later."),
        );

        const steps = el("ol", "connect-steps");
        steps.appendChild(el("li", null, "Open Chrome's extensions page and turn on Developer mode (top right)."));
        steps.appendChild(el("li", null, "Click “Load unpacked”, press ⌘⇧G and paste the folder path (Copy folder path below)."));
        steps.appendChild(el("li", null, "That's it — this screen moves on when Chrome connects."));
        section.appendChild(steps);

        const actions = el("div", "connect-actions");
        const openBtn = el("button", "btn btn-primary", "Open Chrome extensions");
        openBtn.type = "button";
        openBtn.addEventListener("click", function () { if (bhai.extensionOpen) bhai.extensionOpen("chrome"); });
        const folderBtn = el("button", "btn", "Show the Bhai extension folder");
        folderBtn.type = "button";
        folderBtn.addEventListener("click", function () { if (bhai.extensionOpen) bhai.extensionOpen("folder"); });
        const copyBtn = el("button", "btn", "Copy folder path");
        copyBtn.type = "button";
        copyBtn.addEventListener("click", async function () {
            const r = bhai.extensionOpen ? await bhai.extensionOpen("copy-path").catch(function () { return null; }) : null;
            copyBtn.textContent = r && r.success ? "Path copied" : "Couldn't copy";
        });
        const skipBtn = el("button", "btn btn-ghost", "Skip for now");
        skipBtn.type = "button";
        actions.appendChild(openBtn);
        actions.appendChild(copyBtn);
        actions.appendChild(folderBtn);
        actions.appendChild(skipBtn);
        section.appendChild(actions);

        const status = el("p", "connect-status");
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        section.appendChild(status);

        root.appendChild(section);

        let done = false;
        let timer = null;
        const finish = function () {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        };
        skipBtn.addEventListener("click", finish);
        root._cleanup = function () { done = true; if (timer) clearTimeout(timer); };

        // 1. Setup (first install only — a reconfigure already has it, and its
        //    data step must never run under a live bot), then start the bot.
        async function prepare() {
            if (!state.isReconfigure && bhai.startInstall) {
                status.textContent = "Setting things up in the background…";
                if (bhai.onInstallProgress && !window.__connectProgressHooked) {
                    window.__connectProgressHooked = true;
                    bhai.onInstallProgress(function (p) {
                        if (!done && p && typeof p.message === "string" && p.message) status.textContent = p.message;
                    });
                }
                const res = await bhai.startInstall({}).catch(function (e) { return { success: false, error: String(e && e.message || e) }; });
                if (!res || res.success !== true) {
                    status.textContent = "Setup hit a snag" + (res && res.error ? ": " + res.error : "") + ". You can continue; it retries on launch.";
                    return false;
                }
            }
            if (bhai.startBot) await bhai.startBot().catch(function () { /* the poll reports it */ });
            return true;
        }

        // 2. Wait for the extension.
        async function poll() {
            if (done) return;
            const s = bhai.extensionStatus ? await bhai.extensionStatus().catch(function () { return null; }) : null;
            if (done) return;
            if (s && s.connected) {
                status.textContent = "Chrome is connected.";
                skipBtn.textContent = "Continue";
                setTimeout(finish, 900);
                return;
            }
            status.textContent = s && s.running ? "Waiting for Chrome… add the extension above." : "Starting Bhai…";
            timer = setTimeout(poll, POLL_MS);
        }

        prepare().then(function (ok) { if (ok) poll(); });
    }

    if (typeof window !== "undefined") {
        window.WizardSteps = window.WizardSteps || {};
        window.WizardSteps.connect = { render: render };
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render };
    }
})();
