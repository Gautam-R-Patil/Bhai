// © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import { antiGivingUpFailures, finalReplyText, isDeferrable, planToolsBlock, toolFailed } from "./agent.js";

const msg = (content: string): ChatCompletionMessageParam => ({ role: "user", content });

describe("toolFailed", () => {
    it("uses the result flags, not the word error", () => {
        expect(toolFailed({ isError: false })).toBe(false);
        expect(toolFailed({ isError: true })).toBe(true);
        expect(toolFailed({ isError: false, reportedFailure: true })).toBe(true);
    });
});

describe("isDeferrable", () => {
    const call = (name: string, args: object) => ({ function: { name, arguments: JSON.stringify(args) } });
    it("runs pins and supersedes in the foreground so a refusal reaches the model", () => {
        expect(isDeferrable(call("memory_store", { content: "x" }))).toBe(true);
        expect(isDeferrable(call("memory_store", { content: "x", pin_id: 42 }))).toBe(false);
        expect(isDeferrable(call("memory_store", { content: "x", supersedes: 7 }))).toBe(false);
        expect(isDeferrable(call("memory_store", { content: "x", pin: true }))).toBe(false);
        expect(isDeferrable(call("memory_search", { query: "x" }))).toBe(false);
    });
});

describe("planToolsBlock", () => {
    it("lists only the given tools with their first sentence", () => {
        const block = planToolsBlock([
            { function: { name: "whatsapp_send", description: "Send a WhatsApp message. Long details here." } },
            { function: { name: "os_type" } },
        ]);
        expect(block).toBe("- whatsapp_send: Send a WhatsApp message.\n- os_type: ");
    });
});

describe("finalReplyText", () => {
    const tg = { channel: "telegram", userId: "1", isOwner: true };
    it("keeps an exact [NO_REPLY] for channels that stay silent", () => {
        for (const channel of ["telegram", "whatsapp", "discord", "slack", "matrix"]) {
            expect(finalReplyText(" [NO_REPLY]\n", { ...tg, channel })).toBe("[NO_REPLY]");
        }
    });
    it("strips it everywhere else, so the overlay and autonomous runs still answer", () => {
        expect(finalReplyText("[NO_REPLY]", { ...tg, channel: "overlay" })).toBe("");
        expect(finalReplyText("[NO_REPLY]", { ...tg, autonomous: true })).toBe("");
        expect(finalReplyText("[NO_REPLY]")).toBe("");
        expect(finalReplyText("ok [NO_REPLY]", tg)).toBe("ok");
    });
});

describe("antiGivingUpFailures", () => {
    const ownerNeeded: ChatCompletionMessageParam = {
        role: "tool",
        tool_call_id: "t1",
        content: JSON.stringify({
            error: "This page is waiting on the owner.",
            owner_needed: "This page has a step only the owner can finish.",
        }),
    };
    const history = [msg("open my bank site and download the statement"), ownerNeeded];
    const handoff = "You need to finish the check in the browser window.";

    it("forces a retry on a short hand-off after a failure", () => {
        expect(antiGivingUpFailures(history, "open my bank site and download the statement", handoff, 2)).toBe(1);
    });
    it("never retries an owner_needed result followed by a stuck report", () => {
        expect(
            antiGivingUpFailures(history, "open my bank site and download the statement", `${handoff}\n[[STUCK]]`, 2),
        ).toBe(0);
    });
});
