// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { detectStuckPattern, hashToolCall } from "./sub-agent.js";

describe("detectStuckPattern — oscillating (multi-step) cycles", () => {
    it("flags an A,B,A,B,A loop as critical (same calls, same results)", () => {
        const a = hashToolCall("read", '{"f":"a"}', "contents-a");
        const b = hashToolCall("read", '{"f":"b"}', "contents-b");
        expect(detectStuckPattern([a, b, a, b, a])).toEqual("critical");
    });

    it("still flags a single repeated call as critical", () => {
        const a = hashToolCall("read", '{"f":"a"}', "same");
        expect(detectStuckPattern([a, a, a, a, a])).toEqual("critical");
    });
});

describe("detectStuckPattern — legitimate polling is not force-exited", () => {
    it("same call with a changing result is NOT flagged (productive wait)", () => {
        const args = '{"id":"x"}';
        const poll = (r: string) => hashToolCall("get_job_status", args, r);
        const history = [
            poll("pending 10%"),
            poll("pending 40%"),
            poll("pending 70%"),
            poll("pending 90%"),
            poll("done"),
        ];
        expect(detectStuckPattern(history)).toEqual("none");
    });
});
