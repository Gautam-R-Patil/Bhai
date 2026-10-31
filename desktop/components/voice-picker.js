// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
(function () {
    "use strict";

    function groupVoicesByBackend(list) {
        const out = { labels: [], byBackend: {} };
        if (!Array.isArray(list)) return out;
        list.forEach(function (entry) {
            if (!entry || typeof entry.backend !== "string") return;
            out.labels.push(entry.backend);
            out.byBackend[entry.backend] = Array.isArray(entry.voices) ? entry.voices.slice() : [];
        });
        return out;
    }

    function VoicePicker(props) {
        this.props = props || {};
        this._el = null;
        this._sel = null;
        this._audio = null;
    }

    VoicePicker.prototype.mount = async function (container) {
        if (!container) throw new Error("VoicePicker.mount: container is required");
        const root = document.createElement("div");
        root.className = "sp-voice";

        const label = document.createElement("label");
        label.style.fontSize = "12px";
        label.style.color = "var(--text-secondary, #515154)";
        label.textContent = "Voice";

        const sel = document.createElement("select");
        sel.setAttribute("data-sp-select", "");

        const preview = document.createElement("button");
        preview.className = "sp-btn sp-btn--ghost";
        preview.setAttribute("data-sp-preview", "");
        preview.textContent = "Preview";

        root.appendChild(label);
        root.appendChild(sel);
        root.appendChild(preview);
        container.appendChild(root);

        this._el = root;
        this._sel = sel;

        let list = [];
        if (window.bhai && window.bhai.setupListVoices) {
            try { list = await window.bhai.setupListVoices(); }
            catch { list = []; }
        }
        const grouped = groupVoicesByBackend(list);
        grouped.labels.forEach(function (backend) {
            const grp = document.createElement("optgroup");
            grp.setAttribute("label", backend);
            (grouped.byBackend[backend] || []).forEach(function (v) {
                const opt = document.createElement("option");
                opt.value = backend + "::" + v;
                opt.textContent = v;
                grp.appendChild(opt);
            });
            sel.appendChild(grp);
        });

        const self = this;
        preview.addEventListener("click", function () { self._preview(); });
        sel.addEventListener("change", function () {
            if (typeof self.props.onChange === "function") {
                const parts = (sel.value || "").split("::");
                if (parts.length === 2) self.props.onChange({ backend: parts[0], name: parts[1] });
            }
        });

        return this;
    };

    VoicePicker.prototype._preview = async function () {
        if (!this._sel || !this._sel.value) return;
        const parts = this._sel.value.split("::");
        if (parts.length !== 2) return;
        const backend = parts[0];
        const name = parts[1];
        if (!window.bhai || !window.bhai.setupPreviewVoice) return;
        let res;
        try { res = await window.bhai.setupPreviewVoice(backend, name); }
        catch { return; }
        if (!res || !res.ok || !res.url) return;
        if (this._audio) { try { this._audio.pause(); } catch {} }
        this._audio = new Audio(res.url);
        this._audio.play().catch(function () {});
    };

    VoicePicker.prototype.getValue = function () {
        if (!this._sel || !this._sel.value) return null;
        const parts = this._sel.value.split("::");
        if (parts.length !== 2) return null;
        return { backend: parts[0], name: parts[1] };
    };

    VoicePicker.prototype.unmount = function () {
        if (this._audio) { try { this._audio.pause(); } catch {} this._audio = null; }
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
        this._el = null;
        this._sel = null;
    };

    if (typeof window !== "undefined") {
        window.SetupComponents = window.SetupComponents || {};
        window.SetupComponents.VoicePicker = VoicePicker;
    }
    if (typeof module !== "undefined") {
        module.exports = { groupVoicesByBackend, VoicePicker };
    }
})();
