// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
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

async function* gen(events: Ev[]) {
    for (const e of events) yield e as never;
}

async function run(events: Ev[]) {
    const frames: Frame[] = [];
    const message = await pipeClaudeStream(gen(events), (f) => frames.push(f), { coalesceMs: 0 });
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
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        async function* slow() {
            yield start() as never;
            yield blockStart(0, { type: "text", text: "" }) as never;
            for (const t of ["a", "b", "c", "d", "e"]) yield delta(0, { type: "text_delta", text: t }) as never;
            await gate;
            yield stop(0) as never;
            for (const e of end("end_turn")) yield e as never;
        }
        const frames: Frame[] = [];
        const done = pipeClaudeStream(slow(), (f) => frames.push(f), { coalesceMs: 60 });
        await vi.advanceTimersByTimeAsync(10);
        expect(frames).toEqual([]);
        await vi.advanceTimersByTimeAsync(60);
        expect(frames).toEqual([{ kind: "text", text: "abcde" }]);
        release();
        await done;
        expect(frames).toHaveLength(1);
    });
});
