// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Electron accelerator reference: https://www.electronjs.org/docs/latest/api/accelerator
(function () {
    "use strict";
    function isModifierKey(k) {
        return k === "Meta" || k === "Shift" || k === "Control" || k === "Alt"
            || k === "OS" || k === "Super" || k === "Hyper";
    }
    function codeToKeyName(code, key) {
        const m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
        const d = /^Digit(\d)$/.exec(code);  if (d) return d[1];
        const n = /^Numpad(\d)$/.exec(code); if (n) return "num" + n[1];
        if (/^F\d{1,2}$/.test(code)) return code;
        const named = {
            Space: "Space", Tab: "Tab", Enter: "Return", NumpadEnter: "Return",
            Escape: "Escape", Backspace: "Backspace", Delete: "Delete",
            ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
            Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
            Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
            Semicolon: ";", Quote: "'", Backquote: "`", Backslash: "\\",
            Comma: ",", Period: ".", Slash: "/",
        };
        if (named[code]) return named[code];
        if (key && key.length === 1) return key.toUpperCase();
        return null;
    }
    function parseAccelerator(e, platform) {
        if (!e || isModifierKey(e.key)) return null;
        const parts = [];
        if (e.metaKey || (platform !== "darwin" && e.ctrlKey)) parts.push("CmdOrCtrl");
        else if (e.ctrlKey) parts.push("Control");
        if (e.altKey) parts.push("Alt");
        if (e.shiftKey) parts.push("Shift");
        const keyName = codeToKeyName(e.code, e.key);
        if (!keyName) return null;
        parts.push(keyName);
        return parts.join("+");
    }

    function HotkeyPicker(props) {
        this.props = props || {};
        this._el = null;
        this._comboEl = null;
        this._statusEl = null;
        this._recordBtn = null;
        this._combo = this.props.initial || "Alt+Space";
        this._platform = this.props.platform || "darwin";
        this._recording = false;
        this._onKeyDown = null;
        // Monotonic counter used to discard in-flight test/commit calls when the user
        // starts a new recording before the previous test IPC round-trip resolves.
        this._recordSeq = 0;
    }

    HotkeyPicker.prototype.mount = function (container) {
        if (!container) throw new Error("HotkeyPicker.mount: container is required");
        const root = document.createElement("div");
        root.className = "sp-hotkey";
        const comboEl = document.createElement("div");
        comboEl.className = "sp-hotkey__combo";
        comboEl.setAttribute("data-sp-combo", "");
        comboEl.textContent = this._combo;
        const recordBtn = document.createElement("button");
        recordBtn.className = "sp-btn sp-btn--ghost";
        recordBtn.setAttribute("data-sp-record", "");
        recordBtn.textContent = "Record new";
        const statusEl = document.createElement("span");
        statusEl.className = "sp-hotkey__status";
        statusEl.setAttribute("data-sp-status", "");
        root.appendChild(comboEl);
        root.appendChild(recordBtn);
        root.appendChild(statusEl);

        const self = this;
        recordBtn.addEventListener("click", function () { self._startRecording(); });

        container.appendChild(root);
        this._el = root;
        this._comboEl = comboEl;
        this._statusEl = statusEl;
        this._recordBtn = recordBtn;
        return this;
    };

    HotkeyPicker.prototype._setStatus = function (text, conflict) {
        if (!this._statusEl) return;
        this._statusEl.textContent = text || "";
        this._statusEl.className = "sp-hotkey__status" + (conflict ? " sp-hotkey__conflict" : "");
    };

    HotkeyPicker.prototype._startRecording = function () {
        if (this._recording || !this._el) return;
        this._recording = true;
        this._recordSeq += 1;
        const token = this._recordSeq;
        this._el.classList.add("sp-hotkey--recording");
        this._setStatus("Press the combo you want…", false);
        const self = this;
        this._onKeyDown = function (e) {
            // Escape cancels the recording without committing anything.
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                self._stopRecording();
                self._setStatus("Cancelled", false);
                return;
            }
            const combo = parseAccelerator(e, self._platform);
            if (!combo) return;
            e.preventDefault();
            e.stopPropagation();
            self._stopRecording();
            self._testAndCommit(combo, token);
        };
        window.addEventListener("keydown", this._onKeyDown, true);
    };

    HotkeyPicker.prototype._stopRecording = function () {
        this._recording = false;
        if (this._onKeyDown) {
            window.removeEventListener("keydown", this._onKeyDown, true);
            this._onKeyDown = null;
        }
        if (this._el) this._el.classList.remove("sp-hotkey--recording");
    };

    HotkeyPicker.prototype._testAndCommit = async function (combo, token) {
        if (!window.atlas || !window.atlas.setupTestHotkey) {
            this._commit(combo, token);
            return;
        }
        this._setStatus("Testing " + combo + "…", false);
        let res;
        try { res = await window.atlas.setupTestHotkey(combo); }
        catch (err) {
            if (token !== this._recordSeq) return; // stale — user started another recording
            this._setStatus("Error: " + (err.message || err), true);
            return;
        }
        if (token !== this._recordSeq) return; // stale
        if (res && res.ok) this._commit(combo, token);
        else this._setStatus((res && res.conflict) || "Combo in use by another app", true);
    };

    HotkeyPicker.prototype._commit = async function (combo, token) {
        this._combo = combo;
        if (this._comboEl) this._comboEl.textContent = combo;
        this._setStatus("Saved", false);
        if (window.atlas && window.atlas.setupSaveHotkey) {
            let saveRes;
            try { saveRes = await window.atlas.setupSaveHotkey(combo); }
            catch (err) {
                if (token !== this._recordSeq) return;
                this._setStatus("Save failed: " + (err.message || err), true);
                return;
            }
            if (token !== this._recordSeq) return;
            if (!saveRes || !saveRes.ok) {
                this._setStatus("Save failed: " + ((saveRes && saveRes.error) || "unknown"), true);
                return;
            }
        }
        if (typeof this.props.onChange === "function") this.props.onChange(combo);
    };

    HotkeyPicker.prototype.getValue = function () { return this._combo; };

    HotkeyPicker.prototype.unmount = function () {
        this._stopRecording();
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
        this._el = null;
        this._comboEl = null;
        this._statusEl = null;
        this._recordBtn = null;
    };

    if (typeof window !== "undefined") {
        window.SetupComponents = window.SetupComponents || {};
        window.SetupComponents.HotkeyPicker = HotkeyPicker;
    }
    if (typeof module !== "undefined") {
        module.exports = { parseAccelerator, isModifierKey, codeToKeyName, HotkeyPicker };
    }
})();
