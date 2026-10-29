// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Guards the prefix-cache stability invariant for reflection LLM calls:
// the frozen instruction constants must carry ZERO per-session volatile
// content (no template interpolation, timestamps, digits, or "session"
// references) so the Anthropic prefix-cache key stays byte-identical
// across runs. All volatile content lives in the user message instead.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(__dirname, "reflection.ts"), "utf8");

const FROZEN_CONSTANTS = [
    "REFLECTION_SUMMARY_INSTRUCTION",
    "REFLECTION_SIGNALS_INSTRUCTION",
    "REFLECTION_LEARNINGS_INSTRUCTION",
    "REFLECTION_CODING_INSTRUCTION",
    "REFLECTION_NARRATIVE_INSTRUCTION",
];

function extractTemplate(name: string): string {
    const decl = `const ${name} = \``;
    const start = SOURCE.indexOf(decl);
    if (start === -1) throw new Error(`Constant ${name} not found`);
    const bodyStart = start + decl.length;
    const end = SOURCE.indexOf("`;", bodyStart);
    if (end === -1) throw new Error(`Closing backtick for ${name} not found`);
    return SOURCE.slice(bodyStart, end);
}

describe("reflection frozen instructions are prefix-cache stable", () => {
    for (const name of FROZEN_CONSTANTS) {
        it(`${name} contains no template interpolation`, () => {
            const body = extractTemplate(name);
            expect(body).not.toMatch(/\$\{/);
        });
    }

    it("each reflection llm.chat call uses a frozen instruction constant, not an inline systemPrompt string", () => {
        // Every systemPrompt passed to llm.chat must reference one of the
        // frozen constants — never a bare string literal that could vary.
        const systemPromptLines = SOURCE.split("\n").filter((l) => /systemPrompt:/.test(l));
        expect(systemPromptLines.length).toBeGreaterThan(0);
        for (const line of systemPromptLines) {
            const usesFrozen = FROZEN_CONSTANTS.some((c) => line.includes(c));
            expect(usesFrozen, `inline systemPrompt found: ${line.trim()}`).toBe(true);
        }
    });
});
