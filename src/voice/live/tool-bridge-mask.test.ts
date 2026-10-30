// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Native live voice sends tool results straight to the provider: they are masked first.
import { expect, it, vi } from "vitest";

vi.mock("../../tools/index.js", () => ({
    executeTool: async () => JSON.stringify({ text: "Your card 4111 1111 1111 1111 was charged; code 482913" }),
    getToolSchemasByNames: () => [],
}));
const { executeVoiceToolCalls } = await import("./tool-bridge.js");

it("a card number in a tool result never reaches the voice model", async () => {
    const [r] = await executeVoiceToolCalls([{ id: "1", name: "clipboard", args: {} }]);
    expect(String(r.result)).not.toContain("4111 1111 1111 1111");
    expect(String(r.result)).toContain("charged");
});
