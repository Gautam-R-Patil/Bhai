// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { planToolsBlock, toolFailed } from "./agent.js";

const msg = (content: string): ChatCompletionMessageParam => ({ role: "user", content });

describe("toolFailed", () => {
    it("uses the result flags, not the word error", () => {
        expect(toolFailed({ isError: false })).toBe(false);
        expect(toolFailed({ isError: true })).toBe(true);
        expect(toolFailed({ isError: false, reportedFailure: true })).toBe(true);
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
