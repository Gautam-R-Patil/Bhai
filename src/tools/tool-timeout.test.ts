// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// A timed-out tool isn't cancelled, so its change may still land: the model must hear
// "check before running it again", not a bare failure it will retry (MELRA's rule:
// an uncertain change is inspected, never replayed).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./site-task.js", () => ({
    siteTask: {
        schema: {
            type: "function",
            function: { name: "site_task", parameters: { type: "object", properties: { action: { type: "string" } } } },
        },
        handler: () => new Promise<string>(() => {}), // never settles
    },
}));
vi.mock("../hooks/index.js", async (orig) => ({
    ...(await orig<object>()),
    firePreToolUse: async () => ({}),
    firePostToolUse: async () => ({}),
}));

const { executeTool } = await import("./index.js");

afterEach(() => {
    vi.useRealTimers();
});

describe("tool timeout", () => {
    it("says the change may still happen and to check before retrying", async () => {
        vi.useFakeTimers();
        const pending = executeTool("site_task", { action: "resume" });
        await vi.advanceTimersByTimeAsync(600_001);
        const { error } = JSON.parse(await pending);
        expect(error).toMatch(/timed out after 600s/);
        expect(error).toMatch(/may still finish in the background/);
        expect(error).toMatch(/check whether it happened before running it again/);
    });
});
