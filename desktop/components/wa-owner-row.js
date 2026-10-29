// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Pure HTML builder for the WhatsApp owner rows in Settings. displayName is
// the other party's WhatsApp pushName (attacker-controlled on the legacy
// whitelist path), so every owner-supplied field is escaped here to prevent
// stored XSS in the privileged panel renderer. The Remove button carries the
// jid in a data attribute instead of an inline onclick so a quote/bracket in
// the jid can't break out of the handler string.
(function () {
    "use strict";

    function esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function ownerRowsHtml(owners) {
        if (!Array.isArray(owners)) return "";
        return owners.map(function (owner) {
            const o = owner || {};
            const name = esc(o.displayName || o.phoneNumber || o.jid);
            const phone = esc(o.phoneNumber || "");
            const jid = esc(o.jid || "");
            return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-control);border:1px solid var(--separator);border-radius:8px;margin:4px 0;">'
                + '<div>'
                + '<span style="font-weight:600;font-size:13px;">' + name + '</span>'
                + '<span style="font-size:11px;color:var(--text-muted);margin-left:8px;">' + phone + '</span>'
                + '</div>'
                + '<button class="wizard-btn wizard-btn-secondary" style="padding:4px 10px;font-size:11px;" data-wa-remove-jid="' + jid + '">Remove</button>'
                + '</div>';
        }).join("");
    }

    const api = { ownerRowsHtml: ownerRowsHtml, escapeOwnerField: esc };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") window.WaOwnerRow = api;
})();
