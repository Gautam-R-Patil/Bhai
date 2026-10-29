// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Stored-XSS regression: the WhatsApp owner displayName is the other party's
// pushName (attacker-controlled), and the Settings owner list renders it into
// innerHTML. ownerRowsHtml must escape every owner-supplied field.
import { describe, it, expect } from "vitest";
import { ownerRowsHtml } from "../components/wa-owner-row.js";

describe("ownerRowsHtml — XSS hardening", () => {
    it("escapes a malicious displayName (no live markup reaches innerHTML)", () => {
        const html = ownerRowsHtml([
            { jid: "111@s.whatsapp.net", phoneNumber: "+111", displayName: '<img src=x onerror="alert(1)">' },
        ]);
        // No live markup: the tag-opening "<" and the attribute-quote '"' are
        // escaped, so the browser parses it as inert text, not an <img> element.
        expect(html).not.toContain("<img");
        expect(html).not.toContain('onerror="alert(1)">');
        expect(html).toContain("&lt;img");
    });

    it("escapes phoneNumber and jid too", () => {
        const html = ownerRowsHtml([
            { jid: '"><script>x</script>', phoneNumber: '<b>p</b>', displayName: "" },
        ]);
        expect(html).not.toContain("<script>");
        expect(html).not.toContain("<b>p</b>");
    });

    it("puts the jid in a data attribute, never an inline onclick", () => {
        const html = ownerRowsHtml([{ jid: "222@s.whatsapp.net", displayName: "Bob" }]);
        expect(html).toContain('data-wa-remove-jid="222@s.whatsapp.net"');
        expect(html).not.toContain("onclick");
    });

    it("renders the display name when safe", () => {
        const html = ownerRowsHtml([{ jid: "3@s", displayName: "Alice" }]);
        expect(html).toContain("Alice");
    });

    it("handles empty / non-array input", () => {
        expect(ownerRowsHtml([])).toBe("");
        expect(ownerRowsHtml(null)).toBe("");
    });
});
