// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";

    function validateTelegramToken(s) { return typeof s === "string" && /^\d+:[A-Za-z0-9_-]{35,}$/.test(s); }
    function validateDiscordToken(s) { return typeof s === "string" && s.length >= 50 && /^[A-Za-z0-9._-]+$/.test(s); }
    function validateMatrixHomeserver(s) {
        if (typeof s !== "string" || !s) return false;
        try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; }
        catch { return false; }
    }
    function validateEmailConfig(c) {
        if (!c) return false;
        const strKeys = ["imapHost", "smtpHost", "user", "password"];
        for (let i = 0; i < strKeys.length; i++) {
            if (typeof c[strKeys[i]] !== "string" || !c[strKeys[i]]) return false;
        }
        if (typeof c.imapPort !== "number" || Number.isNaN(c.imapPort)) return false;
        if (typeof c.smtpPort !== "number" || Number.isNaN(c.smtpPort)) return false;
        return true;
    }
    function canSaveWithTestId(id, pendingTests, nowMs) {
        if (!id || !pendingTests || typeof pendingTests[id] !== "number") return false;
        return (nowMs - pendingTests[id]) <= 60000;
    }

    const VALIDATORS = {
        telegram: function (c) { return validateTelegramToken(c && c.token) && typeof c.allowedIds === "string" && c.allowedIds.length > 0; },
        discord:  function (c) { return validateDiscordToken(c && c.token); },
        matrix:   function (c) { return validateMatrixHomeserver(c && c.homeserver) && typeof c.token === "string" && c.token.length > 0; },
        email:    validateEmailConfig,
        slack:    function () { return true; },
        whatsapp: function () { return true; },
    };

    // ── DOM helpers (no innerHTML) ─────────────────
    function el(tag, attrs, text) {
        const n = document.createElement(tag);
        if (attrs) {
            for (const k in attrs) {
                if (k === "className") n.className = attrs[k];
                else if (k.slice(0, 2) === "on" && typeof attrs[k] === "function") n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
                else n.setAttribute(k, attrs[k]);
            }
        }
        if (text != null) n.textContent = text;
        return n;
    }
    function labeledInput(labelText, fieldName, type, placeholder, defaultValue) {
        const label = el("label", {}, null);
        const labelTextNode = document.createElement("div");
        labelTextNode.textContent = labelText;
        const input = el("input", { "data-sp-field": fieldName });
        input.type = type || "text";
        if (placeholder) input.placeholder = placeholder;
        if (defaultValue != null) input.value = defaultValue;
        if (type === "password") input.autocomplete = "off";
        label.appendChild(labelTextNode);
        label.appendChild(input);
        return label;
    }

    function ChannelCard(props) {
        this.props = props || {};
        this._el = null;
        this._form = null;
        this._status = null;
        this._testId = null;
        this._creds = null;
    }

    ChannelCard.prototype.mount = function (container) {
        if (!container) throw new Error("ChannelCard.mount: container is required");
        const type = this.props.type;
        const root = el("div", { className: "sp-channel" });
        const title = el("div", { className: "sp-channel__title", "data-sp-title": "" }, type.charAt(0).toUpperCase() + type.slice(1));
        const form = el("div", { className: "sp-channel__form", "data-sp-form": "" });
        const status = el("div", { className: "sp-channel__status", "data-sp-status": "" });
        status.style.display = "none";
        const actions = el("div", { className: "sp-channel__actions", "data-sp-actions": "" });
        root.appendChild(title);
        root.appendChild(form);
        root.appendChild(status);
        root.appendChild(actions);
        this._el = root;
        this._form = form;
        this._status = status;
        container.appendChild(root);
        this._renderForm(type, form);
        this._renderActions(type, actions);
        return this;
    };

    ChannelCard.prototype._renderForm = function (type, form) {
        if (type === "telegram") {
            form.appendChild(labeledInput("Bot token", "token", "password"));
            form.appendChild(labeledInput("Allowed user IDs (comma-separated)", "allowedIds", "text"));
        } else if (type === "discord") {
            form.appendChild(labeledInput("Bot token", "token", "password"));
        } else if (type === "matrix") {
            form.appendChild(labeledInput("Homeserver URL", "homeserver", "text", "https://matrix.org"));
            form.appendChild(labeledInput("Access token", "token", "password"));
        } else if (type === "email") {
            const presetLabel = el("label");
            const presetTxt = el("div", {}, "Preset");
            const presetSel = el("select", { "data-sp-field": "preset" });
            [["", "Custom"], ["gmail", "Gmail"], ["outlook", "Outlook"]].forEach(function (opt) {
                const option = el("option", { value: opt[0] }, opt[1]);
                presetSel.appendChild(option);
            });
            presetLabel.appendChild(presetTxt);
            presetLabel.appendChild(presetSel);
            form.appendChild(presetLabel);

            form.appendChild(labeledInput("IMAP host", "imapHost", "text"));
            form.appendChild(labeledInput("IMAP port", "imapPort", "number", null, "993"));
            form.appendChild(labeledInput("SMTP host", "smtpHost", "text"));
            form.appendChild(labeledInput("SMTP port", "smtpPort", "number", null, "587"));
            form.appendChild(labeledInput("User", "user", "email"));
            form.appendChild(labeledInput("Password", "password", "password"));

            presetSel.addEventListener("change", function (e) {
                const v = e.target.value;
                const ih = form.querySelector("[data-sp-field='imapHost']");
                const sh = form.querySelector("[data-sp-field='smtpHost']");
                const ip = form.querySelector("[data-sp-field='imapPort']");
                const sp = form.querySelector("[data-sp-field='smtpPort']");
                if (v === "gmail") {
                    ih.value = "imap.gmail.com"; sh.value = "smtp.gmail.com";
                    ip.value = "993"; sp.value = "587";
                } else if (v === "outlook") {
                    ih.value = "outlook.office365.com"; sh.value = "smtp.office365.com";
                    ip.value = "993"; sp.value = "587";
                }
            });
        } else if (type === "slack") {
            const info = el("div", {}, "Connect via Slack OAuth — Bhai will install into the workspace you choose.");
            info.style.fontSize = "13px";
            info.style.color = "var(--text-secondary, #515154)";
            form.appendChild(info);
        } else if (type === "whatsapp") {
            const qr = el("div", { className: "sp-channel__qr", "data-sp-qr": "" });
            qr.style.minHeight = "180px";
            qr.style.alignItems = "center";
            const placeholder = el("div", {}, 'Click "Generate QR" to pair your phone.');
            placeholder.style.color = "#999";
            qr.appendChild(placeholder);
            form.appendChild(qr);
        }
    };

    ChannelCard.prototype._renderActions = function (type, actions) {
        const self = this;
        if (type === "slack") {
            const btn = el("button", { className: "sp-btn" }, "Install to workspace");
            btn.addEventListener("click", function () {
                if (window.atlas && window.atlas.setupSlackOAuthStart) {
                    Promise.resolve(window.atlas.setupSlackOAuthStart()).catch(function () {});
                }
            });
            actions.appendChild(btn);
            return;
        }
        if (type === "whatsapp") {
            const btn = el("button", { className: "sp-btn" }, "Generate QR");
            btn.addEventListener("click", function () { self._startWhatsApp(); });
            actions.appendChild(btn);
            return;
        }
        const test = el("button", { className: "sp-btn sp-btn--ghost" }, "Test");
        const save = el("button", { className: "sp-btn" }, "Save");
        save.disabled = true;
        test.addEventListener("click", function () { self._onTest(type, save); });
        save.addEventListener("click", function () { self._onSave(type); });
        actions.appendChild(test);
        actions.appendChild(save);
    };

    ChannelCard.prototype._readCreds = function (type) {
        const out = {};
        this._form.querySelectorAll("[data-sp-field]").forEach(function (node) {
            const k = node.getAttribute("data-sp-field");
            let v = node.value;
            if (node.type === "number") { v = Number(v); if (Number.isNaN(v)) v = null; }
            if (node.type === "checkbox") v = node.checked;
            out[k] = v;
        });
        if (type === "email") { out.imapTls = true; out.smtpTls = true; }
        return out;
    };

    ChannelCard.prototype._setStatus = function (text, ok) {
        if (!this._status) return;
        this._status.textContent = text || "";
        this._status.className = "sp-channel__status " + (ok ? "sp-channel__status--ok" : "sp-channel__status--bad");
        this._status.style.display = text ? "block" : "none";
    };

    ChannelCard.prototype._onTest = async function (type, saveBtn) {
        const creds = this._readCreds(type);
        const ok = VALIDATORS[type](creds);
        if (!ok) { this._setStatus("Credentials look invalid — check the format.", false); return; }
        this._setStatus("Testing…", true);
        if (!window.atlas || !window.atlas.setupTestChannel) {
            this._setStatus("IPC unavailable", false); return;
        }
        let res;
        try { res = await window.atlas.setupTestChannel(type, creds); }
        catch (err) { this._setStatus("Test failed: " + (err.message || err), false); return; }
        if (res && res.ok) {
            this._testId = res.testId;
            this._creds = creds;
            saveBtn.disabled = false;
            this._setStatus("Test passed — click Save.", true);
        } else {
            saveBtn.disabled = true;
            this._setStatus((res && res.error) || ("Test failed — see docs: https://atlas.app/docs/" + type), false);
        }
    };

    ChannelCard.prototype._onSave = async function (type) {
        if (!this._testId || !this._creds) { this._setStatus("Run Test first.", false); return; }
        if (!window.atlas || !window.atlas.setupSaveChannel) {
            this._setStatus("IPC unavailable", false); return;
        }
        let res;
        try { res = await window.atlas.setupSaveChannel(type, this._creds, this._testId); }
        catch (err) { this._setStatus("Save failed: " + (err.message || err), false); return; }
        if (res && res.ok) {
            this._setStatus("Saved.", true);
            if (typeof this.props.onSaved === "function") this.props.onSaved(type);
        } else {
            this._setStatus((res && res.error) || "Save refused.", false);
        }
    };

    ChannelCard.prototype._startWhatsApp = async function () {
        if (!this._form) return;
        const qrBox = this._form.querySelector("[data-sp-qr]");
        if (!qrBox) return;

        const self = this;
        // Generation attempt counter — closures below bail out if a newer attempt started.
        self._waAttempt = (self._waAttempt || 0) + 1;
        const attempt = self._waAttempt;
        // Clear any prior timeout/state from an earlier attempt.
        if (self._waTimeout) { clearTimeout(self._waTimeout); self._waTimeout = null; }

        function stale() { return self._waAttempt !== attempt; }
        function clearBox() { while (qrBox.firstChild) qrBox.removeChild(qrBox.firstChild); }

        clearBox();
        const generating = el("div", {}, "Generating pairing\u2026");
        generating.style.color = "#666";
        qrBox.appendChild(generating);
        const hint = el("div", {}, "This usually takes 3–10 seconds.");
        hint.style.color = "#999";
        hint.style.fontSize = "12px";
        hint.style.marginTop = "6px";
        qrBox.appendChild(hint);

        function renderRetry(parent) {
            const retry = el("button", { className: "sp-btn sp-btn--ghost" }, "Try again");
            retry.style.marginTop = "12px";
            retry.addEventListener("click", function () { self._startWhatsApp(); });
            parent.appendChild(retry);
        }

        function renderQr(qrString) {
            if (stale()) return;
            if (self._waTimeout) { clearTimeout(self._waTimeout); self._waTimeout = null; }
            clearBox();
            try {
                const QR = window.QRCode || (typeof require === "function" ? require("qrcode") : null);
                if (QR && typeof QR.toCanvas === "function") {
                    const canvas = el("canvas");
                    qrBox.appendChild(canvas);
                    QR.toCanvas(canvas, qrString, { width: 220 });
                    const sub = el("div", {}, "Open WhatsApp \u2192 Settings \u2192 Linked Devices, then scan.");
                    sub.style.color = "#999";
                    sub.style.fontSize = "12px";
                    sub.style.marginTop = "10px";
                    qrBox.appendChild(sub);
                    return;
                }
            } catch { /* fall through */ }
            const code = el("code", {}, qrString);
            code.style.fontSize = "10px";
            code.style.wordBreak = "break-all";
            qrBox.appendChild(code);
        }
        function renderConnected() {
            if (stale()) return;
            if (self._waTimeout) { clearTimeout(self._waTimeout); self._waTimeout = null; }
            clearBox();
            const ok = el("div", {}, "\u2713 WhatsApp paired. Ready.");
            ok.style.color = "#10b981";
            ok.style.fontWeight = "600";
            ok.style.padding = "24px 0";
            qrBox.appendChild(ok);
            if (typeof self.props.onSaved === "function") self.props.onSaved("whatsapp");
        }
        function renderErr(msg) {
            if (stale()) return;
            if (self._waTimeout) { clearTimeout(self._waTimeout); self._waTimeout = null; }
            clearBox();
            const errEl = el("div", {}, "Couldn't pair: " + msg);
            errEl.style.color = "#f87171";
            qrBox.appendChild(errEl);
            renderRetry(qrBox);
        }
        function renderTimeout() {
            if (stale()) return;
            self._waTimeout = null;
            clearBox();
            const warn = el("div", {}, "Still waiting on WhatsApp\u2026");
            warn.style.color = "#f59e0b";
            warn.style.fontWeight = "600";
            qrBox.appendChild(warn);
            const sub = el("div", {}, "Check your internet connection and try again.");
            sub.style.color = "#999";
            sub.style.fontSize = "12px";
            sub.style.marginTop = "6px";
            qrBox.appendChild(sub);
            renderRetry(qrBox);
            // Cancel the stalled socket so the next attempt gets a fresh one.
            if (window.atlas && typeof window.atlas.setupWaPairCancel === "function") {
                Promise.resolve(window.atlas.setupWaPairCancel()).catch(function () {});
            }
        }

        // Publish this attempt's renderers so the single listener below always
        // dispatches to the ACTIVE attempt. The listener is attached once per
        // instance (preload's ipcRenderer.on accumulates), so it must not close
        // over the first attempt's locals — on retry those are stale() and
        // early-return, leaving the QR permanently blank.
        self._waRenderers = { qr: renderQr, connected: renderConnected, err: renderErr };

        // Subscribe exactly once per ChannelCard instance (preload attaches
        // with ipcRenderer.on, which accumulates — so guard here).
        if (!self._waListenerAttached && window.atlas && typeof window.atlas.onWhatsAppQR === "function") {
            window.atlas.onWhatsAppQR(function (payload) {
                const r = self._waRenderers;
                if (!r) return;
                if (payload === "connected") { r.connected(); return; }
                if (payload && typeof payload === "object" && payload.kind === "error") {
                    r.err(payload.message || "unknown"); return;
                }
                if (typeof payload === "string") r.qr(payload);
            });
            self._waListenerAttached = true;
        }

        // 15s timeout: surface an actionable message + retry if nothing arrives.
        self._waTimeout = setTimeout(renderTimeout, 15000);

        // Ask main for a fresh pair session. If a prior one is still running,
        // cancel first so we don't re-use a stuck socket.
        if (window.atlas && typeof window.atlas.setupWaPairCancel === "function") {
            try { await window.atlas.setupWaPairCancel(); } catch { /* ignore */ }
        }
        if (window.atlas && typeof window.atlas.setupWaPairStart === "function") {
            try {
                const res = await window.atlas.setupWaPairStart();
                if (res && res.ok === false) renderErr(res.error || "could not start");
            } catch (e) { renderErr(e.message || String(e)); }
        } else if (window.atlas && typeof window.atlas.waGenerateOTP === "function") {
            try { await window.atlas.waGenerateOTP(); }
            catch (e) { renderErr(e.message || String(e)); }
        } else {
            renderErr("WhatsApp pairing IPC unavailable.");
        }
    };

    ChannelCard.prototype.unmount = function () {
        if (this._waTimeout) { clearTimeout(this._waTimeout); this._waTimeout = null; }
        if (this._waAttempt) {
            this._waAttempt = 0;
            if (window.atlas && typeof window.atlas.setupWaPairCancel === "function") {
                Promise.resolve(window.atlas.setupWaPairCancel()).catch(function () {});
            }
        }
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
        this._el = null;
        this._form = null;
        this._status = null;
    };

    if (typeof window !== "undefined") {
        window.SetupComponents = window.SetupComponents || {};
        window.SetupComponents.ChannelCard = ChannelCard;
    }
    if (typeof module !== "undefined") {
        module.exports = {
            validateTelegramToken,
            validateDiscordToken,
            validateMatrixHomeserver,
            validateEmailConfig,
            canSaveWithTestId,
            ChannelCard,
        };
    }
})();
