// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Turn events: the streamed answer, its resets, steps and owner-only notes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ fireOnce: false }));
const research = vi.hoisted(() => ({ args: undefined as Record<string, unknown> | undefined }));
vi.mock("./tools/index.js", async (orig) => {
    const mod = await orig<typeof import("./tools/index.js")>();
    return {
        ...mod,
        executeTool: async (name: string, input: Record<string, unknown>) => {
            if (name !== "deep_research") return mod.executeTool(name, input);
            research.args = input;
            return JSON.stringify({ status: "started" });
        },
    };
});
vi.mock("./account-guard.js", async (orig) => ({
    ...(await orig<typeof import("./account-guard.js")>()),
    checkAccountStatus: async () => ({ allowed: true }),
}));
vi.mock("./agents/verify-before-done.js", async (orig) => ({
    ...(await orig<typeof import("./agents/verify-before-done.js")>()),
    shouldForceVerify: () => {
        const fire = gate.fireOnce;
        gate.fireOnce = false;
        return fire;
    },
}));

import { type ChannelContext, getConversationHistory, runAgent } from "./agent.js";
import type { LLMClient } from "./llm.js";
import type { LLMDelta } from "./llm-stream.js";
import { AnswerStreamFilter } from "./stream-filter.js";
import type { TurnEvent } from "./turn-events.js";

type Step = {
    deltas: LLMDelta[];
    content: string;
    tools?: string[];
    /** Runs after the deltas: e.g. abort the turn and throw like llm.ts does. */
    after?: () => void;
};
type Req = { onDelta?: (d: LLMDelta) => void; signal?: AbortSignal };

/** Main-loop calls (the ones given onDelta) play `script` in order; helper calls get "ok". */
function fakeLLM(script: Step[]) {
    const calls: Req[] = [];
    const llm = {
        chat: async (req: Req) => {
            calls.push(req);
            const step = req.onDelta ? script.shift() : undefined;
            if (!step) return { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
            for (const d of step.deltas) req.onDelta?.(d);
            step.after?.();
            const tool_calls = step.tools?.map((name, i) => ({
                id: `t${i}`,
                type: "function",
                function: { name, arguments: "{}" },
            }));
            return {
                choices: [
                    {
                        message: { role: "assistant", content: step.content, tool_calls },
                        finish_reason: tool_calls ? "tool_calls" : "stop",
                    },
                ],
            };
        },
    } as unknown as LLMClient;
    return { llm, calls };
}

const text = (t: string): LLMDelta => ({ kind: "text", text: t });
const owner = (events: TurnEvent[]): ChannelContext => ({
    channel: "overlay",
    userId: "owner",
    isOwner: true,
    isPrivate: true,
    onTurnEvent: (e) => events.push(e),
});
const answers = (events: TurnEvent[]) =>
    events.flatMap((e) => (e.type === "answer" ? [e.text] : e.type === "answer_reset" ? ["|reset|"] : [])).join("");
const notes = (events: TurnEvent[]) => events.flatMap((e) => (e.type === "note" ? [e.text] : [])).join("");

const run = (llm: LLMClient, msg: string, ctx: ChannelContext, signal?: AbortSignal) =>
    runAgent(llm, msg, undefined, undefined, signal, undefined, undefined, undefined, ctx);

describe("turn events", () => {
    beforeEach(() => {
        gate.fireOnce = false;
    });

    it("a plain answer streams as answer events", async () => {
        const events: TurnEvent[] = [];
        const { llm } = fakeLLM([
            { deltas: [text("Paris is "), text("the capital of France.")], content: "Paris is the capital of France." },
        ]);
        const res = await run(llm, "what is the capital of france", owner(events));
        expect(res.text).toBe("Paris is the capital of France.");
        expect(answers(events)).toBe("Paris is the capital of France.");
        expect(events.at(-1)).toEqual({ type: "end" });
    }, 60_000);

    it("narration before a tool call resets and becomes a note", async () => {
        const events: TurnEvent[] = [];
        const { llm } = fakeLLM([
            {
                deltas: [text("Let me check the clock."), { kind: "tool", name: "get_current_time" }],
                content: "Let me check the clock.",
                tools: ["get_current_time"],
            },
            { deltas: [text("It is noon.")], content: "It is noon." },
        ]);
        await run(llm, "what time is it right now", owner(events));
        expect(answers(events)).toBe("Let me check the clock.|reset|It is noon.");
        expect(notes(events)).toContain("Let me check the clock.");
        const reset = events.find((e) => e.type === "answer_reset");
        const last = events.filter((e) => e.type === "answer").at(-1);
        expect(reset).toEqual({ type: "answer_reset", attempt: 0 });
        expect(last).toMatchObject({ attempt: 1 });
        expect(events.some((e) => e.type === "step")).toBe(true);
    }, 60_000);

    it("a reply sent back by the verify gate is reset", async () => {
        const events: TurnEvent[] = [];
        gate.fireOnce = true;
        const { llm } = fakeLLM([
            { deltas: [text("Sent it.")], content: "Sent it." },
            { deltas: [text("Sent and checked.")], content: "Sent and checked." },
        ]);
        const res = await run(llm, "send the note to priya", owner(events));
        expect(res.text).toBe("Sent and checked.");
        expect(answers(events)).toBe("Sent it.|reset|Sent and checked.");
        expect(events).toContainEqual(
            expect.objectContaining({ type: "step", text: "Checking it actually worked", state: "running" }),
        );
    }, 60_000);

    it("guests get no notes", async () => {
        const events: TurnEvent[] = [];
        const { llm } = fakeLLM([
            { deltas: [{ kind: "note", text: "Thinking about it.\n" }, text("Hello!")], content: "Hello!" },
        ]);
        await run(llm, "hello there", {
            channel: "web-widget",
            userId: "guest-1",
            isOwner: false,
            onTurnEvent: (e) => events.push(e),
        });
        expect(events.some((e) => e.type === "note")).toBe(false);
        expect(answers(events)).toBe("Hello!");
    }, 60_000);

    it("owners get notes", async () => {
        const events: TurnEvent[] = [];
        const { llm } = fakeLLM([
            { deltas: [{ kind: "note", text: "Thinking about it.\n" }, text("Hello!")], content: "Hello!" },
        ]);
        await run(llm, "hello there", owner(events));
        expect(notes(events)).toBe("Thinking about it.\n");
    }, 60_000);

    it("stop keeps the partial answer", async () => {
        const events: TurnEvent[] = [];
        const ctrl = new AbortController();
        const deltas = [text("The first half "), text("of the answer")];
        const { llm } = fakeLLM([
            {
                deltas,
                content: "",
                after: () => {
                    ctrl.abort();
                    throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
                },
            },
        ]);
        const res = await run(llm, "explain the plan in detail", owner(events), ctrl.signal);
        const f = new AnswerStreamFilter({ channel: "overlay" });
        const expected = deltas.map((d) => f.push((d as { text: string }).text)).join("") + f.flush();
        expect(res.partialText).toBe(expected);
        expect(res.stopped).toBe(true);
        const last = getConversationHistory().at(-1);
        expect(last).toEqual({ role: "assistant", content: `${expected} [stopped]` });
        expect(events.some((e) => e.type === "answer_reset")).toBe(false);
    }, 60_000);

    it("no onTurnEvent means no onDelta passed", async () => {
        const { llm, calls } = fakeLLM([]);
        await run(llm, "what is the capital of france", { channel: "overlay", userId: "owner", isOwner: true });
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every((c) => !("onDelta" in c) && !("signal" in c))).toBe(true);
    }, 60_000);

    it("a main-loop call that throws after streaming is reset", async () => {
        const events: TurnEvent[] = [];
        const { llm } = fakeLLM([
            {
                deltas: [text("Half an ans")],
                content: "",
                after: () => {
                    throw Object.assign(new Error("stream cut"), { status: 502 });
                },
            },
            { deltas: [text("The full answer.")], content: "The full answer." },
        ]);
        const res = await run(llm, "tell me the answer please", owner(events));
        expect(res.text).toBe("The full answer.");
        expect(answers(events)).toBe("Half an ans|reset|The full answer.");
    }, 60_000);

    it("a sink that throws never breaks the turn", async () => {
        gate.fireOnce = true; // a send-back adds turn nudges that must still be stripped
        const { llm } = fakeLLM([
            { deltas: [text("Sent it.")], content: "Sent it." },
            { deltas: [text("Sent and checked.")], content: "Sent and checked." },
        ]);
        const res = await run(llm, "send the note to priya", {
            channel: "overlay",
            userId: "owner",
            isOwner: true,
            isPrivate: true,
            onTurnEvent: () => {
                throw new Error("socket gone");
            },
        });
        expect(res.text).toBe("Sent and checked.");
        const nudges = getConversationHistory().filter((m) => String(m.content).startsWith("[Automatic check"));
        expect(nudges).toEqual([]);
    }, 60_000);

    it("the research continuation's context has no onTurnEvent", async () => {
        const events: TurnEvent[] = [];
        research.args = undefined;
        const { llm } = fakeLLM([
            { deltas: [], content: "", tools: ["deep_research"] },
            { deltas: [text("Research started.")], content: "Research started." },
        ]);
        await run(llm, "research the best laptops of 2026 for me", owner(events));
        const args = research.args as Record<string, unknown> | undefined;
        const ctx = args?._channelContext as ChannelContext | undefined;
        expect(ctx).toMatchObject({ channel: "overlay", isOwner: true });
        expect(ctx?.onTurnEvent).toBeUndefined();
    }, 60_000);
});
