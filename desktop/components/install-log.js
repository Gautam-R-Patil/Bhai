// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
(function () {
    "use strict";

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function formatLogLine(line) {
        const sev = (line && line.severity) || "info";
        const allowed = sev === "info" || sev === "ok" || sev === "warn" || sev === "err";
        const normalized = allowed ? sev : "info";
        const cls = "sp-log__line sp-log__line--" + normalized;
        const text = escapeHtml(line && line.text ? line.text : "");
        const hasActions = normalized === "err" && !!(line && typeof line.phaseId === "string" && line.phaseId.length > 0);
        let html = "<span>" + text + "</span>";
        if (hasActions) {
            const pid = escapeHtml(line.phaseId);
            html += "<span class='sp-log__actions' data-sp-phase='" + pid + "'>"
                + "<button data-sp-retry>Retry</button>"
                + "<button data-sp-skip>Skip</button>"
                + "<button data-sp-copy>Copy</button></span>";
        }
        return { html: html, className: cls, hasActions: hasActions };
    }

    // ── DOM-level helper (no innerHTML) — builds the same structure as formatLogLine but as real nodes.
    function buildRow(line) {
        const sev = (line && line.severity) || "info";
        const allowed = sev === "info" || sev === "ok" || sev === "warn" || sev === "err";
        const normalized = allowed ? sev : "info";
        const row = document.createElement("div");
        row.className = "sp-log__line sp-log__line--" + normalized;
        const text = document.createElement("span");
        text.textContent = (line && line.text) || "";
        row.appendChild(text);
        const hasActions = normalized === "err" && !!(line && typeof line.phaseId === "string" && line.phaseId.length > 0);
        if (hasActions) {
            const actions = document.createElement("span");
            actions.className = "sp-log__actions";
            actions.setAttribute("data-sp-phase", line.phaseId);
            const retry = document.createElement("button");
            retry.setAttribute("data-sp-retry", "");
            retry.textContent = "Retry";
            const skip = document.createElement("button");
            skip.setAttribute("data-sp-skip", "");
            skip.textContent = "Skip";
            const copy = document.createElement("button");
            copy.setAttribute("data-sp-copy", "");
            copy.textContent = "Copy";
            actions.appendChild(retry);
            actions.appendChild(skip);
            actions.appendChild(copy);
            row.appendChild(actions);
        }
        return { row: row, hasActions: hasActions };
    }

    function InstallLog(props) {
        this.props = props || {};
        this._el = null;
    }

    InstallLog.prototype.mount = function (container) {
        if (!container) throw new Error("InstallLog.mount: container is required");
        const root = document.createElement("div");
        root.className = "sp-log";
        root.setAttribute("role", "log");
        container.appendChild(root);
        this._el = root;
        return this;
    };

    InstallLog.prototype.addLine = function (text, severity, phaseId) {
        if (!this._el) return;
        const built = buildRow({ text: text, severity: severity, phaseId: phaseId });
        const self = this;
        if (built.hasActions) {
            const retry = built.row.querySelector("[data-sp-retry]");
            const skip = built.row.querySelector("[data-sp-skip]");
            const copy = built.row.querySelector("[data-sp-copy]");
            if (retry) retry.addEventListener("click", function () {
                if (window.bhai && window.bhai.setupRetryInstallPhase) {
                    Promise.resolve(window.bhai.setupRetryInstallPhase(phaseId)).catch(function () {});
                }
            });
            if (skip) skip.addEventListener("click", function () {
                if (typeof self.props.onSkip === "function") self.props.onSkip(phaseId);
            });
            if (copy) copy.addEventListener("click", function () {
                try {
                    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
                        navigator.clipboard.writeText(text);
                    }
                } catch {}
            });
        }
        this._el.appendChild(built.row);
        this._el.scrollTop = this._el.scrollHeight;
    };

    InstallLog.prototype.clear = function () {
        if (!this._el) return;
        while (this._el.firstChild) this._el.removeChild(this._el.firstChild);
    };

    InstallLog.prototype.unmount = function () {
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
        this._el = null;
    };

    if (typeof window !== "undefined") {
        window.SetupComponents = window.SetupComponents || {};
        window.SetupComponents.InstallLog = InstallLog;
    }
    if (typeof module !== "undefined") {
        module.exports = { formatLogLine, escapeHtml, InstallLog };
    }
})();
