// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import { guestHistory, historyForCaller } from "./guest-history.js";

describe("historyForCaller", () => {
    it("never hands a non-owner the owner's shared history", () => {
        const h = historyForCaller(undefined, { isOwner: false, channel: "discord", userId: "u1" });
        expect(h).toEqual([]); // a fresh guest history, not undefined (= the owner's)
        expect(historyForCaller(undefined, { isOwner: false, channel: "discord", userId: "u1" })).toBe(h);
        expect(historyForCaller(undefined, { isOwner: false, channel: "discord", userId: "u2" })).not.toBe(h);
        expect(historyForCaller(undefined, { isOwner: false, channel: "slack", userId: "u1" })).not.toBe(h);
    });

    it("leaves owner turns and explicit forks alone", () => {
        expect(historyForCaller(undefined, { isOwner: true, channel: "overlay" })).toBeUndefined();
        expect(historyForCaller(undefined, undefined)).toBeUndefined();
        const fork: ChatCompletionMessageParam[] = [];
        expect(historyForCaller(fork, { isOwner: false, channel: "whatsapp" })).toBe(fork);
    });
});

describe("guestHistory", () => {
    it("trims at a user turn so a tool result never loses its call", () => {
        const h = guestHistory("test", "trim");
        for (let i = 0; i < 15; i++) {
            h.push(
                { role: "user", content: `q${i}` },
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [{ id: `c${i}`, type: "function", function: { name: "x", arguments: "{}" } }],
                },
                { role: "tool", tool_call_id: `c${i}`, content: "ok" },
            );
        }
        const trimmed = guestHistory("test", "trim");
        expect(trimmed.length).toBeLessThanOrEqual(40);
        expect(trimmed[0].role).toBe("user");
    });
});
