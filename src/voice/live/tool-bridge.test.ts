// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the tool registry so executeVoiceToolCalls never loads real tools.
// Must be hoisted via vi.hoisted because vi.mock is hoisted to top of file.
const hoisted = vi.hoisted(() => ({
    executeTool: vi.fn<(name: string, args: unknown) => Promise<unknown>>(),
}));

vi.mock("../../tools/index.js", () => ({
    getToolSchemasByNames: () => [],
    executeTool: hoisted.executeTool,
}));

import { executeVoiceToolCalls, VOICE_TOOL_TIMEOUT_MS } from "./tool-bridge.js";

describe("executeVoiceToolCalls — per-tool timeout", () => {
    beforeEach(() => {
        hoisted.executeTool.mockReset();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("exposes an 8s timeout constant so the session doesn't stall on a slow tool", () => {
        expect(VOICE_TOOL_TIMEOUT_MS).toBe(8000);
    });

    it("returns a result with an error when a tool exceeds the timeout", async () => {
        // The tool never resolves — only the timeout should fire.
        hoisted.executeTool.mockImplementation(() => new Promise(() => { /* hang forever */ }));

        const before = Date.now();
        const results = await Promise.race([
            executeVoiceToolCalls([{ id: "fc1", name: "slow_tool", args: {} }]),
            // Safety net so a regression doesn't freeze the whole test run:
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("test safety timeout")), VOICE_TOOL_TIMEOUT_MS + 2000)),
        ]);
        const elapsed = Date.now() - before;

        expect(Array.isArray(results)).toBe(true);
        expect(results).toHaveLength(1);
        const r = (results as any[])[0];
        expect(r.id).toBe("fc1");
        expect(r.name).toBe("slow_tool");
        expect(r.result).toHaveProperty("error");
        expect(String(r.result.error)).toMatch(/timed out/i);
        // Finished in roughly the timeout window, not much more.
        expect(elapsed).toBeGreaterThanOrEqual(VOICE_TOOL_TIMEOUT_MS - 100);
        expect(elapsed).toBeLessThan(VOICE_TOOL_TIMEOUT_MS + 1500);
    }, 15_000);

    it("returns the tool's result when it resolves in time", async () => {
        hoisted.executeTool.mockResolvedValue({ ok: true, data: 42 });

        const results = await executeVoiceToolCalls([{ id: "fc2", name: "fast_tool", args: {} }]);
        expect(results).toHaveLength(1);
        expect(results[0].result).toEqual({ ok: true, data: 42 });
    });

    it("gives media tools (spotify) longer than the default 8s timeout", async () => {
        // Spotify resolves in 10s — would be cut off at 8s default, should survive with the override.
        hoisted.executeTool.mockImplementation(() =>
            new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 10000)),
        );
        const results = await executeVoiceToolCalls([{ id: "fc4", name: "spotify", args: { action: "resume" } }]);
        expect(results).toHaveLength(1);
        expect(results[0].result).toEqual({ ok: true });
    }, 20_000);

    it("wraps a thrown error into the result payload rather than rejecting the batch", async () => {
        hoisted.executeTool.mockRejectedValue(new Error("boom"));

        const results = await executeVoiceToolCalls([{ id: "fc3", name: "broken", args: {} }]);
        expect(results).toHaveLength(1);
        expect(results[0].result).toEqual({ error: "boom" });
    });
});
