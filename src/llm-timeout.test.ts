// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// chat({ timeoutMs }) bounds each model attempt with its own deadline; without
// it the transport's default (ATLAS_LLM_ATTEMPT_TIMEOUT_MS) applies. Offline:
// the transport, session, router, health monitor and middleware are stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetches: Array<{ signal?: AbortSignal }> = [];
let respond: (opts: { signal?: AbortSignal }) => Promise<Response>;
vi.mock("./crypto-transport.js", () => ({
    encryptedFetch: (_url: string, opts: { signal?: AbortSignal }) => {
        fetches.push(opts);
        return respond(opts);
    },
}));
vi.mock("./session.js", () => ({ getSessionToken: async () => "tok", handleAuthError: async () => null }));
vi.mock("./model-router.js", () => ({
    claudeTier: (m: string) => m,
    getHorizontalFailoverModel: () => null,
    isCircuitOpen: () => false,
    updateModelStats: () => {},
}));
vi.mock("./network-health.js", () => ({ isOffline: () => false, reportNetworkError: async () => "online", reportNetworkSuccess: () => {} }));
vi.mock("./llm-middleware.js", () => ({ createDefaultPipeline: () => (p: unknown, next: (p: unknown) => unknown) => next(p) }));

const { createLLMClient } = await import("./llm.js");
const llm = createLLMClient({} as never);
const hang = (opts: { signal?: AbortSignal }) =>
    new Promise<Response>((_, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason)));
const ok = async () =>
    new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] }), { status: 200 });

beforeEach(() => {
    fetches.length = 0;
});

describe("chat timeoutMs", () => {
    it("a hung model is abandoned at timeoutMs, each attempt with a fresh deadline", async () => {
        respond = hang;
        const t0 = Date.now();
        await expect(llm.chat({ messages: [{ role: "user", content: "x" }], timeoutMs: 100 })).rejects.toThrow(/abort|timeout/i);
        expect(Date.now() - t0).toBeLessThan(2000); // two attempts (primary + last resort), ~100 ms each
        expect(fetches.length).toBe(2);
        expect(fetches.every((f) => f.signal instanceof AbortSignal && f.signal.aborted)).toBe(true);
        expect(fetches[0].signal).not.toBe(fetches[1].signal);
    });

    it("a long deadline doesn't cut a slow answer short", async () => {
        respond = async (opts) => {
            await new Promise((r) => setTimeout(r, 150));
            expect(opts.signal?.aborted).toBe(false);
            return ok();
        };
        const r = await llm.chat({ messages: [{ role: "user", content: "x" }], timeoutMs: 120_000 });
        expect(r.choices[0].message.content).toBe("hi");
    });

    it("without timeoutMs no signal is passed, so the transport applies its default", async () => {
        respond = ok;
        await llm.chat({ messages: [{ role: "user", content: "x" }] });
        expect(fetches.map((f) => f.signal)).toEqual([undefined]);
    });
});
