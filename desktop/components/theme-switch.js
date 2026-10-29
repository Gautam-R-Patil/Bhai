// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
(function () {
    "use strict";

    function resolveTheme(pick, osPref) {
        if (pick === "light" || pick === "dark") return pick;
        if (osPref === "dark" || osPref === "light") return osPref;
        return "light";
    }

    function ThemeSwitch(props) {
        this.props = props || {};
        this._el = null;
        this._pick = this.props.initial || "system";
        this._osPref = this.props.osPreference || "light";
    }

    ThemeSwitch.prototype.mount = function (container) {
        if (!container) throw new Error("ThemeSwitch.mount: container is required");
        const root = document.createElement("div");
        root.className = "sp-theme";
        const opts = [["light", "Light"], ["dark", "Dark"], ["system", "System"]];
        const self = this;
        opts.forEach(function (o) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sp-theme__pill" + (o[0] === self._pick ? " sp-theme__pill--active" : "");
            btn.textContent = o[1];
            btn.setAttribute("data-sp-pick", o[0]);
            btn.addEventListener("click", function () { self._set(o[0]); });
            root.appendChild(btn);
        });
        container.appendChild(root);
        this._el = root;
        return this;
    };

    ThemeSwitch.prototype._set = function (pick) {
        this._pick = pick;
        if (this._el) {
            const pills = this._el.querySelectorAll("[data-sp-pick]");
            for (let i = 0; i < pills.length; i++) {
                const p = pills[i];
                const on = p.getAttribute("data-sp-pick") === pick;
                p.className = "sp-theme__pill" + (on ? " sp-theme__pill--active" : "");
            }
        }
        const resolved = resolveTheme(pick, this._osPref);
        try {
            document.dispatchEvent(new CustomEvent("theme-change", { detail: { pick: pick, resolved: resolved } }));
        } catch {}
        if (typeof this.props.onChange === "function") {
            this.props.onChange({ pick: pick, resolved: resolved });
        }
    };

    ThemeSwitch.prototype.getValue = function () { return this._pick; };

    ThemeSwitch.prototype.unmount = function () {
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
        this._el = null;
    };

    if (typeof window !== "undefined") {
        window.SetupComponents = window.SetupComponents || {};
        window.SetupComponents.ThemeSwitch = ThemeSwitch;
    }
    if (typeof module !== "undefined") {
        module.exports = { resolveTheme, ThemeSwitch };
    }
})();
