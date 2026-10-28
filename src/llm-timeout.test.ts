// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// chat({ timeoutMs }) bounds each model attempt with its own deadline; without
// it the deadline follows thinking effort (attemptTimeoutMs). Offline:
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
vi.mock("./network-health.js", () => ({
    isOffline: () => false,
    reportNetworkError: async () => "online",
    reportNetworkSuccess: () => {},
}));
vi.mock("./llm-middleware.js", () => ({
    createDefaultPipeline: () => (p: unknown, next: (p: unknown) => unknown) => next(p),
}));

const { createLLMClient, attemptTimeoutMs } = await import("./llm.js");
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
        await expect(llm.chat({ messages: [{ role: "user", content: "x" }], timeoutMs: 100 })).rejects.toThrow(
            /abort|timeout/i,
        );
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

    it("a caller's signal aborts the attempt in flight, and no other model is tried", async () => {
        respond = hang;
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 50);
        const t0 = Date.now();
        await expect(
            llm.chat({ messages: [{ role: "user", content: "x" }], timeoutMs: 120_000, signal: ctrl.signal }),
        ).rejects.toThrow(/abort/i);
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(fetches.length).toBe(1);
        // An already-cancelled call never reaches the network.
        await expect(llm.chat({ messages: [{ role: "user", content: "x" }], signal: ctrl.signal })).rejects.toThrow();
        expect(fetches.length).toBe(1);
    });

    it("a signal alone still gets the default deadline per attempt", async () => {
        respond = ok;
        await llm.chat({ messages: [{ role: "user", content: "x" }], signal: new AbortController().signal });
        expect(fetches[0].signal).toBeInstanceOf(AbortSignal);
        expect(fetches[0].signal?.aborted).toBe(false);
    });

    it("without timeoutMs every attempt still gets an effort-sized deadline", async () => {
        respond = ok;
        await llm.chat({ messages: [{ role: "user", content: "x" }] });
        expect(fetches[0].signal).toBeInstanceOf(AbortSignal);
    });

    it("thinking effort scales the per-attempt deadline; the env var overrides it", () => {
        const prev = process.env.ATLAS_LLM_ATTEMPT_TIMEOUT_MS;
        delete process.env.ATLAS_LLM_ATTEMPT_TIMEOUT_MS;
        try {
            expect(attemptTimeoutMs(undefined)).toBe(25_000);
            expect(attemptTimeoutMs("low")).toBe(25_000);
            expect(attemptTimeoutMs("medium")).toBe(60_000);
            expect(attemptTimeoutMs("high")).toBe(120_000);
            expect(attemptTimeoutMs("max")).toBe(180_000);
            process.env.ATLAS_LLM_ATTEMPT_TIMEOUT_MS = "5000";
            expect(attemptTimeoutMs("max")).toBe(5000);
        } finally {
            if (prev === undefined) delete process.env.ATLAS_LLM_ATTEMPT_TIMEOUT_MS;
            else process.env.ATLAS_LLM_ATTEMPT_TIMEOUT_MS = prev;
        }
    });
});

describe("out of credits", () => {
    it("a 402 throws once with status 402: no other model, no last-resort retry", async () => {
        respond = async () => new Response("{}", { status: 402 });
        const err = await llm.chat({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
        expect(err.status).toBe(402);
        expect(err.message).toMatch(/run out of AI credits/);
        expect(fetches.length).toBe(1);
    });
});
