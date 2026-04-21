// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi } from "vitest";
import { parseMonitorRule } from "./monitor-parser.js";

vi.mock("../../config/system-prompts.js", () => ({
    fetchSystemPrompt: vi.fn().mockResolvedValue("STUB PARSER PROMPT"),
}));

function makeLlm(content: string) {
    return {
        chat: vi.fn().mockResolvedValue({
            choices: [{ message: { content } }],
        }),
    } as any;
}

function embedOk() {
    return async () => new Array(384).fill(0.1);
}

describe("parseMonitorRule", () => {
    it("returns error for empty phrase", async () => {
        const r = await parseMonitorRule("", { llm: makeLlm(""), embedText: embedOk() });
        expect(r.kind).toBe("error");
    });

    it("returns ok on well-formed JSON", async () => {
        const llm = makeLlm(JSON.stringify({
            topic: "hackathon sponsors",
            scope: { channels: ["whatsapp"], excludeSelf: true },
            urgency: "normal",
            action: { defaultMode: "question" },
            threshold: 0.82,
            cooldownMinutes: 60,
        }));
        const r = await parseMonitorRule("ping me if anyone mentions hackathon sponsors",
            { llm, embedText: embedOk() });
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            expect(r.input.topic).toBe("hackathon sponsors");
            expect(r.input.scope.channels).toEqual(["whatsapp"]);
            expect(r.input.urgency).toBe("normal");
            expect(r.input.threshold).toBe(0.82);
            expect(r.input.cooldownMinutes).toBe(60);
            expect(r.input.topicEmbedding.length).toBe(384);
            expect(r.input.userPhrase).toBe("ping me if anyone mentions hackathon sponsors");
        }
    });

    it("returns clarify when the LLM asks", async () => {
        const llm = makeLlm(JSON.stringify({ needsClarification: "which channel should I watch?" }));
        const r = await parseMonitorRule("ping me if X", { llm, embedText: embedOk() });
        expect(r.kind).toBe("clarify");
        if (r.kind === "clarify") expect(r.question).toMatch(/channel/i);
    });

    it("returns error on malformed JSON", async () => {
        const llm = makeLlm("this is not JSON");
        const r = await parseMonitorRule("test", { llm, embedText: embedOk() });
        expect(r.kind).toBe("error");
    });

    it("returns error when LLM throws", async () => {
        const llm = { chat: vi.fn().mockRejectedValue(new Error("network")) } as any;
        const r = await parseMonitorRule("test", { llm, embedText: embedOk() });
        expect(r.kind).toBe("error");
        if (r.kind === "error") expect(r.error).toMatch(/network/i);
    });

    it("clamps threshold to [0.6, 0.95]", async () => {
        const llm = makeLlm(JSON.stringify({
            topic: "x",
            scope: { channels: ["*"], excludeSelf: true },
            urgency: "normal",
            action: { defaultMode: "fyi" },
            threshold: 2.0,  // out of range
            cooldownMinutes: 60,
        }));
        const r = await parseMonitorRule("test", { llm, embedText: embedOk() });
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") expect(r.input.threshold).toBe(0.95);

        const llm2 = makeLlm(JSON.stringify({
            topic: "x",
            scope: { channels: ["*"], excludeSelf: true },
            urgency: "normal",
            action: { defaultMode: "fyi" },
            threshold: 0.1,
            cooldownMinutes: 60,
        }));
        const r2 = await parseMonitorRule("test", { llm: llm2, embedText: embedOk() });
        if (r2.kind === "ok") expect(r2.input.threshold).toBe(0.6);
    });

    it("enforces cooldownMinutes >= 5", async () => {
        const llm = makeLlm(JSON.stringify({
            topic: "x",
            scope: { channels: ["*"], excludeSelf: true },
            urgency: "normal",
            action: { defaultMode: "fyi" },
            threshold: 0.82,
            cooldownMinutes: 1,
        }));
        const r = await parseMonitorRule("test", { llm, embedText: embedOk() });
        if (r.kind === "ok") expect(r.input.cooldownMinutes).toBe(5);
    });

    it("defaults missing fields to sensible values", async () => {
        const llm = makeLlm(JSON.stringify({ topic: "x", scope: { excludeSelf: true } }));
        const r = await parseMonitorRule("test", { llm, embedText: embedOk() });
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            expect(r.input.scope.channels).toEqual(["*"]);
            expect(r.input.urgency).toBe("normal");
            expect(r.input.action.defaultMode).toBe("question");
            expect(r.input.threshold).toBe(0.82);
            expect(r.input.cooldownMinutes).toBe(60);
        }
    });

    it("rejects unknown channel names", async () => {
        const llm = makeLlm(JSON.stringify({
            topic: "x",
            scope: { channels: ["xmpp"], excludeSelf: true },
            urgency: "normal",
            action: { defaultMode: "fyi" },
            threshold: 0.82,
            cooldownMinutes: 60,
        }));
        const r = await parseMonitorRule("test", { llm, embedText: embedOk() });
        expect(r.kind).toBe("error");
        if (r.kind === "error") expect(r.error).toMatch(/invalid channel/i);
    });

    it("errors when embedding has wrong length", async () => {
        const llm = makeLlm(JSON.stringify({
            topic: "x",
            scope: { channels: ["*"], excludeSelf: true },
            urgency: "normal",
            action: { defaultMode: "fyi" },
            threshold: 0.82,
            cooldownMinutes: 60,
        }));
        const badEmbed = async () => new Array(10).fill(0);
        const r = await parseMonitorRule("test", { llm, embedText: badEmbed });
        expect(r.kind).toBe("error");
    });

    it("accepts Float32Array embedding", async () => {
        const llm = makeLlm(JSON.stringify({
            topic: "x",
            scope: { channels: ["*"], excludeSelf: true },
            urgency: "normal",
            action: { defaultMode: "fyi" },
            threshold: 0.82,
            cooldownMinutes: 60,
        }));
        const f32Embed = async () => new Float32Array(384).fill(0.5);
        const r = await parseMonitorRule("test", { llm, embedText: f32Embed });
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") expect(r.input.topicEmbedding.length).toBe(384);
    });

    it("carries userPhrase verbatim", async () => {
        const phrase = "ping me when sharath mentions VCs in build3";
        const llm = makeLlm(JSON.stringify({
            topic: "vc mentions by sharath in build3",
            scope: { channels: ["whatsapp"], groups: ["build3"], senders: ["sharath"], excludeSelf: true },
            urgency: "normal",
            action: { defaultMode: "question" },
            threshold: 0.82,
            cooldownMinutes: 60,
        }));
        const r = await parseMonitorRule(phrase, { llm, embedText: embedOk() });
        if (r.kind === "ok") expect(r.input.userPhrase).toBe(phrase);
    });
});
