// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";
    function classForStatus(status) {
        const allowed = { green: true, amber: true, neutral: true };
        const key = allowed[status] ? status : "neutral";
        return "sp-tile sp-tile--" + key;
    }

    function StatusTile(props) { this.props = props || {}; this._el = null; this._handleClick = null; }
    StatusTile.prototype.mount = function (container) {
        if (!container) throw new Error("StatusTile.mount: container is required");
        const p = this.props;
        const el = document.createElement("div");
        el.className = classForStatus(p.status);
        el.setAttribute("role", p.onClick ? "button" : "group");
        if (p.onClick) el.setAttribute("tabindex", "0");
        const label = document.createElement("div"); label.className = "sp-tile__label"; label.textContent = p.label || ""; el.appendChild(label);
        const value = document.createElement("div"); value.className = "sp-tile__value"; value.textContent = p.value || ""; el.appendChild(value);
        if (p.secondary) { const s = document.createElement("div"); s.className = "sp-tile__secondary"; s.textContent = p.secondary; el.appendChild(s); }
        if (p.actionLabel) { const a = document.createElement("a"); a.className = "sp-tile__action"; a.href = "#"; a.textContent = p.actionLabel; el.appendChild(a); }
        if (p.onClick) {
            this._handleClick = function (e) { e.preventDefault(); p.onClick(); };
            el.addEventListener("click", this._handleClick);
            el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onClick(); } });
        }
        container.appendChild(el); this._el = el; return this;
    };
    StatusTile.prototype.update = function (nextProps) {
        this.props = Object.assign({}, this.props, nextProps || {});
        if (!this._el) return this;
        const nextClass = classForStatus(this.props.status);
        if (this._el.className !== nextClass) {
            this._el.className = nextClass + " sp-tile--pulse";
            const self = this;
            setTimeout(function () { if (self._el) self._el.className = nextClass; }, 320);
        }
        const labelEl = this._el.querySelector(".sp-tile__label");
        const valueEl = this._el.querySelector(".sp-tile__value");
        if (labelEl) labelEl.textContent = this.props.label || "";
        if (valueEl) valueEl.textContent = this.props.value || "";
        return this;
    };
    StatusTile.prototype.unmount = function () {
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
        this._el = null; this._handleClick = null;
    };

    if (typeof window !== "undefined") { window.SetupComponents = window.SetupComponents || {}; window.SetupComponents.StatusTile = StatusTile; }
    if (typeof module !== "undefined") { module.exports = { classForStatus, StatusTile }; }
})();
