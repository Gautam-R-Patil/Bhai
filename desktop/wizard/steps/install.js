// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";

    const ICON = { pending: "\u25CB", running: "\u25D0", done: "\u2713", failed: "\u2715" };
    const PHASE_IDS = [
        "node", "playwright-chromium", "embedding-model", "sox",
        "ollama", "ui-tars-model", "omniparser-deps",
        "data-dir", "workspace", "setup-state-finalize",
    ];
    function clearChildren(el) {
        while (el && el.firstChild) el.removeChild(el.firstChild);
    }

    async function render(root, ctx) {
        // LABELS is built per-render so window.Copy is guaranteed loaded.
        const LABELS = {
            "node":               window.Copy.get("install", "phase_node"),
            "playwright-chromium":window.Copy.get("install", "phase_playwright"),
            "embedding-model":    window.Copy.get("install", "phase_embedding"),
            "sox":                window.Copy.get("install", "phase_sox"),
            "ollama":             window.Copy.get("install", "phase_ollama"),
            "ui-tars-model":      window.Copy.get("install", "phase_vision_model"),
            "omniparser-deps":    window.Copy.get("install", "phase_vision_deps"),
            "data-dir":           window.Copy.get("install", "phase_data_dir"),
            "workspace":          window.Copy.get("install", "phase_workspace"),
            "setup-state-finalize": window.Copy.get("install", "phase_finalize"),
        };

        // Build static scaffolding.
        const section = document.createElement("section");
        section.className = "step step-install";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + window.Copy.get("install", "eyebrow");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = window.Copy.get("install", "title");
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

        // Progress meta — percent + ETA
        const progressMeta = document.createElement("div");
        progressMeta.className = "progress-meta";
        const percentEl = document.createElement("span");
        percentEl.className = "progress-percent";
        percentEl.id = "progress-percent";
        percentEl.textContent = "0%";
        const etaEl = document.createElement("span");
        etaEl.className = "progress-eta";
        etaEl.id = "progress-eta";
        etaEl.textContent = "Estimating…";
        progressMeta.appendChild(percentEl);
        progressMeta.appendChild(etaEl);
        section.appendChild(progressMeta);

        // Fun fact card — rotates every 7s during install
        const factCard = document.createElement("div");
        factCard.className = "fun-fact-card";
        factCard.id = "fun-fact";
        const factLabel = document.createElement("div");
        factLabel.className = "fun-fact-label";
        factLabel.textContent = window.Copy.get("install", "fact_eyebrow");
        const factBody = document.createElement("div");
        factBody.className = "fun-fact-body";
        factBody.id = "fun-fact-body";
        factBody.textContent = "A.T.L.A.S remembers your conversations across sessions — it learns how you work.";
        factCard.appendChild(factLabel);
        factCard.appendChild(factBody);
        section.appendChild(factCard);

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

        // ── Fun facts — user-facing benefits, rotate every 7s ──
        // Pulled from tryatlasagi.com/101-reasons. Stay product-benefit framed
        // (what the user can do) rather than implementation detail (what tech
        // powers it). The wizard is the first impression — leaking internals
        // here positions A.T.L.A.S as a tech demo, not as a useful assistant.
        const FUN_FACTS = [
            "A.T.L.A.S remembers your preferences, communication style, and past conversations.",
            "It automates browser tasks — form-filling, clicking, tab-switching — without you watching.",
            "It researches across hundreds of sources and gives you a synthesized report, not a pile of links.",
            "It deploys multiple specialized agents to work on different parts of your task in parallel.",
            "You can control it entirely through natural voice — no technical syntax to memorize.",
            "Your data runs locally on your machine and never leaves your device.",
            "It keeps working even when your computer is closed — finishing tasks while you sleep.",
            "Reach it from desktop, mobile, Slack, Discord, WhatsApp, or your browser.",
            "It learns from your workflows and improves its approach based on your patterns.",
            "It executes complex multi-step processes across different apps in minutes.",
            "It manages spreadsheets, APIs, terminal commands, and file organization for you.",
            "Sources come with credibility scores — facts are cross-referenced before you see them.",
            "It switches languages mid-sentence and auto-detects your preferred one.",
            "It anticipates what you'll need next and suggests it before you ask.",
            "Routine Monday-morning tasks — dashboards, email summaries — disappear.",
        ];
        let factIdx = Math.floor(Math.random() * FUN_FACTS.length);
        function rotateFact() {
            factBody.style.opacity = "0";
            setTimeout(function () {
                factIdx = (factIdx + 1) % FUN_FACTS.length;
                factBody.textContent = FUN_FACTS[factIdx];
                factBody.style.opacity = "1";
            }, 250);
        }
        factBody.textContent = FUN_FACTS[factIdx];
        const factTimer = setInterval(rotateFact, 7000);

        // ── ETA estimator — tracks percent-per-ms since install started ──
        // Full install (Node + Playwright + embedding + data + workspace + finalize)
        // empirically runs 30-90s on cold install, <5s on cached. We compute a
        // rolling estimate from the current progress rate.
        // Sliding-window ETA: only updates on real progress events; deltas over
        // the last N samples avoid the old bug where a flat-percent long phase
        // (e.g. 5-minute `ollama pull`) inflated elapsed \u2192 shrank rate \u2192 grew ETA.
        const RATE_SAMPLES = [];
        const RATE_WINDOW = 8;
        function formatEta(seconds) {
            if (seconds < 0 || !Number.isFinite(seconds)) return "Estimating\u2026";
            if (seconds < 5) return "Almost done\u2026";
            if (seconds < 60) return "~" + Math.round(seconds) + "s remaining";
            const m = Math.floor(seconds / 60);
            const s = Math.round(seconds % 60);
            return "~" + m + "m " + (s < 10 ? "0" : "") + s + "s remaining";
        }
        function recordProgressAndUpdateEta(percent) {
            const now = Date.now();
            RATE_SAMPLES.push({ ts: now, percent: percent });
            if (RATE_SAMPLES.length > RATE_WINDOW) RATE_SAMPLES.shift();
            if (RATE_SAMPLES.length < 2 || percent <= 1) {
                etaEl.textContent = "Estimating\u2026";
                return;
            }
            const oldest = RATE_SAMPLES[0];
            const newest = RATE_SAMPLES[RATE_SAMPLES.length - 1];
            const deltaP = newest.percent - oldest.percent;
            const deltaT = newest.ts - oldest.ts;
            if (deltaP <= 0 || deltaT <= 0) return; // no forward progress yet \u2014 keep last
            const rate = deltaP / deltaT;
            const remaining = (100 - newest.percent) / rate;
            etaEl.textContent = formatEta(remaining / 1000);
        }
        // Staleness timer: when no progress event has arrived for 15s (e.g.
        // during a long `ollama pull`), reset ETA to "Estimating\u2026" so the user
        // doesn't see a stale "~1m 20s remaining" frozen for 5 minutes while
        // the actual download takes much longer than predicted.
        const etaStalenessTimer = setInterval(function () {
            if (RATE_SAMPLES.length > 0 &&
                Date.now() - RATE_SAMPLES[RATE_SAMPLES.length - 1].ts > 15000) {
                etaEl.textContent = "Estimating\u2026";
            }
        }, 5000);

        // Hide all pre-flight buttons as soon as the install actually starts streaming
        // progress. Previously the Resume button stayed visible during active progress
        // because the original render kept it shown when prior phases existed.
        function hidePreflightButtons() {
            startBtn.classList.add("hidden");
            resumeBtn.classList.add("hidden");
            retryBtn.classList.add("hidden");
        }

        // Listen for progress + log streams from the main-process runner.
        // Runner now sends "Running: id=<phase_id>" so the spinner highlights
        // the active phase by ID \u2014 independent of label-string drift between
        // phases.js and install.js. The old "Running: <label>" form is kept as
        // a fallback in case an older runner is in play.
        if (typeof atlas.onInstallProgress === "function") {
            atlas.onInstallProgress(function (payload) {
                if (!payload) return;
                const percent = payload.percent;
                const message = payload.message;
                if (typeof percent === "number" && percent >= 0) {
                    bar.style.width = Math.min(100, percent) + "%";
                    percentEl.textContent = Math.round(percent) + "%";
                    recordProgressAndUpdateEta(percent);
                    if (percent > 0 && percent < 100) hidePreflightButtons();
                }
                if (typeof message === "string") {
                    const idMatch = message.match(/^Running:\s*id=(\S+)/);
                    if (idMatch) {
                        renderList(idMatch[1]);
                        hidePreflightButtons();
                    } else {
                        const labelMatch = message.match(/^Running:\s*(.+)$/);
                        if (labelMatch) {
                            const label = labelMatch[1];
                            const id = Object.keys(LABELS).find(function (k) { return LABELS[k] === label; });
                            if (id) {
                                renderList(id);
                                hidePreflightButtons();
                            }
                        }
                    }
                }
                if (percent === 100) {
                    etaEl.textContent = "Done \u2713";
                    clearInterval(factTimer);
                    clearInterval(etaStalenessTimer);
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
            catch (err) { errEl.textContent = "Install error: " + (err.message || err); }
            finally { startBtn.disabled = false; }
        });

        resumeBtn.addEventListener("click", async function () {
            resumeBtn.disabled = true;
            errEl.textContent = "";
            if (typeof atlas.setupResumeInstall !== "function") { errEl.textContent = "Resume IPC unavailable."; resumeBtn.disabled = false; return; }
            try { await handle(await atlas.setupResumeInstall()); }
            catch (err) { errEl.textContent = "Resume error: " + (err.message || err); }
            finally { resumeBtn.disabled = false; }
        });

        retryBtn.addEventListener("click", async function () {
            if (!failedId) return;
            retryBtn.disabled = true;
            errEl.textContent = "";
            if (typeof atlas.setupRetryInstallPhase !== "function") { errEl.textContent = "Retry IPC unavailable."; retryBtn.disabled = false; return; }
            try { await handle(await atlas.setupRetryInstallPhase(failedId)); }
            catch (err) { errEl.textContent = "Retry error: " + (err.message || err); }
            finally { retryBtn.disabled = false; }
        });
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.install = { render: render };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render };
    }
})();
