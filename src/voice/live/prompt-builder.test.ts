// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it, vi } from "vitest";

let preset: string | null = null;
vi.mock("../../config/system-prompts.js", () => ({ fetchSystemPrompts: async () => ({ identity: "ID" }) }));
vi.mock("./memory-bridge.js", () => ({ getFullMemoryContext: async () => "" }));
vi.mock("../../setup/personality-sync.js", () => ({
    getActivePreset: () => preset,
    getToneReminder: () => (preset ? `Tone right now: ${preset.toUpperCase()}` : null),
}));
const { buildVoiceSystemPrompt } = await import("./prompt-builder.js");

describe("buildVoiceSystemPrompt tone", () => {
    it("carries the Settings tone, but never the unhinged one", async () => {
        preset = "professional_concise";
        expect(await buildVoiceSystemPrompt()).toContain("Tone right now: PROFESSIONAL_CONCISE");
        preset = "unhinged";
        expect(await buildVoiceSystemPrompt()).not.toMatch(/Tone right now/);
    });
});
