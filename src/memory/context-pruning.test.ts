// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "../llm.js";
import { avoidToolOrphan, compressToolHistory } from "./context-pruning.js";

describe("avoidToolOrphan — never start `recent` on an orphaned tool response", () => {
    const a = (id: string): ChatCompletionMessageParam =>
        ({ role: "assistant", tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }] }) as ChatCompletionMessageParam;
    const t = (id: string): ChatCompletionMessageParam => ({ role: "tool", tool_call_id: id, content: "r" });
    const u: ChatCompletionMessageParam = { role: "user", content: "hi" };

    it("advances past leading tool responses so the recent half starts on a non-tool message", () => {
        // split=1 lands on the first tool response, orphaning it from a(…) in the old half.
        const msgs = [a("c1"), t("c1"), t("c1"), u];
        const split = avoidToolOrphan(msgs, 1);
        expect(split).toBe(3);
        expect(msgs.slice(split)[0].role).not.toBe("tool");
    });

    it("leaves a split that already starts on a user/assistant message untouched", () => {
        const msgs = [a("c1"), t("c1"), u, a("c2"), t("c2")];
        expect(avoidToolOrphan(msgs, 2)).toBe(2); // on the user
        expect(avoidToolOrphan(msgs, 3)).toBe(3); // on the assistant
    });

    it("clamps to the end when the tail is all tool responses", () => {
        const msgs = [a("c1"), t("c1"), t("c1")];
        expect(avoidToolOrphan(msgs, 1)).toBe(3);
    });
});

// compressToolHistory only touches messages BEFORE the most-recent user turn.
// Every fixture therefore ends with a trailing user message that acts as the
// protected tail, with the messages-under-test placed before it.
const TAIL: ChatCompletionMessageParam = { role: "user", content: "latest turn" };

function withTail(...msgs: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
    return [...msgs, TAIL];
}

const ORIG_NO_PREPASS = process.env.ATLAS_NO_HISTORY_PREPASS;
const ORIG_STRIP_MEDIA = process.env.ATLAS_HISTORY_STRIP_MEDIA;

beforeEach(() => {
    delete process.env.ATLAS_NO_HISTORY_PREPASS;
    delete process.env.ATLAS_HISTORY_STRIP_MEDIA;
});

afterEach(() => {
    if (ORIG_NO_PREPASS === undefined) delete process.env.ATLAS_NO_HISTORY_PREPASS;
    else process.env.ATLAS_NO_HISTORY_PREPASS = ORIG_NO_PREPASS;
    if (ORIG_STRIP_MEDIA === undefined) delete process.env.ATLAS_HISTORY_STRIP_MEDIA;
    else process.env.ATLAS_HISTORY_STRIP_MEDIA = ORIG_STRIP_MEDIA;
});

describe("compressToolHistory — short tool result passthrough", () => {
    it("keeps a short tool result byte-for-byte inside the tool_log tags", () => {
        const out = compressToolHistory(
            withTail(
                { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] } as ChatCompletionMessageParam,
                { role: "tool", tool_call_id: "c1", content: "all good" },
            ),
        );
        const log = out.find((m) => m.role === "system");
        expect(log?.content).toContain(`<tool_log call_id="c1">all good</tool_log>`);
        expect(log?.content).not.toContain("(truncated)");
    });
});

describe("compressToolHistory — dedup", () => {
    it("collapses an identical later tool result into a back-reference", () => {
        const dup = "identical-output".repeat(20);
        const out = compressToolHistory(
            withTail(
                { role: "assistant", tool_calls: [{ id: "first", type: "function", function: { name: "web_search", arguments: "{}" } }] } as ChatCompletionMessageParam,
                { role: "tool", tool_call_id: "first", content: dup },
                { role: "assistant", tool_calls: [{ id: "second", type: "function", function: { name: "web_search", arguments: "{}" } }] } as ChatCompletionMessageParam,
                { role: "tool", tool_call_id: "second", content: dup },
            ),
        );
        const merged = out.filter((m) => m.role === "system").map((m) => m.content).join("\n");
        // First occurrence is kept (no back-ref), second becomes a back-ref to "first".
        expect(merged).toContain(`[duplicate of call first`);
        // Back-ref carries the 12-hex sha256.
        expect(merged).toMatch(/sha256:[0-9a-f]{12}\]/);
        // Only the second result is replaced; the first content survives somewhere.
        const backrefCount = (merged.match(/\[duplicate of call/g) || []).length;
        expect(backrefCount).toBe(1);
    });
});

describe("compressToolHistory — smart tool-aware cut", () => {
    it("smart-truncates an oversized shell_exec result preserving the error tail (not a flat head cut)", () => {
        const head = "starting build...\n".repeat(60); // > 500 chars of noise
        const errorFooter = "FATAL: compilation failed at line 999 — missing semicolon";
        const content = head + errorFooter;
        const out = compressToolHistory(
            withTail(
                { role: "assistant", tool_calls: [{ id: "sh1", type: "function", function: { name: "shell_exec", arguments: "{}" } }] } as ChatCompletionMessageParam,
                { role: "tool", tool_call_id: "sh1", content },
            ),
        );
        const log = out.find((m) => m.role === "system")?.content as string;
        expect(log).toContain("(truncated)");
        // tail_heavy keeps the error footer; the old flat 500-char head cut would drop it.
        expect(log).toContain(errorFooter);
        // And it should NOT have included the whole thing verbatim.
        expect(log.length).toBeLessThan(content.length);
    });
});

describe("compressToolHistory — arg truncation keeps valid JSON", () => {
    it("truncates long string args but the re-stringified arguments still JSON.parse", () => {
        const bigArg = JSON.stringify({ query: "z".repeat(5000), page: 2 });
        const out = compressToolHistory(
            withTail(
                { role: "assistant", tool_calls: [{ id: "a1", type: "function", function: { name: "web_search", arguments: bigArg } }] } as ChatCompletionMessageParam,
                { role: "tool", tool_call_id: "a1", content: "ok" },
            ),
        );
        const summary = out.find((m) => m.role === "system" && typeof m.content === "string" && (m.content as string).includes("[Tools Used]"))?.content as string;
        // Extract the args between the first "(" after the tool name and the trailing ")".
        const m = summary.match(/web_search\((\{.*\})\)/s);
        expect(m).not.toBeNull();
        const parsed = JSON.parse((m as RegExpMatchArray)[1]);
        expect(parsed.page).toBe(2);
        expect(parsed.query.length).toBeLessThan(5000);
        // Shorter than the original verbatim arg.
        expect((m as RegExpMatchArray)[1].length).toBeLessThan(bigArg.length);
    });

    it("falls back to a char cut on malformed args without throwing (fail-open)", () => {
        const malformed = "{not valid json " + "y".repeat(2000);
        expect(() =>
            compressToolHistory(
                withTail(
                    { role: "assistant", tool_calls: [{ id: "b1", type: "function", function: { name: "web_search", arguments: malformed } }] } as ChatCompletionMessageParam,
                    { role: "tool", tool_call_id: "b1", content: "ok" },
                ),
            ),
        ).not.toThrow();
    });
});

describe("compressToolHistory — media strip", () => {
    const base64 = "data:image/png;base64," + "A".repeat(4000);
    function mediaMsgs(): ChatCompletionMessageParam[] {
        return [
            { role: "user", content: "earlier turn" },
            {
                role: "assistant",
                content: [
                    { type: "text", text: "look at this" },
                    { type: "image_url", image_url: { url: base64 } },
                ] as unknown as string,
            },
            { role: "assistant", content: "ack" },
        ];
    }

    it("replaces historical image base64 with a placeholder when ATLAS_HISTORY_STRIP_MEDIA=true", () => {
        process.env.ATLAS_HISTORY_STRIP_MEDIA = "true";
        const out = compressToolHistory(withTail(...mediaMsgs()));
        const serialized = JSON.stringify(out);
        expect(serialized).toContain("[image omitted from history]");
        expect(serialized).not.toContain(base64);
    });

    it("keeps the image base64 when ATLAS_HISTORY_STRIP_MEDIA is unset", () => {
        const out = compressToolHistory(withTail(...mediaMsgs()));
        const serialized = JSON.stringify(out);
        expect(serialized).toContain(base64);
        expect(serialized).not.toContain("[image omitted from history]");
    });
});

describe("compressToolHistory — protected tail untouched", () => {
    it("leaves the latest user turn (and its images) byte-identical", () => {
        process.env.ATLAS_HISTORY_STRIP_MEDIA = "true";
        const base64 = "data:image/png;base64," + "B".repeat(2000);
        const tailWithImage: ChatCompletionMessageParam = {
            role: "user",
            content: [
                { type: "text", text: "current" },
                { type: "image_url", image_url: { url: base64 } },
            ] as unknown as string,
        };
        const dup = "same".repeat(200);
        const msgs: ChatCompletionMessageParam[] = [
            { role: "assistant", tool_calls: [{ id: "x1", type: "function", function: { name: "web_search", arguments: "{}" } }] } as ChatCompletionMessageParam,
            { role: "tool", tool_call_id: "x1", content: dup },
            tailWithImage,
            // After the last user message — also protected.
            { role: "assistant", content: "reply" },
        ];
        const out = compressToolHistory(msgs);
        // Tail user message must be the exact same object reference (copied verbatim).
        expect(out).toContain(tailWithImage);
        // Its image base64 survives despite ATLAS_HISTORY_STRIP_MEDIA=true.
        expect(JSON.stringify(tailWithImage)).toContain(base64);
        // Trailing assistant reply after the tail is preserved verbatim.
        expect(out.some((m) => m.role === "assistant" && m.content === "reply")).toBe(true);
    });
});

describe("compressToolHistory — kill switch reverts to flat behavior", () => {
    it("ATLAS_NO_HISTORY_PREPASS=true uses the old flat 500-char cut and verbatim args", () => {
        process.env.ATLAS_NO_HISTORY_PREPASS = "true";
        const content = "p".repeat(900);
        const bigArg = JSON.stringify({ query: "z".repeat(2000) });
        const out = compressToolHistory(
            withTail(
                { role: "assistant", tool_calls: [{ id: "k1", type: "function", function: { name: "web_search", arguments: bigArg } }] } as ChatCompletionMessageParam,
                { role: "tool", tool_call_id: "k1", content },
            ),
        );
        const merged = out.filter((m) => m.role === "system").map((m) => m.content).join("\n");
        // Flat cut: exactly the first 500 chars then "...(truncated)".
        expect(merged).toContain("p".repeat(500) + "...(truncated)");
        // No smart-cut markers and no dedup logic engaged.
        expect(merged).not.toContain("[truncated");
        expect(merged).not.toContain("[duplicate of call");
        // Args are verbatim (full 2000-char value present).
        expect(merged).toContain("z".repeat(2000));
    });
});
