// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deriveSharedKey, encryptedFetchStream, generateKeyPair } from "./crypto-transport.js";
import { type Frame, type LLMDelta, readFrames } from "./llm-stream.js";

// The Convex modules live outside tsc's rootDir (src), so load them by a non-literal path.
const CONVEX = "../convex/";
const convexCrypto = (await import(/* @vite-ignore */ `${CONVEX}crypto`)) as {
    generateServerKeyPair(): Promise<{ publicKey: string; privateKey: string }>;
    deriveSharedKey(priv: string, clientPub: string, version: number, serverPub: string): Promise<string>;
    encryptResponse(text: string, key: string, aad?: (ts: number, rid: string) => string): Promise<unknown>;
    decryptRequest(env: unknown, key: string, aad?: Uint8Array): Promise<string>;
};
const { encodeFrame } = (await import(/* @vite-ignore */ `${CONVEX}streamFrames`)) as {
    encodeFrame(f: Frame, seq: number, final: boolean, rid: string, key: string): Promise<string>;
};

let serverKey: string;
const RID = "req-1";
const COMPLETION = { id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "hi" } }] };
const FRAMED = { "X-Encryption": "ecdh-aes-256-gcm", "X-Stream": "frames", "Content-Type": "text/event-stream" };
const OPTS = { firstFrameMs: 25_000, gapMs: 30_000 };

beforeAll(async () => {
    const clientPub = generateKeyPair();
    const server = await convexCrypto.generateServerKeyPair();
    serverKey = await convexCrypto.deriveSharedKey(server.privateKey, clientPub, 2, server.publicKey);
    deriveSharedKey(server.publicKey);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

/** Encode frames with seq 0..n-1; the last one is final unless `noFinal`. */
async function encode(frames: Frame[], rid = RID, noFinal = false): Promise<string[]> {
    return Promise.all(frames.map((f, i) => encodeFrame(f, i, !noFinal && i === frames.length - 1, rid, serverKey)));
}

function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
        start(c) {
            for (const ch of chunks) c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch);
            c.close();
        },
    });
}

/** Emits one line every `gapMs` (setTimeout, so fake timers drive it). */
function timedStream(lines: string[], gapMs: number): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    let cancelled = false;
    return new ReadableStream({
        pull(c) {
            return new Promise<void>((resolve) =>
                setTimeout(() => {
                    if (cancelled) return resolve();
                    if (i < lines.length) c.enqueue(enc.encode(lines[i++]));
                    else c.close();
                    resolve();
                }, gapMs),
            );
        },
        cancel() {
            cancelled = true;
        },
    });
}

const framed = (body: ReadableStream<Uint8Array>) => new Response(body, { status: 200, headers: FRAMED });

const DELTA_FRAMES: Frame[] = [
    { kind: "note", text: "thinking" },
    { kind: "text", text: "Hello " },
    { kind: "tool", name: "web_search" },
    { kind: "void_tools" },
    { kind: "reset" },
    { kind: "text", text: "world" },
    { kind: "done", completion: COMPLETION },
];
const EXPECTED: LLMDelta[] = [
    { kind: "note", text: "thinking" },
    { kind: "text", text: "Hello " },
    { kind: "tool", name: "web_search" },
    { kind: "void_tools" },
    { kind: "reset" },
    { kind: "text", text: "world" },
];

describe("readFrames", () => {
    it("delivers deltas in order and returns the done completion", async () => {
        const deltas: LLMDelta[] = [];
        const out = await readFrames(framed(streamOf(await encode(DELTA_FRAMES))), RID, {
            ...OPTS,
            onDelta: (d) => deltas.push(d),
        });
        expect(deltas).toEqual(EXPECTED);
        expect(out).toEqual(COMPLETION);
    });

    it("decodes multi-byte text split across chunks", async () => {
        const text = "हाँ भाई ₹3,240 👍";
        const bytes = new TextEncoder().encode(
            (
                await encode([
                    { kind: "text", text },
                    { kind: "done", completion: COMPLETION },
                ])
            ).join(""),
        );
        for (let at = 0; at <= bytes.length; at++) {
            const deltas: LLMDelta[] = [];
            const out = await readFrames(framed(streamOf([bytes.subarray(0, at), bytes.subarray(at)])), RID, {
                ...OPTS,
                onDelta: (d) => deltas.push(d),
            });
            expect(deltas, `split at ${at}`).toEqual([{ kind: "text", text }]);
            expect(out).toEqual(COMPLETION);
        }
    });

    it("no total deadline: a 40 s stream with 1 s gaps completes", async () => {
        const frames: Frame[] = Array.from({ length: 39 }, (_, i) => ({ kind: "text", text: `t${i}` }) as Frame);
        frames.push({ kind: "done", completion: COMPLETION });
        const lines = await encode(frames);
        vi.useFakeTimers();
        const deltas: LLMDelta[] = [];
        const p = readFrames(framed(timedStream(lines, 1000)), RID, { ...OPTS, onDelta: (d) => deltas.push(d) });
        await vi.advanceTimersByTimeAsync(41_000);
        await expect(p).resolves.toEqual(COMPLETION);
        expect(deltas).toHaveLength(39);
    });

    it("times out on a 31 s gap", async () => {
        const lines = await encode([
            { kind: "text", text: "a" },
            { kind: "done", completion: COMPLETION },
        ]);
        vi.useFakeTimers();
        const enc = new TextEncoder();
        let sent = 0;
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(c) {
                const wait = sent === 0 ? 0 : 31_000;
                return new Promise<void>((resolve) =>
                    setTimeout(() => {
                        if (!cancelled) c.enqueue(enc.encode(lines[sent++]));
                        resolve();
                    }, wait),
                );
            },
            cancel() {
                cancelled = true;
            },
        });
        const p = readFrames(framed(body), RID, { ...OPTS, onDelta: () => {} });
        const check = expect(p).rejects.toMatchObject({ status: 504 });
        await vi.advanceTimersByTimeAsync(31_000);
        await check;
        expect(sent).toBe(1); // the done frame due at 31 s never arrived
    });

    it("times out when the first frame is late", async () => {
        const lines = await encode([{ kind: "done", completion: COMPLETION }]);
        vi.useFakeTimers();
        const p = readFrames(framed(timedStream(lines, 26_000)), RID, { ...OPTS, onDelta: () => {} });
        const check = expect(p).rejects.toMatchObject({ status: 504 });
        await vi.advanceTimersByTimeAsync(26_000);
        await check;
    });

    it("throws on a missing done", async () => {
        const lines = await encode([{ kind: "text", text: "a" }], RID, true);
        await expect(readFrames(framed(streamOf(lines)), RID, { ...OPTS, onDelta: () => {} })).rejects.toMatchObject({
            status: 502,
        });
    });

    it("throws on an error frame with its status", async () => {
        const lines = await encode([
            { kind: "text", text: "a" },
            { kind: "error", error: "upstream overloaded", status: 529 },
        ]);
        await expect(readFrames(framed(streamOf(lines)), RID, { ...OPTS, onDelta: () => {} })).rejects.toMatchObject({
            status: 529,
            message: "upstream overloaded",
        });
    });

    it("rejects a frame after the final one (already buffered)", async () => {
        const lines = await encode([{ kind: "done", completion: COMPLETION }]);
        const late = await encodeFrame({ kind: "text", text: "late" }, 1, false, RID, serverKey);
        // Whole trailing line, and a partial one, in the same chunk as the final frame.
        for (const tail of [late, late.slice(0, 20)]) {
            const body = streamOf([lines[0] + tail]);
            await expect(readFrames(framed(body), RID, { ...OPTS, onDelta: () => {} })).rejects.toMatchObject({
                status: 502,
            });
        }
    });

    it("rejects frames sealed for another request", async () => {
        const lines = await encode([{ kind: "done", completion: COMPLETION }], "req-other");
        await expect(readFrames(framed(streamOf(lines)), RID, { ...OPTS, onDelta: () => {} })).rejects.toMatchObject({
            status: 502,
        });
    });

    it("throws on an unknown frame kind", async () => {
        const lines = await encode([
            { kind: "bogus" as never, text: "x" },
            { kind: "done", completion: COMPLETION },
        ]);
        await expect(readFrames(framed(streamOf(lines)), RID, { ...OPTS, onDelta: () => {} })).rejects.toMatchObject({
            status: 502,
        });
    });

    it("returns at the final frame without waiting for the body to close", async () => {
        const lines = await encode([
            { kind: "text", text: "a" },
            { kind: "done", completion: COMPLETION },
        ]);
        let cancelled = false;
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                for (const l of lines) c.enqueue(enc.encode(l));
            },
            cancel() {
                cancelled = true;
            },
        });
        vi.useFakeTimers();
        const p = readFrames(framed(body), RID, { ...OPTS, onDelta: () => {} });
        await vi.advanceTimersByTimeAsync(0);
        await expect(p).resolves.toEqual(COMPLETION);
        expect(cancelled).toBe(true);
    });

    for (const status of [200, 500]) {
        it(`bounds a non-framed ${status} body that never completes by firstFrameMs`, async () => {
            let cancelled = false;
            const body = new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(new TextEncoder().encode('{"iv":"'));
                },
                cancel() {
                    cancelled = true;
                },
            });
            const res = new Response(body, {
                status,
                headers: { "X-Encryption": "ecdh-aes-256-gcm", "Content-Type": "application/json" },
            });
            vi.useFakeTimers();
            const p = readFrames(res, RID, { ...OPTS, onDelta: () => {} });
            const check = expect(p).rejects.toMatchObject({ status: 504 });
            await vi.advanceTimersByTimeAsync(OPTS.firstFrameMs);
            await check;
            expect(cancelled).toBe(true);
        });
    }

    it("rejects a 2xx plaintext body", async () => {
        const res = new Response(JSON.stringify(COMPLETION), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
        await expect(readFrames(res, RID, { ...OPTS, onDelta: () => {} })).rejects.toMatchObject({ status: 502 });
    });

    it("accepts an old server's single encrypted envelope", async () => {
        const env = await convexCrypto.encryptResponse(
            JSON.stringify(COMPLETION),
            serverKey,
            (ts, rid) => `POST|/api/llm/chat|${ts}|${rid}`,
        );
        const res = new Response(JSON.stringify(env), {
            status: 200,
            headers: { "X-Encryption": "ecdh-aes-256-gcm", "Content-Type": "application/json" },
        });
        const deltas: LLMDelta[] = [];
        await expect(readFrames(res, RID, { ...OPTS, onDelta: (d) => deltas.push(d) })).resolves.toEqual(COMPLETION);
        expect(deltas).toEqual([]);
    });

    it("throws a non-2xx error body with its status", async () => {
        const res = new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 402 });
        await expect(readFrames(res, RID, { ...OPTS, onDelta: () => {} })).rejects.toMatchObject({
            status: 402,
            message: "Insufficient credits",
        });
    });

    it("honours the abort signal and cancels the body", async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => {}),
            cancel: () => {
                cancelled = true;
            },
        });
        const ac = new AbortController();
        const p = readFrames(framed(body), RID, { ...OPTS, signal: ac.signal, onDelta: () => {} });
        ac.abort(new Error("stopped by owner"));
        await expect(p).rejects.toThrow("stopped by owner");
        expect(cancelled).toBe(true);
    });
});

describe("encryptedFetchStream", () => {
    it("seals the body with stream: true, binds a fresh rid and leaves the body unread", async () => {
        const sent: RequestInit[] = [];
        const res = framed(streamOf([]));
        vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
            sent.push(init);
            return res;
        });
        const url = "https://x.convex.site/api/llm/chat";
        const init = { method: "POST", headers: { Authorization: "Bearer t" }, body: JSON.stringify({ model: "m" }) };
        const a = await encryptedFetchStream(url, init);
        const b = await encryptedFetchStream(url, init);
        expect(a.response).toBe(res);
        expect(a.response.bodyUsed).toBe(false);
        expect(a.rid).not.toBe(b.rid);
        const env = JSON.parse(sent[0].body as string) as { ts: number; rid: string };
        expect(env.rid).toBe(a.rid);
        const aad = new TextEncoder().encode(`POST|/api/llm/chat|${env.ts}|${env.rid}`);
        expect(JSON.parse(await convexCrypto.decryptRequest(env, serverKey, aad))).toEqual({
            model: "m",
            stream: true,
        });
        const h = new Headers(sent[0].headers);
        expect(h.get("X-Encryption")).toBe("ecdh-aes-256-gcm");
        expect(h.get("Authorization")).toBe("Bearer t");
    });
});
