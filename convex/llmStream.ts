// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Turns Claude's stream into the frames the client reads live. The message comes
// from the SDK's own accumulator (finalMessage), never rebuilt here, so the
// OpenAI-shape translation (toOpenAIResponse) sees exactly what a plain call gives.

import type { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import type * as Beta from "@anthropic-ai/sdk/resources/beta/messages/messages";
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
