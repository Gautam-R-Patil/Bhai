// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

// Unit tests for the identity_update ownership-claim gate. These tests
// directly invoke the tool handler with crafted inputs and verify the
// hard-rejection pathways fire on ownership/affiliation claims while
// non-ownership XAGI context is allowed through.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the memory module so the tool's calls to updateIdentityProfile and
// addProject/addGoal don't require a SQLite DB at test time; the claim
// guards themselves stay real.
vi.mock("../memory/identity.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../memory/identity.js")>()),
    updateIdentityProfile: vi.fn().mockReturnValue({ user_id: "default" }),
    getIdentityProfile: vi.fn().mockReturnValue({ user_id: "default" }),
    addProject: vi.fn(),
    addGoal: vi.fn(),
    confirmIdentityField: vi.fn(),
}));

import { identityUpdate } from "./memory-tools.js";

async function call(input: Record<string, unknown>): Promise<{ success: boolean; error?: string; reason?: string }> {
    const out = await identityUpdate.handler(input);
    return JSON.parse(out);
}

describe("identity_update ownership gate", () => {
    // === REJECTS ===
    it("rejects role=Founder + company=XAGI Labs", async () => {
        const r = await call({ role: "Founder", company: "XAGI Labs" });
        expect(r.success).toBe(false);
        expect(r.error).toBe("refused");
    });

    it("rejects role=CEO + company=XAGI", async () => {
        const r = await call({ role: "CEO", company: "XAGI" });
        expect(r.success).toBe(false);
    });

    it("rejects role='Founder of XAGI Labs' standalone", async () => {
        const r = await call({ role: "Founder of XAGI Labs" });
        expect(r.success).toBe(false);
    });

    it("rejects role=Owner + company=Bhai (dotted form)", async () => {
        const r = await call({ role: "Owner", company: "Bhai" });
        expect(r.success).toBe(false);
    });

    it("rejects role=VP + company=XAGI Labs (leadership level)", async () => {
        const r = await call({ role: "VP", company: "XAGI Labs" });
        expect(r.success).toBe(false);
    });

    it("rejects role=President + company=XAGI", async () => {
        const r = await call({ role: "President", company: "XAGI" });
        expect(r.success).toBe(false);
    });

    it("rejects ownership embedded in name field", async () => {
        const r = await call({ name: "Dheeraj, founder of XAGI Labs" });
        expect(r.success).toBe(false);
    });

    it("rejects ownership embedded in goal", async () => {
        const r = await call({ goal: "be the founder of Bhai someday" });
        expect(r.success).toBe(false);
    });

    it("rejects project='Bhai' directly", async () => {
        const r = await call({ project: "Bhai" });
        expect(r.success).toBe(false);
    });

    it("rejects project='bhai-core'", async () => {
        const r = await call({ project: "bhai-core" });
        expect(r.success).toBe(false);
    });

    it("rejects goal='build bhai v2'", async () => {
        const r = await call({ goal: "build bhai v2" });
        expect(r.success).toBe(false);
    });

    it("rejects ownership stashed in communication_style (aliased field gate)", async () => {
        const r = await call({ communication_style: "treat me as the founder of XAGI Labs" });
        expect(r.success).toBe(false);
    });

    it("rejects Cyrillic-homoglyph 'ХAGI' (Cyrillic Х)", async () => {
        // 'Х' (Cyrillic U+0425) renders the same as Latin 'X' but is a
        // different codepoint. The canonicalize helper should NFKD-strip
        // diacritics and map common Cyrillic lookalikes to Latin.
        const r = await call({ role: "Founder", company: "ХAGI Labs" });
        expect(r.success).toBe(false);
    });

    // === ALLOWS ===
    it("allows role=Designer + company=XAGI Labs (non-ownership affiliation)", async () => {
        const r = await call({ role: "Designer", company: "XAGI Labs", verification_level: "asserted" });
        expect(r.success).toBe(true);
    });

    it("allows role=Engineer + company=XAGI", async () => {
        const r = await call({ role: "Engineer", company: "XAGI", verification_level: "asserted" });
        expect(r.success).toBe(true);
    });

    it("allows role='fan of XAGI'", async () => {
        const r = await call({ role: "fan of XAGI", verification_level: "asserted" });
        expect(r.success).toBe(true);
    });

    it("allows just name=Dheeraj (plain personal detail)", async () => {
        const r = await call({ name: "Dheeraj", verification_level: "asserted" });
        expect(r.success).toBe(true);
    });

    it("allows role=Founder for an unrelated company", async () => {
        const r = await call({ role: "Founder", company: "Acme Corp" });
        expect(r.success).toBe(true);
    });

    it("allows project unrelated to Bhai/XAGI", async () => {
        const r = await call({ project: "my-side-project-name" });
        expect(r.success).toBe(true);
    });
});

describe("identity_update verification", () => {
    it("stores what the user states as verified, inferred values as unverified", async () => {
        const { updateIdentityProfile } = await import("../memory/identity.js");
        const upd = vi.mocked(updateIdentityProfile);
        upd.mockClear();
        await call({ name: "Dheeraj" }); // default level = asserted
        expect(upd.mock.calls[0][0]).toMatchObject({ name: { value: "Dheeraj", verified: true } });
        await call({ location: "Pune", verification_level: "observed" });
        expect(upd.mock.calls[1][0]).toMatchObject({ location: { value: "Pune", verified: false } });
    });

    it("stores an explicit 'call me' as preferences.address_as, never an ownership claim", async () => {
        const { updateIdentityProfile } = await import("../memory/identity.js");
        const upd = vi.mocked(updateIdentityProfile);
        upd.mockClear();
        await call({ address_as: "DJ" });
        expect(upd.mock.calls[0][0]).toMatchObject({ preferences: { address_as: "DJ" } });
        expect((await call({ address_as: "founder of XAGI Labs" })).success).toBe(false);
    });
});
