// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// F1 + F2 unit tests. The actual Electron handlers are integration-level
// (require the BrowserWindow + http.createServer wiring), so the path
// containment + OAuth state logic is exported as pure functions in
// auth-helpers.js and verified here.

import { describe, it, expect } from "vitest";
import path from "node:path";
import {
    isPathContained,
    generateOAuthState,
    safeStringEqual,
} from "../auth-helpers.js";

describe("F1: path-traversal containment (isPathContained)", () => {
    const sep = path.sep;
    const root = path.resolve("/tmp/desktop");

    it("accepts files inside the root", () => {
        expect(isPathContained(root, path.resolve("/tmp/desktop/panel.html"), sep)).toBe(true);
        expect(isPathContained(root, path.resolve("/tmp/desktop/pages/wizard.html"), sep)).toBe(true);
    });

    it("accepts the root itself (e.g. a directory listing)", () => {
        expect(isPathContained(root, root, sep)).toBe(true);
    });

    it("rejects parent-directory traversal", () => {
        const traversed = path.resolve("/tmp/desktop/../../etc/passwd");
        expect(isPathContained(root, traversed, sep)).toBe(false);
    });

    it("rejects siblings with a common prefix", () => {
        // /tmp/desktop-backup is NOT inside /tmp/desktop even though it starts with the same string.
        expect(isPathContained(root, path.resolve("/tmp/desktop-backup/x"), sep)).toBe(false);
    });

    it("rejects non-string inputs", () => {
        expect(isPathContained(null, "/tmp/desktop", sep)).toBe(false);
        expect(isPathContained(root, null, sep)).toBe(false);
    });
});

describe("F2: OAuth state generation + validation", () => {
    it("generates a 64-char hex string (32 random bytes)", () => {
        const s = generateOAuthState();
        expect(s).toMatch(/^[a-f0-9]{64}$/);
    });

    it("generates unpredictable values (no collisions in 1000 samples)", () => {
        const seen = new Set();
        for (let i = 0; i < 1000; i++) seen.add(generateOAuthState());
        expect(seen.size).toBe(1000);
    });

    it("validates state with constant-time compare", () => {
        const state = generateOAuthState();
        expect(safeStringEqual(state, state)).toBe(true);
        expect(safeStringEqual(state, state.slice(0, -1) + "X")).toBe(false);
    });

    it("rejects length mismatch", () => {
        expect(safeStringEqual("aaaa", "aaaaa")).toBe(false);
        expect(safeStringEqual("", "x")).toBe(false);
    });

    it("rejects non-string inputs", () => {
        expect(safeStringEqual(null, "abc")).toBe(false);
        expect(safeStringEqual("abc", undefined)).toBe(false);
        expect(safeStringEqual(123, 123)).toBe(false);
    });
});
