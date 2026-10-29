// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { afterEach, describe, expect, it, vi } from "vitest";

// buildRecap reads getConversationHistory() from ../agent.js; mock that module
// so the test is hermetic (no real agent state, no LLM).
const mockHistory = vi.fn();
vi.mock("../agent.js", () => ({ getConversationHistory: () => mockHistory() }));

describe("buildRecap", () => {
    afterEach(() => mockHistory.mockReset());

    it("reports an empty recap when there is no history", async () => {
        mockHistory.mockReturnValue([]);
        const { buildRecap } = await import("./recap.js");
        expect(buildRecap()).toContain("No conversation yet");
    });

    it("classifies tool activity and lists touched files", async () => {
        mockHistory.mockReturnValue([
            { role: "user", content: "edit the config" },
            {
                role: "assistant",
                content: "",
                tool_calls: [
                    { id: "1", function: { name: "write", arguments: JSON.stringify({ file_path: "src/a.ts" }) } },
                    { id: "2", function: { name: "web_search", arguments: JSON.stringify({ query: "x" }) } },
                    {
                        id: "3",
                        function: { name: "shell_exec", arguments: JSON.stringify({ command: "cat src/b.ts" }) },
                    },
                ],
            },
            { role: "tool", tool_call_id: "1", content: "ok" },
        ]);
        const { buildRecap } = await import("./recap.js");
        const out = buildRecap();
        expect(out).toContain("Recap");
        expect(out).toContain("1 user message");
        expect(out).toContain("3 tool call");
        expect(out).toContain("Editing files");
        expect(out).toContain("Research");
        expect(out).toContain("src/a.ts");
        expect(out).toContain("src/b.ts");
    });

    it("survives malformed tool arguments without throwing", async () => {
        mockHistory.mockReturnValue([
            {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "1", function: { name: "write", arguments: "{not json" } }],
            },
        ]);
        const { buildRecap } = await import("./recap.js");
        expect(() => buildRecap()).not.toThrow();
    });
});
