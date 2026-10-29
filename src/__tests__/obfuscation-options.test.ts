// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Release builds obfuscate the bot bundle. javascript-obfuscator's
// controlFlowFlattening + transformObjectKeys together broke object literals
// in class fields (ChromePageProxy's mouse = {...} / keyboard = {...}): the
// flattening helper's const landed after its use, so extension clicks and key
// presses threw only in release builds. Running the obfuscator over the real
// bundle takes minutes, so this guards the pairing in the shipped configs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const optionBlocks = (file: string) => {
    const src = readFileSync(path.resolve("desktop/build", file), "utf8");
    const blocks: Record<string, unknown>[] = [];
    for (const m of src.matchAll(/const \w*OBFUSCATION_OPTIONS = \{/g)) {
        const start = (m.index ?? 0) + m[0].length - 1;
        const end = src.indexOf("\n};", start) + 2;
        blocks.push(new Function(`return (${src.slice(start, end)});`)() as Record<string, unknown>);
    }
    return blocks;
};

describe("release obfuscation options", () => {
    for (const file of ["protect-source.js", "obfuscate.js"]) {
        it(`${file}: transformObjectKeys is never on together with controlFlowFlattening`, () => {
            const blocks = optionBlocks(file);
            expect(blocks.length).toBeGreaterThan(0);
            for (const o of blocks) expect(Boolean(o.controlFlowFlattening && o.transformObjectKeys)).toBe(false);
        });
    }
});
