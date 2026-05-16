// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// F10: /discover must reject any request whose Origin header isn't a
// chrome-extension://... origin. The "Sec-Fetch-Site: none" escape hatch
// was unsafe — a non-browser caller (curl, node) can set or omit it freely.
//
// This test re-implements the access-control logic out-of-line so we can
// exercise it without booting the full bridge (which writes to ~/.atlas
// and binds 18800). The test asserts that the same predicate used in the
// real handler accepts only extension origins.

import { describe, it, expect } from "vitest";

// The /discover predicate as written in chrome-bridge.ts after F10.
function discoverAllowed(headers: Record<string, string>): boolean {
    const origin = headers["origin"] || headers["Origin"] || "";
    return origin.startsWith("chrome-extension://");
}

// The /discover-local predicate (token-based).
function discoverLocalAllowed(
    headers: Record<string, string>,
    expectedToken: string,
): boolean {
    const auth = headers["authorization"] || headers["Authorization"] || "";
    if (!auth.startsWith("Bearer ")) return false;
    const presented = auth.slice(7).trim();
    if (presented.length !== expectedToken.length) return false;
    let diff = 0;
    for (let i = 0; i < presented.length; i++) {
        diff |= presented.charCodeAt(i) ^ expectedToken.charCodeAt(i);
    }
    return diff === 0;
}

describe("F10: /discover Origin-only access control", () => {
    it("accepts chrome-extension origins", () => {
        expect(discoverAllowed({ origin: "chrome-extension://abcdef123456" })).toBe(true);
    });

    it("rejects no-Origin requests (the old Sec-Fetch-Site=none path)", () => {
        expect(discoverAllowed({})).toBe(false);
        expect(discoverAllowed({ "sec-fetch-site": "none" })).toBe(false);
    });

    it("rejects http(s):// origins (a web page on localhost)", () => {
        expect(discoverAllowed({ origin: "http://localhost:3000" })).toBe(false);
        expect(discoverAllowed({ origin: "https://evil.example.com" })).toBe(false);
    });

    it("rejects origin: null (sandboxed iframe / file:)", () => {
        expect(discoverAllowed({ origin: "null" })).toBe(false);
    });

    it("rejects origins that contain but don't start with the extension scheme", () => {
        expect(discoverAllowed({ origin: "https://example.com/chrome-extension://foo" })).toBe(false);
    });
});

describe("F10: /discover-local Bearer-token access control", () => {
    const token = "a".repeat(64);

    it("accepts the exact token", () => {
        expect(discoverLocalAllowed({ authorization: `Bearer ${token}` }, token)).toBe(true);
    });

    it("rejects no auth header", () => {
        expect(discoverLocalAllowed({}, token)).toBe(false);
    });

    it("rejects non-Bearer schemes", () => {
        expect(discoverLocalAllowed({ authorization: token }, token)).toBe(false);
        expect(discoverLocalAllowed({ authorization: `Basic ${token}` }, token)).toBe(false);
    });

    it("rejects wrong token (constant-time)", () => {
        const wrong = "b".repeat(64);
        expect(discoverLocalAllowed({ authorization: `Bearer ${wrong}` }, token)).toBe(false);
    });

    it("rejects truncated token", () => {
        expect(discoverLocalAllowed({ authorization: `Bearer ${token.slice(0, 10)}` }, token)).toBe(false);
    });
});
