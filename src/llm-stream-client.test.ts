// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// chat({ onDelta }) streams: deltas reach the caller, each new attempt starts
// with a reset, and the answer is the same completion the plain path returns.
// Offline: transport, frame reader, session, router, health and middleware stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMDelta } from "./llm-stream.js";

type Opts = { body: string; signal?: AbortSignal; headers: Record<string, string> };
const plain: Opts[] = [];
const streams: Opts[] = [];
// One script per streamed attempt: emits deltas, then resolves or throws.
let scripts: Array<(onDelta: (d: LLMDelta) => void, signal?: AbortSignal) => Promise<unknown>> = [];
let streamStatus: number[] = [];
let failover: Record<string, string> = {};
let hangHeaders = 0;
const completion = (content: string) => ({
    id: "c1",
    object: "chat.completion",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
});

vi.mock("./crypto-transport.js", () => ({
    encryptedFetch: async (_url: string, opts: Opts) => {
        plain.push(opts);
        return new Response(JSON.stringify(completion("hi")), { status: 200 });
    },
    encryptedFetchStream: async (_url: string, opts: Opts) => {
        streams.push(opts);
        if (hangHeaders > 0) {
            hangHeaders--;
            return new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason)));
        }
        const status = streamStatus.shift() ?? 200;
        return { response: new Response("", { status }), rid: `rid${streams.length}` };
    },
}));
vi.mock("./llm-stream.js", () => ({
    readFrames: async (
        response: Response,
        _rid: string,
        o: { signal?: AbortSignal; onDelta: (d: LLMDelta) => void; firstFrameMs: number; gapMs: number },
    ) => {
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
        const run = scripts.shift();
        if (!run) throw new Error("no script");
        try {
            return await run(o.onDelta, o.signal);
        } catch (e) {
            if (o.signal?.aborted) throw o.signal.reason;
            throw e;
        }
    },
}));
const refreshes: number[] = [];
vi.mock("./session.js", () => ({
    getSessionToken: async () => "tok",
    handleAuthError: async () => {
        refreshes.push(1);
        return "tok2";
    },
}));
vi.mock("./model-router.js", () => ({
    claudeTier: (m: string) => m,
    getHorizontalFailoverModel: (m: string, exclude?: string[]) =>
        failover[m] && !exclude?.includes(failover[m]) ? failover[m] : null,
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
const llm = createLLMClient({} as never);
const msgs = [{ role: "user" as const, content: "x" }];
const bodyModel = (o: Opts) => JSON.parse(o.body).model;

beforeEach(() => {
    plain.length = 0;
    streams.length = 0;
    refreshes.length = 0;
    scripts = [];
    streamStatus = [];
    failover = {};
    hangHeaders = 0;
    delete process.env.ATLAS_NO_STREAMING;
});

describe("chat({ onDelta })", () => {
    it("forwards deltas and resolves the same completion shape", async () => {
        scripts = [
            async (d) => {
                d({ kind: "text", text: "h" });
                d({ kind: "text", text: "i" });
                return completion("hi");
            },
        ];
        const seen: LLMDelta[] = [];
        const streamed = await llm.chat({ messages: msgs, onDelta: (d) => seen.push(d) });
        const plainResult = await llm.chat({ messages: msgs });
        expect(seen).toEqual([
            { kind: "text", text: "h" },
            { kind: "text", text: "i" },
        ]);
        expect(streamed).toEqual(plainResult);
        expect(streams.length).toBe(1);
        expect(streams[0].headers.Authorization).toBe("Bearer tok");
    });

    it("a mid-stream failure resets, then streams the fallback model", async () => {
        failover = { A: "B" };
        scripts = [
            async (d) => {
                d({ kind: "text", text: "one" });
                d({ kind: "text", text: "two" });
                throw new Error("fetch failed");
            },
            async (d) => {
                d({ kind: "text", text: "three" });
                return completion("from B");
            },
        ];
        const seen: LLMDelta[] = [];
        const r = await llm.chat({ messages: msgs, modelOverride: "A", onDelta: (d) => seen.push(d) });
        expect(seen.map((d) => d.kind)).toEqual(["text", "text", "reset", "text"]);
        expect(r.choices[0].message.content).toBe("from B");
        expect(streams.map(bodyModel)).toEqual(["A", "B"]);
    });

    it("no onDelta means no stream flag", async () => {
        await llm.chat({ messages: msgs });
        expect(streams.length).toBe(0);
        expect(plain.length).toBe(1);
        expect(JSON.parse(plain[0].body).stream).toBeUndefined();
    });

    it("ATLAS_NO_STREAMING=true disables streaming", async () => {
        process.env.ATLAS_NO_STREAMING = "true";
        const seen: LLMDelta[] = [];
        const r = await llm.chat({ messages: msgs, onDelta: (d) => seen.push(d) });
        expect(streams.length).toBe(0);
        expect(plain.length).toBe(1);
        expect(seen).toEqual([]);
        expect(r.choices[0].message.content).toBe("hi");
    });

    it("abort mid-stream tries no other model", async () => {
        failover = { A: "B" };
        const ctrl = new AbortController();
        scripts = [
            (d, signal) =>
                new Promise((_, reject) => {
                    d({ kind: "text", text: "partial" });
                    signal?.addEventListener("abort", () => reject(signal.reason));
                    setTimeout(() => ctrl.abort(), 20);
                }),
        ];
        await expect(
            llm.chat({ messages: msgs, modelOverride: "A", signal: ctrl.signal, onDelta: () => {} }),
        ).rejects.toThrow(/abort/i);
        expect(streams.length).toBe(1);
        expect(plain.length).toBe(0);
    });

    it("a 401 refreshes the session and streams once more", async () => {
        streamStatus = [401];
        scripts = [async () => completion("after refresh")];
        const r = await llm.chat({ messages: msgs, onDelta: () => {} });
        expect(refreshes.length).toBe(1);
        expect(streams.map((s) => s.headers.Authorization)).toEqual(["Bearer tok", "Bearer tok2"]);
        expect(r.choices[0].message.content).toBe("after refresh");
    });

    it("a 402 throws today's out-of-credits copy, no other model", async () => {
        failover = { A: "B" };
        streamStatus = [402];
        const err = await llm.chat({ messages: msgs, modelOverride: "A", onDelta: () => {} }).catch((e) => e);
        expect(err.status).toBe(402);
        expect(err.message).toMatch(/run out of AI credits/);
        expect(streams.length).toBe(1);
    });

    it("a throwing onDelta is the caller's error: rethrown, no other model, no retry", async () => {
        failover = { A: "B" };
        const bug = new Error("caller bug");
        scripts = [
            async (d) => {
                try {
                    d({ kind: "text", text: "x" });
                } catch {
                    // readFrames turns a throwing onDelta into a 502
                    throw Object.assign(new Error("LLM stream broken: caller bug"), { status: 502 });
                }
                return completion("unreachable");
            },
        ];
        const err = await llm
            .chat({
                messages: msgs,
                modelOverride: "A",
                onDelta: () => {
                    throw bug;
                },
            })
            .catch((e) => e);
        expect(err).toBe(bug);
        expect(streams.length).toBe(1);
        expect(plain.length).toBe(0);
    });

    it("bounds the wait for response headers with the attempt budget, then falls back", async () => {
        failover = { A: "B" };
        hangHeaders = 1;
        scripts = [async () => completion("from B")];
        const t0 = Date.now();
        const r = await llm.chat({ messages: msgs, modelOverride: "A", timeoutMs: 80, onDelta: () => {} });
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(r.choices[0].message.content).toBe("from B");
        expect(streams.map(bodyModel)).toEqual(["A", "B"]);
    });
});
