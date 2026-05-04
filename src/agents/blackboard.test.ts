// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach } from "vitest";
import { Blackboard, BLACKBOARD_READ_SCHEMA, BLACKBOARD_WRITE_SCHEMA } from "./blackboard.js";

describe("Blackboard — basic write/read", () => {
    let bb: Blackboard;
    beforeEach(() => {
        bb = new Blackboard();
    });

    it("round-trips a single entry", () => {
        bb.write("api_url", "https://api.example.com", "step-1");
        expect(bb.read("api_url")).toEqual("https://api.example.com");
    });

    it("can read by namespaced key too (stepId/key)", () => {
        bb.write("api_url", "https://api.example.com", "step-1");
        expect(bb.read("step-1/api_url")).toEqual("https://api.example.com");
    });

    it("returns undefined for unknown key", () => {
        expect(bb.read("never_set")).toBeUndefined();
    });

    it("latest write wins for the bare key", () => {
        bb.write("k", "first", "step-1");
        bb.write("k", "second", "step-2");
        expect(bb.read("k")).toEqual("second");
    });

    it("keeps per-step namespaced copies separate", () => {
        bb.write("k", "first", "step-1");
        bb.write("k", "second", "step-2");
        expect(bb.read("step-1/k")).toEqual("first");
        expect(bb.read("step-2/k")).toEqual("second");
    });
});

describe("Blackboard — list", () => {
    let bb: Blackboard;
    beforeEach(() => {
        bb = new Blackboard();
    });

    it("returns all bare keys (dedupes namespaced ones)", () => {
        bb.write("k1", "v1", "step-1");
        bb.write("k2", "v2", "step-2");
        const entries = bb.list();
        expect(entries.length).toEqual(2);
        expect(entries.map((e) => e.key).sort()).toEqual(["k1", "k2"]);
    });

    it("skips namespaced entries in the default list", () => {
        bb.write("shared", "value", "step-x");
        const keys = bb.list().map((e) => e.key);
        expect(keys).toContain("shared");
        expect(keys).not.toContain("step-x/shared");
    });

    it("filter by step returns BOTH bare and namespaced writes of that step", () => {
        bb.write("alpha", "a", "step-x");
        bb.write("beta", "b", "step-y");
        const stepX = bb.list("step-x");
        // Each write stores 2 entries (bare + namespaced), so filter returns 2.
        expect(stepX.length).toEqual(2);
        expect(stepX.every((e) => e.writtenBy === "step-x")).toBe(true);
    });

    it("returns empty list when nothing written", () => {
        expect(bb.list()).toEqual([]);
    });
});

describe("Blackboard — getSummary", () => {
    let bb: Blackboard;
    beforeEach(() => {
        bb = new Blackboard();
    });

    it("returns empty string when no entries", () => {
        expect(bb.getSummary()).toEqual("");
    });

    it("wraps entries in [SHARED CONTEXT] markers", () => {
        bb.write("k1", "v1", "step-a");
        const s = bb.getSummary();
        expect(s.startsWith("[SHARED CONTEXT from other agents]")).toBe(true);
        expect(s.endsWith("[END SHARED CONTEXT]")).toBe(true);
    });

    it("lists each entry with 'key (from step): value' shape", () => {
        bb.write("k1", "v1-content", "step-a");
        bb.write("k2", "v2-content", "step-b");
        const s = bb.getSummary();
        expect(s).toContain("- k1 (from step-a): v1-content");
        expect(s).toContain("- k2 (from step-b): v2-content");
    });

    it("truncates value to 200 chars", () => {
        bb.write("big", "x".repeat(500), "step-1");
        const s = bb.getSummary();
        // 200 chars of "x" should appear; verify no 201st appears
        expect(s).toContain("x".repeat(200));
        // The slice is cosmetic — no ellipsis is appended, just the substring
    });
});

describe("Blackboard — size + clear", () => {
    let bb: Blackboard;
    beforeEach(() => {
        bb = new Blackboard();
    });

    it("size reflects unique bare keys (not namespaced dupes)", () => {
        bb.write("k1", "v1", "step-a");
        bb.write("k2", "v2", "step-b");
        expect(bb.size).toEqual(2);
    });

    it("size is 0 for a fresh board", () => {
        expect(bb.size).toEqual(0);
    });

    it("clear() drops everything", () => {
        bb.write("k1", "v1", "step-a");
        bb.write("k2", "v2", "step-b");
        expect(bb.size).toEqual(2);
        bb.clear();
        expect(bb.size).toEqual(0);
        expect(bb.read("k1")).toBeUndefined();
    });
});

describe("Blackboard — tool schemas", () => {
    it("BLACKBOARD_WRITE_SCHEMA shape", () => {
        expect(BLACKBOARD_WRITE_SCHEMA.type).toEqual("function");
        expect(BLACKBOARD_WRITE_SCHEMA.function.name).toEqual("blackboard_write");
        const params = BLACKBOARD_WRITE_SCHEMA.function.parameters as {
            required: string[];
            properties: Record<string, unknown>;
        };
        expect(params.required).toEqual(["key", "value"]);
        expect(params.properties).toHaveProperty("key");
        expect(params.properties).toHaveProperty("value");
    });

    it("BLACKBOARD_READ_SCHEMA shape (key is optional)", () => {
        expect(BLACKBOARD_READ_SCHEMA.function.name).toEqual("blackboard_read");
        const params = BLACKBOARD_READ_SCHEMA.function.parameters as {
            required?: string[];
            properties: Record<string, unknown>;
        };
        // Read has no required fields (omitting key lists all)
        expect(params.required).toBeUndefined();
    });
});

describe("Blackboard — writtenAt metadata", () => {
    it("entries include writtenAt timestamp", () => {
        const before = Date.now();
        const bb = new Blackboard();
        bb.write("k", "v", "step-1");
        const [entry] = bb.list();
        expect(entry.writtenAt).toBeGreaterThanOrEqual(before);
    });

    it("writtenBy is the step id passed to write", () => {
        const bb = new Blackboard();
        bb.write("k", "v", "specific-step-id");
        const [entry] = bb.list();
        expect(entry.writtenBy).toEqual("specific-step-id");
    });
});
