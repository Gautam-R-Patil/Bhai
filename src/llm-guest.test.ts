// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A guest's or contact's turn tells the proxy so, and the proxy leaves out the owner's
// Settings tone (unhinged is 18+, owner-only) and personal learnings.
import { describe, expect, it, vi } from "vitest";

const bodies: Array<Record<string, unknown>> = [];
vi.mock("./crypto-transport.js", () => ({
    encryptedFetch: async (_url: string, opts: { body?: string }) => {
        bodies.push(JSON.parse(opts.body ?? "{}"));
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] }), {
            status: 200,
        });
    },
}));
vi.mock("./session.js", () => ({ getSessionToken: async () => "tok", handleAuthError: async () => null }));
vi.mock("./model-router.js", () => ({
    claudeTier: (m: string) => m,
    getHorizontalFailoverModel: () => null,
    isCircuitOpen: () => false,
    updateModelStats: () => {},
}));
vi.mock("./network-health.js", () => ({
    isOffline: () => false,
    reportNetworkError: async () => "online",
    reportNetworkSuccess: () => {},
}));
vi.mock("./llm-middleware.js", () => ({
    createDefaultPipeline: () => (p: unknown, next: (p: unknown) => unknown) => next(p),
}));

const { createLLMClient } = await import("./llm.js");
const { runWithCallerContext } = await import("./tools/cron-tool.js");
const llm = createLLMClient({} as never);
const ask = () => llm.chat({ messages: [{ role: "user", content: "hey" }] } as never);

describe("guest flag on LLM calls", () => {
    it("is set on a guest's turn, not on the owner's or on background work", async () => {
        await runWithCallerContext({ isOwner: false }, ask);
        await runWithCallerContext({ isOwner: true }, ask);
        await ask();
        expect(bodies.map((b) => b.guest)).toEqual([true, undefined, undefined]);
    });
});
