// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";
    const PREF_PANE_MAP = {
        accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        screen:        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        microphone:    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        location:      "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices",
    };

    function prefPaneUrlFor(name) {
        return Object.prototype.hasOwnProperty.call(PREF_PANE_MAP, name) ? PREF_PANE_MAP[name] : null;
    }

    const PERMS = [
        { key: "accessibility", title: "Accessibility",   why: "Global hotkey + overlay above other apps." },
        { key: "screen",        title: "Screen Recording", why: "Screenshots and screen-aware help." },
        { key: "microphone",    title: "Microphone",      why: "Voice messages and live voice." },
        { key: "location",      title: "Location",        why: "Location-aware reminders." },
    ];

    function pillClass(s) { return s === "granted" ? "sp-pill sp-pill--ok" : s === "denied" ? "sp-pill sp-pill--bad" : "sp-pill sp-pill--idk"; }
    // "unknown" is macOS's "not-determined" — Electron's getMediaAccessStatus
    // returns this until the app itself invokes the matching API for the first
    // time. We label it "Unknown" (not "Not set") so the user knows granting in
    // System Settings is fine even if this UI can't verify it yet.
    function pillText(s)  { return s === "granted" ? "Granted" : s === "denied" ? "Denied" : "Unknown"; }

    // E3b: does the tile roll up to "effectively OK" when skipped or granted?
    // Skipped perms turn amber in the Ready Hub; granted turn green.
    function isPermissionEffectivelyOk(status, skipped) {
        if (skipped) return "amber";
        if (status === "granted") return "green";
        return "neutral";
    }

    function PermissionsGrid(props) {
        this.props = props || {};
        this._el = null;
        this._timer = null;
        this._state = {};
        this._cards = {};
        this._skipped = Object.assign({}, (this.props.skipped || {}));
        this._onChange = this.props.onChange || function(){};
    }

    PermissionsGrid.prototype._renderSkippedRow = function (key, title) {
        const self = this;
        const row = document.createElement("div");
        row.className = "sp-perm__row sp-perm__skipped";
        row.setAttribute("data-sp-perm-skipped", key);
        const pill = document.createElement("span");
        pill.className = "sp-pill sp-pill--idk";
        pill.textContent = "\u26A0\uFE0F " + title + " skipped — some features disabled";
        row.appendChild(pill);
        const undo = document.createElement("button");
        undo.className = "sp-btn sp-btn--ghost";
        undo.textContent = "Un-skip";
        undo.addEventListener("click", function () { self._setSkipped(key, false); });
        row.appendChild(undo);
        return row;
    };

    PermissionsGrid.prototype._setSkipped = function (key, skipped) {
        this._skipped[key] = !!skipped;
        if (window.bhai && window.bhai.setupMarkPermissionSkipped) {
            window.bhai.setupMarkPermissionSkipped(key, !!skipped).catch(function(){});
        }
        // Rebuild card for this key
        const card = this._cards[key];
        if (!card) return;
        while (card.firstChild) card.removeChild(card.firstChild);
        this._buildCardBody(card, key);
        this._onChange({ state: this._state, skipped: Object.assign({}, this._skipped) });
    };

    PermissionsGrid.prototype._buildCardBody = function (card, key) {
        const self = this;
        const perm = PERMS.find(function (p) { return p.key === key; });
        if (!perm) return;

        const title = document.createElement("div");
        title.className = "sp-perm__title"; title.textContent = perm.title;
        const why = document.createElement("div");
        why.className = "sp-perm__why"; why.textContent = perm.why;
        card.appendChild(title); card.appendChild(why);

        if (this._skipped[key]) {
            card.appendChild(this._renderSkippedRow(key, perm.title));
            return;
        }

        const row = document.createElement("div");
        row.className = "sp-perm__row";
        const pill = document.createElement("span");
        pill.className = "sp-pill sp-pill--idk"; pill.setAttribute("data-sp-pill", "");
        pill.textContent = "Loading…";
        const grant = document.createElement("button");
        grant.className = "sp-btn"; grant.setAttribute("data-sp-grant", "");
        grant.textContent = "Grant";
        grant.addEventListener("click", function () {
            if (window.bhai && window.bhai.setupRequestPermission) {
                window.bhai.setupRequestPermission(key).catch(function(){});
            }
        });
        const skip = document.createElement("button");
        skip.className = "sp-btn sp-btn--ghost"; skip.setAttribute("data-sp-skip", "");
        skip.textContent = "Skip this";
        skip.addEventListener("click", function () { self._setSkipped(key, true); });

        row.appendChild(pill);
        row.appendChild(grant);
        row.appendChild(skip);
        card.appendChild(row);

        // Reflect current cached state immediately so pill isn't stuck on "Loading…" after re-skip-undo.
        const current = this._state[key];
        if (current) { pill.className = pillClass(current); pill.textContent = pillText(current); }
    };

    PermissionsGrid.prototype.mount = async function (container) {
        if (!container) throw new Error("PermissionsGrid.mount: container is required");
        const isMac = (this.props.platform || "darwin") === "darwin";
        const root = document.createElement("div");
        root.className = "sp-root";

        if (!isMac) {
            const card = document.createElement("div");
            card.className = "sp-perm";
            const title = document.createElement("div"); title.className = "sp-perm__title"; title.textContent = "Windows handles permissions at runtime";
            const why = document.createElement("div"); why.className = "sp-perm__why"; why.textContent = "Bhai will ask for mic/screen access when the feature is first used.";
            card.appendChild(title); card.appendChild(why);
            root.appendChild(card);
            container.appendChild(root);
            this._el = root;
            return this;
        }

        const grid = document.createElement("div"); grid.className = "sp-perms";
        const self = this;
        PERMS.forEach(function (p) {
            const card = document.createElement("div");
            card.className = "sp-perm";
            self._cards[p.key] = card;
            self._buildCardBody(card, p.key);
            grid.appendChild(card);
        });
        root.appendChild(grid); container.appendChild(root); this._el = root;

        await this._refresh();
        this._timer = setInterval(function () { self._refresh(); }, 1000);
        return this;
    };

    PermissionsGrid.prototype._refresh = async function () {
        if (!window.bhai || !window.bhai.setupPollPermissions) return;
        let next;
        try { next = await window.bhai.setupPollPermissions(); } catch { return; }
        if (!next) return;
        const prev = this._state;
        this._state = next;
        const cards = this._cards;
        Object.keys(cards).forEach(function (k) {
            const pill = cards[k].querySelector("[data-sp-pill]");
            if (!pill) return; // skipped cards don't render a pill
            const s = next[k] || "unknown";
            pill.className = pillClass(s);
            pill.textContent = pillText(s);
        });
        if (JSON.stringify(prev) !== JSON.stringify(next)) {
            this._onChange({ state: next, skipped: Object.assign({}, this._skipped) });
        }
    };

    PermissionsGrid.prototype.getSkipped = function () { return Object.assign({}, this._skipped); };

    PermissionsGrid.prototype.unmount = function () {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
        this._el = null; this._cards = {};
    };

    if (typeof window !== "undefined") {
        window.SetupComponents = window.SetupComponents || {};
        window.SetupComponents.PermissionsGrid = PermissionsGrid;
    }
    if (typeof module !== "undefined") {
        module.exports = { prefPaneUrlFor, PermissionsGrid, PREF_PANE_MAP, isPermissionEffectivelyOk };
    }
})();
