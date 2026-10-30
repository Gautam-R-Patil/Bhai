// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Turns Claude's raw stream events into the frames the client reads live, and
// rebuilds the same message `.finalMessage()` would give, so the OpenAI-shape
// translation (toOpenAIResponse) is identical streamed or not.

import type * as Beta from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Frame } from "./streamFrames";

type RawEvent = Beta.BetaRawMessageStreamEvent;
type Block = Record<string, unknown> & { type: string };

// ponytail: our own accumulator covers the blocks the proxy asks for (text, thinking, tool_use,
// fallback). If handed the SDK's BetaMessageStream we return its finalMessage() instead.
export async function pipeClaudeStream(
    events: AsyncIterable<RawEvent> & { finalMessage?: () => Promise<Beta.BetaMessage> },
    emit: (f: Frame) => void,
    opts: { coalesceMs: number },
): Promise<Beta.BetaMessage> {
    let message: Beta.BetaMessage | undefined;
    const content: Block[] = [];
    const jsonBuf = new Map<number, string>();
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
        for await (const ev of events) {
            switch (ev.type) {
                case "message_start":
                    message = ev.message;
                    break;
                case "content_block_start": {
                    const b = ev.content_block as Block;
                    content[ev.index] = { ...b };
                    if (b.type === "tool_use") {
                        flush();
                        emit({ kind: "tool", name: String(b.name) });
                    } else if (b.type === "fallback") {
                        flush();
                        emit({ kind: "void_tools" });
                    }
                    break;
                }
                case "content_block_delta": {
                    const b = content[ev.index];
                    const d = ev.delta;
                    if (!b) break;
                    if (d.type === "text_delta") {
                        b.text = `${(b.text as string) ?? ""}${d.text}`;
                        if (d.text) push("text", d.text);
                    } else if (d.type === "thinking_delta") {
                        b.thinking = `${(b.thinking as string) ?? ""}${d.thinking}`;
                        if (d.thinking) push("note", d.thinking);
                    } else if (d.type === "signature_delta") {
                        b.signature = d.signature;
                    } else if (d.type === "input_json_delta") {
                        jsonBuf.set(ev.index, (jsonBuf.get(ev.index) ?? "") + d.partial_json);
                    } else if (d.type === "citations_delta") {
                        b.citations = [...((b.citations as unknown[]) ?? []), d.citation];
                    }
                    break;
                }
                case "content_block_stop": {
                    const b = content[ev.index];
                    const buf = jsonBuf.get(ev.index);
                    if (b && buf !== undefined) {
                        try {
                            b.input = buf.trim() ? JSON.parse(buf) : {};
                        } catch {
                            b.input = {};
                        }
                    }
                    break;
                }
                case "message_delta":
                    if (message) {
                        message.stop_reason = ev.delta.stop_reason;
                        message.stop_sequence = ev.delta.stop_sequence;
                        message.stop_details = ev.delta.stop_details;
                        Object.assign(message.usage, ev.usage);
                    }
                    stopReason = ev.delta.stop_reason ?? null;
                    break;
            }
        }
    } finally {
        flush();
    }

    if (stopReason === "refusal") emit({ kind: "reset" });
    if (events.finalMessage) return events.finalMessage();
    if (!message) throw new Error("stream ended without message_start");
    message.content = content as unknown as Beta.BetaMessage["content"];
    return message;
}
