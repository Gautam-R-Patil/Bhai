// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Live-streaming frame types (same shape as convex/streamFrames.ts) and the client frame reader.

import type { ChatCompletion } from "openai/resources/chat/completions.js";
import { decryptFrame, openEnvelope } from "./crypto-transport.js";

export type FrameKind = "text" | "note" | "tool" | "void_tools" | "reset" | "error" | "done";

export type Frame = {
    kind: FrameKind;
    text?: string;
    name?: string;
    error?: string;
    status?: number;
    completion?: unknown;
};

export type LLMDelta =
    | { kind: "text"; text: string }
    | { kind: "note"; text: string }
    | { kind: "tool"; name: string }
    | { kind: "void_tools" }
    | { kind: "reset" };

type ReadOpts = { firstFrameMs: number; gapMs: number; signal?: AbortSignal; onDelta: (d: LLMDelta) => void };

const CHAT_PATH = "/api/llm/chat";

/** The `{status, message}` error llm.ts already handles, secrets scrubbed. */
async function httpError(status: number, raw: string): Promise<Error> {
    const { sanitizeSecrets } = await import("./security/secrets-sanitizer.js");
    return Object.assign(new Error(sanitizeSecrets(raw).sanitized.slice(0, 500)), { status });
}

/** Read a non-framed body: a non-2xx error (encrypted or plain), or an old server's single envelope. */
async function readWhole(response: Response): Promise<ChatCompletion> {
    const encrypted = response.headers.get("X-Encryption") === "ecdh-aes-256-gcm";
    const text = await response.text().catch(() => "");
    if (!response.ok) {
        let data: { error?: unknown } = {};
        try {
            data = JSON.parse(encrypted ? openEnvelope(text, "POST", CHAT_PATH) : text);
        } catch {}
        const err = data.error as { message?: unknown } | string | undefined;
        const msg = (typeof err === "object" && err?.message) || err || `HTTP ${response.status}`;
        throw await httpError(response.status, typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    // We asked for a stream: a 2xx must be encrypted. A plaintext 2xx could be
    // an on-path swap (the X-Encryption header itself is unauthenticated).
    if (!encrypted) throw await httpError(502, "Refused an unencrypted answer");
    try {
        return JSON.parse(openEnvelope(text, "POST", CHAT_PATH)) as ChatCompletion;
    } catch {
        throw await httpError(502, "E2E decryption failed");
    }
}

function toDelta(f: Frame): LLMDelta {
    switch (f.kind) {
        case "text":
        case "note":
            return { kind: f.kind, text: String(f.text ?? "") };
        case "tool":
            return { kind: "tool", name: String(f.name ?? "") };
        case "void_tools":
        case "reset":
            return { kind: f.kind };
        default:
            throw new Error(`unexpected stream frame "${String(f.kind)}"`);
    }
}

/**
 * Read an encrypted NDJSON frame stream: forward each non-final frame to
 * `onDelta`, return the final `done` frame's completion. Throws `{status,
 * message}` on an `error` frame, a stream that ends without its final frame,
 * a frame after the final one, a bad/reordered frame, or a timeout (first frame
 * within `firstFrameMs`, then at most `gapMs` between frames; no total
 * deadline). A 2xx without `X-Stream: frames` is accepted only as an old
 * server's single encrypted envelope.
 */
export async function readFrames(response: Response, reqRid: string, opts: ReadOpts): Promise<ChatCompletion> {
    opts.signal?.throwIfAborted();
    if (!response.ok || response.headers.get("X-Stream") !== "frames" || !response.body) {
        return readWhole(response);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let seq = 0;
    let result: { completion: ChatCompletion } | undefined;
    let deadline = Date.now() + opts.firstFrameMs;

    const next = () =>
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
            const onAbort = () => reject(opts.signal?.reason);
            const timer = setTimeout(
                () => reject(Object.assign(new Error("LLM stream stalled"), { status: 504 })),
                Math.max(0, deadline - Date.now()),
            );
            opts.signal?.addEventListener("abort", onAbort, { once: true });
            reader
                .read()
                .then(resolve, reject)
                .finally(() => {
                    clearTimeout(timer);
                    opts.signal?.removeEventListener("abort", onAbort);
                });
        });

    const onLine = (line: string) => {
        if (!line.trim()) return;
        if (result) throw new Error("frame after the final one");
        const { frame, final } = decryptFrame(line, reqRid, seq++);
        deadline = Date.now() + opts.gapMs;
        if (!final) return opts.onDelta(toDelta(frame));
        if (frame.kind === "done") result = { completion: frame.completion as ChatCompletion };
        else if (frame.kind === "error") {
            throw Object.assign(new Error(String(frame.error ?? "stream error")), {
                status: frame.status ?? 502,
                streamError: true,
            });
        } else throw new Error(`unexpected final frame "${String(frame.kind)}"`);
    };

    try {
        for (;;) {
            const { done, value } = await next();
            buf += decoder.decode(value, { stream: !done });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) onLine(line);
            if (done) break;
        }
        onLine(buf);
        if (!result) throw new Error("stream ended without its final frame");
        return result.completion;
    } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        const e = err as Error & { status?: number; streamError?: boolean };
        if (e.status) throw e.streamError ? await httpError(e.status, e.message) : e;
        throw await httpError(502, `LLM stream broken: ${e.message}`);
    } finally {
        reader.cancel().catch(() => {});
    }
}
