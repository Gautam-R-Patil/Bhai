// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi } from "vitest";
import { executeApprovedIntent } from "./executor.js";

const okExec = (payload = "ok") => vi.fn().mockResolvedValue(JSON.stringify({ result: payload }));
const errorExec = (msg: string) => vi.fn().mockResolvedValue(JSON.stringify({ error: msg }));
const throwExec = (msg: string) => vi.fn().mockRejectedValue(new Error(msg));

describe("executeApprovedIntent", () => {
    it("empty toolCalls → done with zero-count summary", async () => {
        const exec = vi.fn();
        const r = await executeApprovedIntent([], { executeTool: exec });
        expect(r.status).toBe("done");
        expect(r.summary).toMatch(/no tool calls/i);
        expect(r.perCallResults).toEqual([]);
        expect(exec).not.toHaveBeenCalled();
    });

    it("single successful tool call", async () => {
        const exec = okExec("hi");
        const r = await executeApprovedIntent(
            [{ toolName: "greet", args: { who: "world" } }],
            { executeTool: exec },
        );
        expect(r.status).toBe("done");
        expect(r.summary).toMatch(/greet/);
        expect(r.perCallResults).toHaveLength(1);
        expect(r.perCallResults[0].ok).toBe(true);
        expect(exec).toHaveBeenCalledWith("greet", { who: "world" });
    });

    it("multiple successful tool calls run in order", async () => {
        const log: string[] = [];
        const exec = vi.fn(async (name: string) => {
            log.push(name);
            return JSON.stringify({ result: "ok" });
        });
        await executeApprovedIntent(
            [
                { toolName: "first", args: {} },
                { toolName: "second", args: {} },
                { toolName: "third", args: {} },
            ],
            { executeTool: exec },
        );
        expect(log).toEqual(["first", "second", "third"]);
    });

    it("short-circuits on first error (error-JSON response)", async () => {
        const exec = vi.fn()
            .mockResolvedValueOnce(JSON.stringify({ result: "ok" }))
            .mockResolvedValueOnce(JSON.stringify({ error: "broken" }))
            .mockResolvedValueOnce(JSON.stringify({ result: "should not run" }));
        const r = await executeApprovedIntent(
            [
                { toolName: "a", args: {} },
                { toolName: "b", args: {} },
                { toolName: "c", args: {} },
            ],
            { executeTool: exec },
        );
        expect(r.status).toBe("failed");
        expect(r.summary).toMatch(/b:/);
        expect(r.summary).toMatch(/broken/);
        expect(exec).toHaveBeenCalledTimes(2);
        expect(r.perCallResults).toHaveLength(2);
        expect(r.perCallResults[0].ok).toBe(true);
        expect(r.perCallResults[1].ok).toBe(false);
    });

    it("short-circuits on thrown exception", async () => {
        const exec = throwExec("crash");
        const r = await executeApprovedIntent(
            [{ toolName: "a", args: {} }],
            { executeTool: exec },
        );
        expect(r.status).toBe("failed");
        expect(r.summary).toMatch(/crash/);
    });

    it("output is truncated to ~500 chars", async () => {
        const big = "x".repeat(2000);
        const exec = vi.fn().mockResolvedValue(JSON.stringify({ result: big }));
        const r = await executeApprovedIntent(
            [{ toolName: "a", args: {} }],
            { executeTool: exec },
        );
        expect(r.perCallResults[0].output!.length).toBeLessThanOrEqual(500);
    });

    it("non-JSON string output is treated as success (not error)", async () => {
        const exec = vi.fn().mockResolvedValue("plaintext output");
        const r = await executeApprovedIntent(
            [{ toolName: "a", args: {} }],
            { executeTool: exec },
        );
        expect(r.status).toBe("done");
        expect(r.perCallResults[0].ok).toBe(true);
    });

    it("single-call summary names the tool", async () => {
        const exec = okExec();
        const r = await executeApprovedIntent(
            [{ toolName: "send_email", args: {} }],
            { executeTool: exec },
        );
        expect(r.summary).toBe("Done with send_email.");
    });

    it("multi-call summary is plural", async () => {
        const exec = okExec();
        const r = await executeApprovedIntent(
            [
                { toolName: "a", args: {} },
                { toolName: "b", args: {} },
            ],
            { executeTool: exec },
        );
        expect(r.summary).toMatch(/2 tool calls/);
    });
});
