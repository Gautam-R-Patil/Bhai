// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";

const routerMod = await import("../wizard/router.js");
const router = routerMod.default || routerMod;
const { getSteps, CURRENT_ACCEPTANCE_VERSION } = router;

const accepted = { accepted: true, version: CURRENT_ACCEPTANCE_VERSION };

describe("first run is three screens: sign in (terms inline) → connect Chrome → Ready Hub", () => {
    it("a fresh install signs in, then connects Chrome", () => {
        expect(getSteps({ platform: "darwin" }).steps).toEqual(["signin", "connect"]);
        expect(getSteps({ platform: "win32" }).steps).toEqual(["signin", "connect"]);
    });
    it("signed in with current terms: straight to connect", () => {
        expect(getSteps({ account: { signedIn: true }, legal: accepted }).steps).toEqual(["connect"]);
    });
    it("terms changed since acceptance: sign-in screen again (it carries the terms)", () => {
        expect(getSteps({ account: { signedIn: true }, legal: { accepted: true, version: "1.0.0" } }).steps).toEqual(["signin", "connect"]);
    });
    it("never more than three screens counting the Ready Hub", () => {
        for (const s of [{}, { isReconfigure: true }, { account: { signedIn: true } }]) expect(getSteps(s).steps.length + 1).toBeLessThanOrEqual(3);
    });
});
