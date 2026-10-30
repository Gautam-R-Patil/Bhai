// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Turns Claude's stream into the frames the client reads live. The message comes
// from the SDK's own accumulator (finalMessage), never rebuilt here, so the
// OpenAI-shape translation (toOpenAIResponse) sees exactly what a plain call gives.

import type { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import type * as Beta from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { toOpenAIResponse } from "./claude";
import type { Frame } from "./streamFrames";

export async function pipeClaudeStream(
    stream: BetaMessageStream,
    emit: (f: Frame) => void,
    opts: { coalesceMs: number },
): Promise<Beta.BetaMessage> {
    let stopReason: string | null = null;
    let pending: { kind: "text" | "note"; text: string } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        if (pending) emit({ kind: pending.kind, text: pending.text });
        pending = undefined;
    };
    const push = (kind: "text" | "note", text: string) => {
        if (pending && pending.kind !== kind) flush();
        if (pending) pending.text += text;
        else pending = { kind, text };
        if (timer === undefined) timer = setTimeout(flush, opts.coalesceMs);
    };

    try {
        for await (const ev of stream) {
            if (ev.type === "content_block_start") {
                const t = ev.content_block.type;
                // Each thinking block is its own note; tools and fallbacks end whatever came before.
                if (t === "thinking" || t === "tool_use" || t === "fallback") flush();
                if (t === "tool_use") emit({ kind: "tool", name: ev.content_block.name });
                else if (t === "fallback") emit({ kind: "void_tools" });
            } else if (ev.type === "content_block_delta") {
                const d = ev.delta;
                if (d.type === "text_delta" && d.text) push("text", d.text);
                else if (d.type === "thinking_delta" && d.thinking) push("note", d.thinking);
            } else if (ev.type === "message_delta") {
                stopReason = ev.delta.stop_reason ?? null;
            }
        }
    } finally {
        flush();
    }

    if (stopReason === "refusal") emit({ kind: "reset" });
    return stream.finalMessage();
}

/**
 * Writes one response as frames: the deltas `run` emits, then a final `done` with the
 * completion the non-streaming path would return, or a final `error {status, error}` if
 * `run` throws (a thrown `{status, error}` keeps its values, anything else is a 502).
 * Frames are written in emit order; once a write fails (client gone) nothing more is
 * written. `message` is set whenever the provider answered, delivered or not.
 * `beforeDone` (the success bookkeeping) runs before the `done` frame: the client
 * hangs up at `done`, and work after that may never run. Its failure is logged only.
 */
export async function streamCompletion(
    write: (line: string) => Promise<void>,
    run: (emit: (f: Frame) => void) => Promise<Beta.BetaMessage>,
    encode: (f: Frame, final: boolean) => Promise<string>,
    opts: { beforeDone?: (completion: unknown) => Promise<void> } = {},
): Promise<{ ok: boolean; message?: Beta.BetaMessage }> {
    let broken = false;
    let chain = Promise.resolve();
    const send = (f: Frame, final: boolean) => {
        chain = chain
            .then(async () => {
                if (!broken) await write(await encode(f, final));
            })
            .catch(() => {
                broken = true;
            });
        return chain;
    };

    let message: Beta.BetaMessage;
    let completion: unknown;
    try {
        message = await run((f) => void send(f, false));
        completion = toOpenAIResponse(message);
    } catch (err) {
        const e = err as { status?: unknown; error?: unknown } | null;
        await send(
            {
                kind: "error",
                status: typeof e?.status === "number" ? e.status : 502,
                error: typeof e?.error === "string" ? e.error : "LLM service temporarily unavailable",
            },
            true,
        );
        return { ok: false };
    }
    try {
        await opts.beforeDone?.(completion);
    } catch (err) {
        console.error("[llmStream] success bookkeeping failed:", (err as Error)?.message);
    }
    await send({ kind: "done", completion }, true);
    return { ok: !broken, message };
}
