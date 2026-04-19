// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";
    const STATUS_CLASSES = { green: "sp-tile--green", amber: "sp-tile--amber", neutral: "sp-tile--neutral" };

    function classForStatus(status) {
        const key = STATUS_CLASSES[status] ? status : "neutral";
        return "sp-tile sp-tile--" + key;
    }

    function roleForProps(p) { return p.onClick ? "button" : "status"; }

    function StatusTile(props) {
        this.props = props || {};
        this._el = null;
        this._handleClick = null;
        this._handleKeydown = null;
        this._pulseTimer = null;
        this._currentStatus = null;
    }

    StatusTile.prototype._attachHandlers = function () {
        const p = this.props;
        const el = this._el;
        if (!p.onClick || !el) return;
        this._handleClick = function (e) { e.preventDefault(); p.onClick(); };
        this._handleKeydown = function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onClick(); }
        };
        el.addEventListener("click", this._handleClick);
        el.addEventListener("keydown", this._handleKeydown);
    };

    StatusTile.prototype._detachHandlers = function () {
        const el = this._el;
        if (!el) return;
        if (this._handleClick) { el.removeEventListener("click", this._handleClick); this._handleClick = null; }
        if (this._handleKeydown) { el.removeEventListener("keydown", this._handleKeydown); this._handleKeydown = null; }
    };

    StatusTile.prototype.mount = function (container) {
        if (!container) throw new Error("StatusTile.mount: container is required");
        const p = this.props;
        const el = document.createElement("div");
        el.className = classForStatus(p.status);
        el.setAttribute("role", roleForProps(p));
        if (p.onClick) el.setAttribute("tabindex", "0");
        const label = document.createElement("div"); label.className = "sp-tile__label"; label.textContent = p.label || ""; el.appendChild(label);
        const value = document.createElement("div"); value.className = "sp-tile__value"; value.textContent = p.value || ""; el.appendChild(value);
        if (p.secondary) { const s = document.createElement("div"); s.className = "sp-tile__secondary"; s.textContent = p.secondary; el.appendChild(s); }
        if (p.actionLabel) { const a = document.createElement("a"); a.className = "sp-tile__action"; a.href = "#"; a.textContent = p.actionLabel; el.appendChild(a); }
        container.appendChild(el);
        this._el = el;
        this._currentStatus = p.status;
        this._attachHandlers();
        return this;
    };

    StatusTile.prototype.update = function (nextProps) {
        const prev = this.props;
        const next = Object.assign({}, prev, nextProps || {});
        this.props = next;
        const el = this._el;
        if (!el) return this;

        // Status change: retune base class (via classList to preserve external classes) + pulse.
        if (next.status !== this._currentStatus) {
            const prevStatusClass = STATUS_CLASSES[this._currentStatus] || STATUS_CLASSES.neutral;
            const nextStatusClass = STATUS_CLASSES[next.status] || STATUS_CLASSES.neutral;
            el.classList.remove(prevStatusClass);
            el.classList.add(nextStatusClass);
            el.classList.add("sp-tile--pulse");
            if (this._pulseTimer) clearTimeout(this._pulseTimer);
            const self = this;
            this._pulseTimer = setTimeout(function () {
                if (self._el) self._el.classList.remove("sp-tile--pulse");
                self._pulseTimer = null;
            }, 320);
            this._currentStatus = next.status;
        }

        // Handler / role churn: if onClick identity changed (including null/undefined), rebind.
        if (prev.onClick !== next.onClick) {
            this._detachHandlers();
            this._attachHandlers();
            el.setAttribute("role", roleForProps(next));
            if (next.onClick) el.setAttribute("tabindex", "0"); else el.removeAttribute("tabindex");
        }

        const labelEl = el.querySelector(".sp-tile__label");
        const valueEl = el.querySelector(".sp-tile__value");
        if (labelEl) labelEl.textContent = next.label || "";
        if (valueEl) valueEl.textContent = next.value || "";
        return this;
    };

    StatusTile.prototype.unmount = function () {
        if (this._pulseTimer) { clearTimeout(this._pulseTimer); this._pulseTimer = null; }
        this._detachHandlers();
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
        this._el = null;
        this._currentStatus = null;
    };

    if (typeof window !== "undefined") { window.SetupComponents = window.SetupComponents || {}; window.SetupComponents.StatusTile = StatusTile; }
    if (typeof module !== "undefined") { module.exports = { classForStatus, StatusTile }; }
})();
