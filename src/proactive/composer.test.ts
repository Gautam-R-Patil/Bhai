// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { compose } from "./composer.js";
import type { ProactiveIntent } from "./intent.js";

// Mock the Convex prompt fetcher so tests don't hit the network
vi.mock("../config/system-prompts.js", () => ({
    fetchSystemPrompt: vi.fn().mockResolvedValue("STUB SYSTEM PROMPT"),
}));

const baseIntent: ProactiveIntent = {
    id: "t1",
    source: "long_task_status",
    mode: "fyi",
    urgency: "normal",
    channelPreference: "any",
    topic: "task",
    topicEmbedding: new Array(384).fill(0),
    evidence: [],
    payload: { kind: "long_task_status", task: "migration", summary: "done" },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
};

describe("Composer template fast path", () => {
    it("produces deterministic text for long_task_status", async () => {
        const r = await compose(baseIntent, "whatsapp", { tone: "neutral" }, [], { llm: null });
        expect(r?.text).toBe("Done with migration. done");
        expect(r?.modeTag).toBe("fyi");
    });

    it("returns null when required payload field missing", async () => {
        const broken: ProactiveIntent = { ...baseIntent, payload: { kind: "long_task_status" } };
        const r = await compose(broken, "whatsapp", { tone: "neutral" }, [], { llm: null });
        expect(r).toBeNull();
    });

    it("produces text for convex_notification", async () => {
        const intent: ProactiveIntent = {
            ...baseIntent,
            source: "convex_notification",
            payload: { kind: "convex_notification", warning: "credits low" },
        };
        const r = await compose(intent, "telegram", { tone: "neutral" }, [], { llm: null });
        expect(r?.text).toBe("Heads up — credits low");
    });

    it("produces text for calendar_fusion", async () => {
        const intent: ProactiveIntent = {
            ...baseIntent,
            source: "calendar_fusion",
            payload: { kind: "calendar_fusion", event: "Standup", newTime: "10:30", impacted: "gym block" },
        };
        const r = await compose(intent, "whatsapp", { tone: "neutral" }, [], { llm: null });
        expect(r?.text).toBe("Standup moved to 10:30 — your gym block now overlaps");
    });
});

describe("Composer LLM fallback — fail-closed behavior", () => {
    function makeFakeLlm(content: string) {
        return {
            chat: vi.fn().mockResolvedValue({
                choices: [{ message: { content } }],
            }),
        } as any;
    }

    const memIntent: ProactiveIntent = {
        ...baseIntent,
        source: "memory_anticipation",
        payload: { kind: "memory_anticipation", hint: "x" },
    };

    it("returns null when LLM returns skip:true", async () => {
        const llm = makeFakeLlm('{"skip": true}');
        const r = await compose(memIntent, "whatsapp", { tone: "neutral" }, [], { llm });
        expect(r).toBeNull();
    });

    it("returns null when LLM returns malformed JSON", async () => {
        const llm = makeFakeLlm("this is not JSON");
        const r = await compose(memIntent, "whatsapp", { tone: "neutral" }, [], { llm });
        expect(r).toBeNull();
    });

    it("returns null when LLM throws", async () => {
        const llm = { chat: vi.fn().mockRejectedValue(new Error("boom")) } as any;
        const r = await compose(memIntent, "whatsapp", { tone: "neutral" }, [], { llm });
        expect(r).toBeNull();
    });

    it("returns text when LLM returns a well-formed clean response", async () => {
        const llm = makeFakeLlm('{"text":"You left the hero mid-layout. Resume now?","modeTag":"question","skip":false}');
        const questionIntent: ProactiveIntent = { ...memIntent, mode: "question" };
        const r = await compose(questionIntent, "whatsapp", { tone: "neutral" }, [], { llm });
        expect(r?.text).toMatch(/you/i);
        expect(r?.modeTag).toBe("question");
    });

    it("returns null when LLM returns no content at all", async () => {
        const llm = { chat: vi.fn().mockResolvedValue({ choices: [{ message: { content: "" } }] }) } as any;
        const r = await compose(memIntent, "whatsapp", { tone: "neutral" }, [], { llm });
        expect(r).toBeNull();
    });
});

describe("Composer banned-phrase filter", () => {
    function makeFakeLlm(content: string) {
        return {
            chat: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }),
        } as any;
    }

    const memIntent: ProactiveIntent = {
        ...baseIntent,
        source: "memory_anticipation",
        payload: { kind: "memory_anticipation", hint: "x" },
    };

    for (const banned of [
        "might be worth", "probably useful", "worth a quick recap",
        "been away for", "could be helpful", "just checking in",
        "wanted to ask", "a quick thought", "might be good to", "worth checking",
    ]) {
        it(`rejects text containing "${banned}"`, async () => {
            const llm = makeFakeLlm(JSON.stringify({ text: `Hey — ${banned} checking in`, modeTag: "fyi", skip: false }));
            const r = await compose(memIntent, "whatsapp", { tone: "neutral" }, [], { llm });
            expect(r).toBeNull();
        });
    }
});

describe("Composer third-person filter", () => {
    function makeFakeLlm(content: string) {
        return { chat: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }) } as any;
    }

    const memIntent: ProactiveIntent = {
        ...baseIntent,
        source: "memory_anticipation",
        payload: { kind: "memory_anticipation", hint: "x" },
    };

    it("rejects text saying 'the user'", async () => {
        const llm = makeFakeLlm(JSON.stringify({ text: "Reminder: the user should rest.", modeTag: "fyi", skip: false }));
        const r = await compose(memIntent, "whatsapp", { tone: "neutral" }, [], { llm });
        expect(r).toBeNull();
    });

    it("rejects 'user is' patterns", async () => {
        const llm = makeFakeLlm(JSON.stringify({ text: "Note: user is tired.", modeTag: "fyi", skip: false }));
        const r = await compose(memIntent, "whatsapp", { tone: "neutral" }, [], { llm });
        expect(r).toBeNull();
    });

    it("rejects 'user will' patterns", async () => {
        const llm = makeFakeLlm(JSON.stringify({ text: "Note: user will arrive soon.", modeTag: "fyi", skip: false }));
        const r = await compose(memIntent, "whatsapp", { tone: "neutral" }, [], { llm });
        expect(r).toBeNull();
    });

    it("rejects 'user would' patterns", async () => {
        const llm = makeFakeLlm(JSON.stringify({ text: "Note: user would prefer quiet.", modeTag: "fyi", skip: false }));
        const r = await compose(memIntent, "whatsapp", { tone: "neutral" }, [], { llm });
        expect(r).toBeNull();
    });
});
