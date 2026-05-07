// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { classifyCodingComplexity } from "./model-router.js";

describe("classifyCodingComplexity — 3-tier router", () => {
    describe("trivial (Light tier, skip design-docs)", () => {
        it.each([
            "add a console.log here",
            "fix the typo in line 12",
            "rename foo to bar",
            "bump the version to 1.2.3",
            "comment out line 50",
            "remove this console.log",
            "add a TODO comment",
            "format this file",
            "add a print statement at the top",
        ])("`%s` → trivial", (msg) => {
            expect(classifyCodingComplexity(msg)).toBe("trivial");
        });

        it("rejects trivial label if message is too long (user is giving context)", () => {
            const long = "add a console.log here because " + "lorem ipsum ".repeat(50);
            expect(classifyCodingComplexity(long)).not.toBe("trivial");
        });
    });

    describe("complex (full PRD + design-docs ceremony)", () => {
        it.each([
            "design a new authentication system from scratch",
            "build a new system to handle user uploads",
            "refactor the entire backend",
            "rewrite the whole codebase in rust",
            "architect a microservices platform",
            "implement OAuth with a proper spec and design document",
            "migrate the whole backend from Postgres to MongoDB",
            "create a greenfield event-driven pipeline",
        ])("`%s` → complex", (msg) => {
            expect(classifyCodingComplexity(msg)).toBe("complex");
        });

        it("long message + BUILD verb + high-stakes domain → complex", () => {
            const long = `We need to implement a production-ready JWT auth system for our API endpoints.
This should cover token rotation, refresh flows, device fingerprinting, session timeout,
revocation on password change, role-based access control hooks and a clean abstraction
that the downstream services can consume without knowing auth details. Please scope it out.`;
            expect(classifyCodingComplexity(long)).toBe("complex");
        });

        it("short message about auth (no BUILD verb) stays standard, not complex", () => {
            // "debug auth middleware" is standard (it's fixing something that exists)
            expect(classifyCodingComplexity("debug the auth middleware bug")).toBe("standard");
        });
    });

    describe("rename — trivial only for single-file scope", () => {
        it("'rename foo to bar' → trivial", () => {
            expect(classifyCodingComplexity("rename foo to bar")).toBe("trivial");
        });

        it("'rename foo to bar across all callers' → NOT trivial (falls through)", () => {
            // Negative lookahead kicks the classification to standard/complex;
            // multi-file intent fires via CODING_MULTIFILE_PATTERNS anyway.
            expect(classifyCodingComplexity("rename foo to bar across all callers")).not.toBe("trivial");
        });

        it("'rename foo to bar globally' → NOT trivial", () => {
            expect(classifyCodingComplexity("rename foo to bar globally")).not.toBe("trivial");
        });

        it("'rename foo to bar throughout the project' → NOT trivial", () => {
            expect(classifyCodingComplexity("rename foo to bar throughout the project")).not.toBe("trivial");
        });
    });

    describe("standard (Pro tier, no PRD)", () => {
        it.each([
            "debug this race condition in auth.ts",
            "fix the bug in my form validation",
            "add a new endpoint for /api/health",
            "write unit tests for this module",
            "optimize the database query performance",
            "integrate Stripe into the checkout flow",
            "why isn't this working",
        ])("`%s` → standard", (msg) => {
            expect(classifyCodingComplexity(msg)).toBe("standard");
        });
    });

    it("empty / whitespace → standard (safe default)", () => {
        expect(classifyCodingComplexity("")).toBe("standard");
        expect(classifyCodingComplexity("   ")).toBe("standard");
    });
});
