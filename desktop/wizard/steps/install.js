// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";

    const ICON = { pending: "\u25CB", running: "\u25D0", done: "\u2713", failed: "\u2715" };
    const PHASE_IDS = [
        "node", "playwright-chromium", "embedding-model", "sox",
        "data-dir", "workspace", "setup-state-finalize",
    ];
    const LABELS = {
        "node": "Node.js 20",
        "playwright-chromium": "Browser engine",
        "embedding-model": "AI model",
        "sox": "Audio toolkit",
        "data-dir": "Data directory",
        "workspace": "Workspace folder",
        "setup-state-finalize": "Finalize",
    };

    function clearChildren(el) {
        while (el && el.firstChild) el.removeChild(el.firstChild);
    }

    async function render(root, ctx) {
        // Build static scaffolding.
        const section = document.createElement("section");
        section.className = "step step-install";

        const title = document.createElement("h2");
        title.className = "step-title";
        title.textContent = "Finishing up";
        section.appendChild(title);

        const listEl = document.createElement("ul");
        listEl.id = "phase-list";
        listEl.className = "phase-list";
        section.appendChild(listEl);

        const progressWrap = document.createElement("div");
        progressWrap.className = "progress-wrap";
        const bar = document.createElement("div");
        bar.id = "progress-bar";
        bar.className = "progress-bar";
        progressWrap.appendChild(bar);
        section.appendChild(progressWrap);

        const logHost = document.createElement("div");
        logHost.id = "log-host";
        logHost.className = "log-host";
        section.appendChild(logHost);

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const startBtn = document.createElement("button");
        startBtn.id = "inst-start"; startBtn.type = "button"; startBtn.className = "btn-primary"; startBtn.textContent = "Begin install";
        const resumeBtn = document.createElement("button");
        resumeBtn.id = "inst-resume"; resumeBtn.type = "button"; resumeBtn.className = "btn-ghost hidden"; resumeBtn.textContent = "Resume";
        const retryBtn = document.createElement("button");
        retryBtn.id = "inst-retry"; retryBtn.type = "button"; retryBtn.className = "btn-ghost hidden"; retryBtn.textContent = "Retry failed phase";
        actions.appendChild(startBtn); actions.appendChild(resumeBtn); actions.appendChild(retryBtn);
        section.appendChild(actions);

        const errEl = document.createElement("p");
        errEl.id = "inst-err"; errEl.className = "step-error"; errEl.setAttribute("aria-live", "polite");
        section.appendChild(errEl);

        root.appendChild(section);

        // Mount InstallLog (PascalCase constructor per Phase E).
        const C = window.SetupComponents || {};
        let log = null;
        if (C.InstallLog) {
            log = new C.InstallLog().mount(logHost);
        }
        function appendLog(msg, severity, phaseId) {
            if (log && typeof log.addLine === "function") { log.addLine(msg, severity || "info", phaseId); return; }
            const p = document.createElement("pre");
            p.textContent = msg;
            logHost.appendChild(p);
        }

        // Snapshot done-markers so we can pre-color the phase list on first render.
        const atlas = window.atlas || {};
        let stateResp = { success: false, state: {} };
        if (typeof atlas.setupGetSetupState === "function") {
            try { stateResp = await atlas.setupGetSetupState(); } catch { stateResp = { success: false, state: {} }; }
        }
        const completed = (stateResp && stateResp.success && stateResp.state) ? stateResp.state : {};
        let failedId = null;

        function renderList(running) {
            clearChildren(listEl);
            for (const id of PHASE_IDS) {
                let st = "pending";
                if (completed[id] && completed[id].completedAt) st = "done";
                if (id === running) st = "running";
                if (id === failedId) st = "failed";
                const li = document.createElement("li");
                li.className = "phase-row phase-" + st;
                li.setAttribute("data-sp-phase", id);
                const icon = document.createElement("span");
                icon.className = "phase-icon";
                icon.textContent = ICON[st];
                const label = document.createElement("span");
                label.textContent = LABELS[id] || id;
                li.appendChild(icon);
                li.appendChild(label);
                listEl.appendChild(li);
            }
        }

        // Decide what to show on mount.
        const doneKeys = Object.keys(completed).filter(function (k) { return !k.startsWith("__"); });
        const doneCount = doneKeys.length;
        if (doneCount > 0 && doneCount < PHASE_IDS.length) {
            resumeBtn.classList.remove("hidden");
            startBtn.classList.add("hidden");
        }
        if (doneCount >= PHASE_IDS.length) {
            // Everything already done → skip straight to Ready Hub.
            window.location.href = "ready-hub.html";
            return;
        }

        // Listen for progress + log streams from the main-process runner.
        if (typeof atlas.onInstallProgress === "function") {
            atlas.onInstallProgress(function (payload) {
                if (!payload) return;
                const percent = payload.percent;
                const message = payload.message;
                if (typeof percent === "number" && percent >= 0) {
                    bar.style.width = Math.min(100, percent) + "%";
                }
                if (typeof message === "string") {
                    const match = message.match(/^Running:\s*(.+)$/);
                    if (match) {
                        const label = match[1];
                        const id = Object.keys(LABELS).find(function (k) { return LABELS[k] === label; });
                        if (id) renderList(id);
                    }
                }
                if (percent === 100) {
                    setTimeout(function () { window.location.href = "ready-hub.html"; }, 500);
                }
            });
        }

        if (typeof atlas.onInstallLog === "function") {
            atlas.onInstallLog(function (msg) {
                appendLog(msg, "info");
            });
        }

        renderList(null);

        // Post-result handler — deals with success / paused / generic failure.
        async function handle(res) {
            if (res && res.success) {
                window.location.href = "ready-hub.html";
                return;
            }
            if (res && res.paused) {
                failedId = (res.failedPhase && res.failedPhase.id) || null;
                const label = (res.failedPhase && res.failedPhase.label) || "phase";
                errEl.textContent = "Failed at " + label + ": " + (res.error || "unknown");
                retryBtn.classList.remove("hidden");
                resumeBtn.classList.remove("hidden");
                startBtn.classList.add("hidden");
                // Refresh completed-markers so successfully-done phases show green.
                if (typeof atlas.setupGetSetupState === "function") {
                    try {
                        const refreshed = await atlas.setupGetSetupState();
                        if (refreshed && refreshed.success && refreshed.state) {
                            Object.assign(completed, refreshed.state);
                        }
                    } catch { /* ignore */ }
                }
                renderList(null);
                return;
            }
            errEl.textContent = (res && res.error) || "Install failed.";
        }

        startBtn.addEventListener("click", async function () {
            startBtn.disabled = true;
            errEl.textContent = "";
            if (typeof atlas.startInstall !== "function") { errEl.textContent = "Install IPC unavailable."; startBtn.disabled = false; return; }
            const workspace = (ctx && ctx.state && ctx.state.workspace && ctx.state.workspace.path) || "";
            try { await handle(await atlas.startInstall({ workspace: workspace })); }
            catch (err) { errEl.textContent = "Install error: " + (err.message || err); startBtn.disabled = false; }
        });

        resumeBtn.addEventListener("click", async function () {
            resumeBtn.disabled = true;
            errEl.textContent = "";
            if (typeof atlas.setupResumeInstall !== "function") { errEl.textContent = "Resume IPC unavailable."; resumeBtn.disabled = false; return; }
            try { await handle(await atlas.setupResumeInstall()); }
            catch (err) { errEl.textContent = "Resume error: " + (err.message || err); }
            resumeBtn.disabled = false;
        });

        retryBtn.addEventListener("click", async function () {
            if (!failedId) return;
            retryBtn.disabled = true;
            errEl.textContent = "";
            if (typeof atlas.setupRetryInstallPhase !== "function") { errEl.textContent = "Retry IPC unavailable."; retryBtn.disabled = false; return; }
            try { await handle(await atlas.setupRetryInstallPhase(failedId)); }
            catch (err) { errEl.textContent = "Retry error: " + (err.message || err); }
            retryBtn.disabled = false;
        });
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.install = { render: render };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render };
    }
})();
