// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { intentFromThought } from "./intent-from-thought.js";

describe("intentFromThought adapter", () => {
    it("wraps a legacy thought string as a memory_anticipation intent", () => {
        const i = intentFromThought("the user has been away", { hourNow: 10 });
        expect(i.source).toBe("memory_anticipation");
        expect(i.mode).toBe("fyi");
        expect(i.payload.kind).toBe("memory_anticipation");
        expect(i.payload.hint).toBe("the user has been away");
    });

    it("produces 384-length topic embedding placeholder", () => {
        const i = intentFromThought("x", { hourNow: 10 });
        expect(i.topicEmbedding.length).toBe(384);
    });

    it("unique id per call", () => {
        const a = intentFromThought("x", { hourNow: 10 });
        const b = intentFromThought("x", { hourNow: 10 });
        expect(a.id).not.toBe(b.id);
    });

    it("topic is first 80 chars of the thought", () => {
        const long = "a".repeat(200);
        const i = intentFromThought(long, { hourNow: 10 });
        expect(i.topic.length).toBe(80);
    });
});
