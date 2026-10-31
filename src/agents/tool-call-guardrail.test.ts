// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, afterEach } from "vitest";
import {
    canonicalArgsHash,
    canonicalArgsJson,
    createGuardrailState,
    recordToolCall,
    resetGuardrail,
} from "./tool-call-guardrail.js";

describe("canonicalArgsHash", () => {
    it("is order-independent over object keys", () => {
        expect(canonicalArgsHash("t", { a: 1, b: 2 })).toBe(canonicalArgsHash("t", { b: 2, a: 1 }));
    });
    it("is nested-order-independent", () => {
        expect(canonicalArgsJson({ x: { p: 1, q: 2 } })).toBe(canonicalArgsJson({ x: { q: 2, p: 1 } }));
    });
    it("differs on different args or tool name", () => {
        expect(canonicalArgsHash("t", { a: 1 })).not.toBe(canonicalArgsHash("t", { a: 2 }));
        expect(canonicalArgsHash("t1", { a: 1 })).not.toBe(canonicalArgsHash("t2", { a: 1 }));
    });
    it("handles arrays and primitives without throwing", () => {
        expect(() => canonicalArgsJson([1, "x", null, { a: 1 }])).not.toThrow();
        expect(canonicalArgsJson(null)).toBe("null");
    });
});

describe("tool-call guardrail", () => {
    afterEach(() => {
        delete process.env.BHAI_TOOL_LOOP_HARDSTOP;
    });

    it("stays silent on first failure, warns on the second identical failure", () => {
        const s = createGuardrailState();
        const args = { cmd: "ls /nope" };
        const v1 = recordToolCall(s, { fnName: "shell", fnArgs: args, isError: true });
        expect(v1.hint).toBeNull();
        const v2 = recordToolCall(s, { fnName: "shell", fnArgs: args, isError: true });
        expect(v2.hint).toContain("shell");
        expect(v2.failureCount).toBe(2);
    });

    it("nudges only once per threshold cross (no spam)", () => {
        const s = createGuardrailState();
        const args = { cmd: "x" };
        recordToolCall(s, { fnName: "shell", fnArgs: args, isError: true });
        const v2 = recordToolCall(s, { fnName: "shell", fnArgs: args, isError: true });
        const v3 = recordToolCall(s, { fnName: "shell", fnArgs: args, isError: true });
        expect(v2.hint).not.toBeNull();
        expect(v3.hint).toBeNull(); // already hinted for this key
    });

    it("a success with the same args resets the failure streak", () => {
        const s = createGuardrailState();
        const args = { cmd: "x" };
        recordToolCall(s, { fnName: "shell", fnArgs: args, isError: true });
        recordToolCall(s, { fnName: "shell", fnArgs: args, isError: false });
        const after = recordToolCall(s, { fnName: "shell", fnArgs: args, isError: true });
        expect(after.failureCount).toBe(1);
        expect(after.hint).toBeNull();
    });

    it("does not conflate different args of the same tool", () => {
        const s = createGuardrailState();
        recordToolCall(s, { fnName: "shell", fnArgs: { cmd: "a" }, isError: true });
        const v = recordToolCall(s, { fnName: "shell", fnArgs: { cmd: "b" }, isError: true });
        expect(v.failureCount).toBe(1); // independent key
        expect(v.hint).toBeNull();
    });

    it("hard-stops only when opted in and limit reached", () => {
        process.env.BHAI_TOOL_LOOP_HARDSTOP = "true";
        const s = createGuardrailState();
        const args = { cmd: "x" };
        let last = recordToolCall(s, { fnName: "shell", fnArgs: args, isError: true });
        for (let i = 0; i < 5; i++) {
            last = recordToolCall(s, { fnName: "shell", fnArgs: args, isError: true });
        }
        expect(last.hardStop).toBe(true);
    });

    it("never hard-stops when the env flag is off", () => {
        const s = createGuardrailState();
        const args = { cmd: "x" };
        let last = recordToolCall(s, { fnName: "shell", fnArgs: args, isError: true });
        for (let i = 0; i < 10; i++) {
            last = recordToolCall(s, { fnName: "shell", fnArgs: args, isError: true });
        }
        expect(last.hardStop).toBe(false);
    });

    it("resetGuardrail clears all per-turn state", () => {
        const s = createGuardrailState();
        recordToolCall(s, { fnName: "shell", fnArgs: { cmd: "x" }, isError: true });
        resetGuardrail(s);
        const v = recordToolCall(s, { fnName: "shell", fnArgs: { cmd: "x" }, isError: true });
        expect(v.failureCount).toBe(1);
    });
});
