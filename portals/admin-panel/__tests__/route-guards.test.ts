// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// F12: every state-changing admin route must reject cross-origin requests.
// guard() composes the origin allowlist; we test the underlying predicate
// here. The /api/admin/integrations route now calls guard() instead of
// inline getSession(), so this check is enforced for it.

import { describe, it, expect } from "vitest";
import { originAllowed, bodySizeOk } from "../src/lib/route-guards";

function makeReq(headers: Record<string, string>, urlOrigin = "https://admin.tryatlasagi.com"): any {
    const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
        headers: { get: (k: string) => headerMap.get(k.toLowerCase()) ?? null },
        nextUrl: { origin: urlOrigin },
    };
}

describe("F12: route-guards.originAllowed", () => {
    it("accepts same-origin requests", () => {
        const r = makeReq({ origin: "https://admin.tryatlasagi.com" });
        expect(originAllowed(r)).toBe(true);
    });

    it("accepts requests with no Origin (same-origin fetches often omit)", () => {
        const r = makeReq({});
        expect(originAllowed(r)).toBe(true);
    });

    it("rejects a different host", () => {
        const r = makeReq({ origin: "https://evil.example.com" });
        expect(originAllowed(r)).toBe(false);
    });

    it("rejects a different port on the same host", () => {
        const r = makeReq({ origin: "https://admin.tryatlasagi.com:8443" });
        expect(originAllowed(r)).toBe(false);
    });

    it("rejects malformed origins", () => {
        const r = makeReq({ origin: "not a url" });
        expect(originAllowed(r)).toBe(false);
    });
});

describe("F12: route-guards.bodySizeOk", () => {
    it("accepts requests with no Content-Length", () => {
        const r = makeReq({});
        expect(bodySizeOk(r)).toBe(true);
    });

    it("accepts requests at or below the cap", () => {
        expect(bodySizeOk(makeReq({ "content-length": "1024" }))).toBe(true);
        expect(bodySizeOk(makeReq({ "content-length": "64000" }))).toBe(true);
    });

    it("rejects requests above the cap", () => {
        expect(bodySizeOk(makeReq({ "content-length": "1000000" }))).toBe(false);
    });

    it("rejects non-numeric Content-Length", () => {
        expect(bodySizeOk(makeReq({ "content-length": "abc" }))).toBe(false);
    });
});
