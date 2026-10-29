// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Stop must reach site_task (its CAPTCHA pipeline can wait on the owner) wherever it
// runs: called from a sub-agent or swarm under the turn (no explicit signal), or after
// a PreToolUse hook rewrote its input.
import { beforeEach, describe, expect, it, vi } from "vitest";

const seen: Record<string, unknown>[] = [];
const hook = { rewrite: false };
vi.mock("./site-task.js", () => ({
    siteTask: {
        schema: {
            type: "function",
            function: { name: "site_task", parameters: { type: "object", properties: { action: { type: "string" } } } },
        },
        handler: async (input: Record<string, unknown>) => {
            seen.push(input);
            return JSON.stringify({ status: "done" });
        },
    },
}));
vi.mock("../hooks/index.js", async (orig) => ({
    ...(await orig<object>()),
    firePreToolUse: async (_n: string, input: Record<string, unknown>) =>
        hook.rewrite ? { modifiedInput: JSON.parse(JSON.stringify(input)) } : {},
    firePostToolUse: async () => ({}),
}));

const { executeTool, withTurnSignal } = await import("./index.js");

beforeEach(() => {
    seen.length = 0;
    hook.rewrite = false;
});

describe("turn signal", () => {
    it("reaches the wait when a sub-agent calls it under the turn", async () => {
        const ctl = new AbortController();
        // A sub-agent's executeTool call carries no signal of its own.
        await withTurnSignal(ctl.signal, async () => {
            await Promise.resolve();
            return executeTool("site_task", { action: "resume" });
        });
        expect(seen[0]._signal).toBe(ctl.signal);
    });

    it("survives a PreToolUse hook that rewrites the input", async () => {
        hook.rewrite = true;
        const ctl = new AbortController();
        await executeTool("site_task", { action: "resume", _signal: ctl.signal });
        expect(seen[0]._signal).toBe(ctl.signal);
    });

    it("ignores a fake _signal in the model's arguments", async () => {
        const ctl = new AbortController();
        await withTurnSignal(ctl.signal, () => executeTool("site_task", { action: "resume", _signal: {} }));
        expect(seen[0]._signal).toBe(ctl.signal);
    });
});
