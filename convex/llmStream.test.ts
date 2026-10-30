// © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pipeClaudeStream } from "./llmStream";
import type { Frame } from "./streamFrames";

type Ev = Record<string, unknown>;

const start = (): Ev => ({
    type: "message_start",
    message: {
        id: "m1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
    },
});
const blockStart = (index: number, content_block: Ev): Ev => ({ type: "content_block_start", index, content_block });
const delta = (index: number, d: Ev): Ev => ({ type: "content_block_delta", index, delta: d });
const stop = (index: number): Ev => ({ type: "content_block_stop", index });
const end = (stop_reason: string): Ev[] => [
    { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
];
const textBlock = (i: number, ...parts: string[]): Ev[] => [
    blockStart(i, { type: "text", text: "" }),
    ...parts.map((t) => delta(i, { type: "text_delta", text: t })),
    stop(i),
];

function toStream(events: Ev[]) {
    const enc = new TextEncoder();
    return BetaMessageStream.fromReadableStream(
        new ReadableStream({
            start(c) {
                for (const e of events) c.enqueue(enc.encode(`${JSON.stringify(e)}\n`));
                c.close();
            },
        }),
    );
}

async function run(events: Ev[]) {
    const frames: Frame[] = [];
    const message = await pipeClaudeStream(toStream(events), (f) => frames.push(f), { coalesceMs: 0 });
    return { frames, message };
}

describe("pipeClaudeStream", () => {
    afterEach(() => vi.useRealTimers());

    it("plain answer: text frames join to the full text and the message is rebuilt", async () => {
        const { frames, message } = await run([start(), ...textBlock(0, "Hel", "lo ", "there"), ...end("end_turn")]);
        expect(frames.every((f) => f.kind === "text")).toBe(true);
        expect(frames.map((f) => f.text).join("")).toBe("Hello there");
        expect(message.content).toEqual([{ type: "text", text: "Hello there" }]);
        expect(message.stop_reason).toBe("end_turn");
        expect(message.usage.output_tokens).toBe(9);
    });

    it("notes come from thinking deltas, empty ones are skipped", async () => {
        const { frames, message } = await run([
            start(),
            blockStart(0, { type: "thinking", thinking: "", signature: "" }),
            delta(0, { type: "thinking_delta", thinking: "" }),
            delta(0, { type: "thinking_delta", thinking: "Checking the file." }),
            delta(0, { type: "signature_delta", signature: "sig" }),
            stop(0),
            ...end("end_turn"),
        ]);
        expect(frames).toEqual([{ kind: "note", text: "Checking the file." }]);
        expect(message.content[0]).toMatchObject({
            type: "thinking",
            thinking: "Checking the file.",
            signature: "sig",
        });
    });

    it("tool start emits a tool frame and the input is parsed", async () => {
        const { frames, message } = await run([
            start(),
            blockStart(0, { type: "tool_use", id: "t1", name: "web_search", input: {} }),
            delta(0, { type: "input_json_delta", partial_json: '{"q":' }),
            delta(0, { type: "input_json_delta", partial_json: '"hi"}' }),
            stop(0),
            ...end("tool_use"),
        ]);
        expect(frames).toEqual([{ kind: "tool", name: "web_search" }]);
        expect(message.content[0]).toMatchObject({ type: "tool_use", name: "web_search", input: { q: "hi" } });
    });

    it("fallback keeps text and voids tools", async () => {
        const { frames, message } = await run([
            start(),
            ...textBlock(0, "first"),
            blockStart(1, { type: "tool_use", id: "t1", name: "shell", input: {} }),
            stop(1),
            blockStart(2, { type: "fallback", from: { model: "a" }, to: { model: "b" }, trigger: { type: "refusal" } }),
            stop(2),
            ...textBlock(3, "second"),
            ...end("end_turn"),
        ]);
        expect(frames.map((f) => f.kind)).toEqual(["text", "tool", "void_tools", "text"]);
        expect(message.content.map((b) => b.type)).toEqual(["text", "tool_use", "fallback", "text"]);
    });

    it("refusal ends in reset", async () => {
        const { frames } = await run([start(), ...textBlock(0, "no"), ...end("refusal")]);
        expect(frames.map((f) => f.kind)).toEqual(["text", "reset"]);
    });

    it("coalesces deltas within the window", async () => {
        vi.useFakeTimers();
        const enc = new TextEncoder();
        const line = (e: Ev) => enc.encode(`${JSON.stringify(e)}\n`);
        let ctl!: ReadableStreamDefaultController;
        const stream = BetaMessageStream.fromReadableStream(
            new ReadableStream({
                start(c) {
                    ctl = c;
                },
            }),
        );
        const frames: Frame[] = [];
        const done = pipeClaudeStream(stream, (f) => frames.push(f), { coalesceMs: 60 });
        for (const e of [start(), blockStart(0, { type: "text", text: "" })]) ctl.enqueue(line(e));
        for (const t of ["a", "b", "c", "d", "e"]) ctl.enqueue(line(delta(0, { type: "text_delta", text: t })));
        await vi.advanceTimersByTimeAsync(10);
        expect(frames).toEqual([]);
        await vi.advanceTimersByTimeAsync(60);
        expect(frames).toEqual([{ kind: "text", text: "abcde" }]);
        for (const e of [stop(0), ...end("end_turn")]) ctl.enqueue(line(e));
        ctl.close();
        await done;
        expect(frames).toHaveLength(1);
    });

    it("each thinking block is its own note", async () => {
        const think = (i: number, t: string): Ev[] => [
            blockStart(i, { type: "thinking", thinking: "", signature: "" }),
            delta(i, { type: "thinking_delta", thinking: t }),
            stop(i),
        ];
        const { frames } = await run([start(), ...think(0, "One."), ...think(1, "Two."), ...end("end_turn")]);
        expect(frames).toEqual([
            { kind: "note", text: "One." },
            { kind: "note", text: "Two." },
        ]);
    });

    it("returns exactly the SDK's final message", async () => {
        const events: Ev[] = [
            {
                type: "message_start",
                message: {
                    id: "m1",
                    type: "message",
                    role: "assistant",
                    model: "claude-opus-5-5",
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50 },
                },
            },
            ...textBlock(0, "Hi"),
            blockStart(1, {
                type: "fallback",
                from: { model: "claude-opus-5-5" },
                to: { model: "claude-sonnet-5-5" },
                trigger: { type: "refusal" },
            }),
            stop(1),
            {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { input_tokens: null, cache_read_input_tokens: null, output_tokens: 9 },
            },
            { type: "message_stop" },
        ];
        const reference = await toStream(events).finalMessage();
        const { message } = await run(events);
        expect(message).toEqual(reference);
        expect(message.usage.input_tokens).toBe(100);
        expect(message.usage.cache_read_input_tokens).toBe(50);
    });
});
