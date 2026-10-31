// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The obfuscated bot bundle stays one byte per character in V8 (every
// character Latin-1): string and regex literals get \uXXXX escapes for
// anything above U+00FF, which the obfuscator leaves as written once
// unicodeEscapeSequence (escape everything, ASCII too) is off.
import { describe, expect, it } from "vitest";

const { escapeLiterals, OBFUSCATION_OPTIONS, archName } = require("../build/protect-source.js");

const nonLatin1 = (s) => [...s].filter((c) => c.codePointAt(0) > 0xff).length;
const BS = "\\";

describe("escapeLiterals", () => {
    it("writes module paths fully escaped and leaves other ASCII strings as they are", () => {
        const out = escapeLiterals("var init_x = __esm({'../dist/tools/x.js'() {}}); f('../dist', 'node:path');");
        expect(out).toContain(`__esm({'${BS}x2e${BS}x2e${BS}x2f${BS}x64${BS}x69${BS}x73${BS}x74${BS}x2f`);
        expect(out).not.toContain("dist/tools");
        expect(out).toContain("f('../dist', 'node:path')");
        expect(new Function(`return ${escapeLiterals("'../dist/a-b/c_d.js'")}`)()).toBe("../dist/a-b/c_d.js");
    });

    it("rewrites non-Latin-1 characters inside string and regex literals only", () => {
        const src = [
            "const a = /[ऀ-ॿ]+/g;",
            "const b = /\u{1F600}|❤️/u;",
            "const c = /café/;",
            `const d = /${BS}\u{1F600}/;`,
            `const e = /${BS}${BS}☃/;`,
            "const t = String.raw`☃`;",
            "const x = 4 / 2 / 1; const y = '☃';",
            `const z = "${BS}☃ café \u{1F600}";`,
            `const w = 'a${BS} b';`,
            "// ☃ comment",
        ].join("\n");
        const out = escapeLiterals(src);
        expect(out).toContain(`const a = /[${BS}u0900-${BS}u097f]+/g;`);
        expect(out).toContain(`const b = /${BS}ud83d${BS}ude00|${BS}u2764${BS}ufe0f/u;`);
        expect(out).toContain("const c = /café/;");
        expect(out).toContain(`const d = /${BS}ud83d${BS}ude00/;`);
        expect(out).toContain(`const e = /${BS}${BS}${BS}u2603/;`);
        expect(out).toContain("String.raw`☃`");
        expect(out).toContain(`const y = '${BS}u2603';`);
        expect(out).toContain(`const z = "${BS}u2603 café ${BS}ud83d${BS}ude00";`);
        expect(out).toContain("const w = 'ab';");
        expect(out).toContain("4 / 2 / 1");
        expect(out).toContain("// ☃ comment");
        expect(nonLatin1(out)).toBe(2);
    });

    it("keeps every string's value", () => {
        const lits = ["'☃'", '"café \u{1F600} नमस्ते"', `'${BS}☃'`, `'a${BS} b'`, "' '"];
        for (const lit of lits) {
            const out = escapeLiterals(lit);
            expect(nonLatin1(out)).toBe(0);
            expect(new Function(`return ${out}`)()).toBe(new Function(`return ${lit}`)());
        }
    });

    it("keeps every regex's behaviour", () => {
        const cases = [
            ["/[ऀ-ॿ]+/g", ["नमस्ते bhai", "hello"]],
            ["/\u{1F600}|❤️/u", ["a \u{1F600}", "❤️", "x"]],
            ["/[\u{1F300}-\u{1FAFF}]/u", ["\u{1F680}", "\u{1F600}", "a"]],
            ["/[\uD83C-\uDBFF][\uDC00-\uDFFF]/", ["\u{1F680}", "a"]],
            [`/${BS}\u{1F600}/`, ["\u{1F600}", "\uD83D"]],
            ["/[぀-ヿ一-鿿]/", ["日本", "abc"]],
        ];
        for (const [lit, inputs] of cases) {
            const before = new Function(`return ${lit}`)();
            const after = new Function(`return ${escapeLiterals(lit)}`)();
            expect(nonLatin1(after.source)).toBe(0);
            for (const s of inputs) {
                expect(s.replace(after, "#")).toBe(s.replace(before, "#"));
            }
        }
    });
});

describe("obfuscator options", () => {
    it("leaves ASCII unescaped (strings stay rc4-encrypted in the string array)", () => {
        expect(OBFUSCATION_OPTIONS.unicodeEscapeSequence).toBe(false);
        expect(OBFUSCATION_OPTIONS.stringArray).toBe(true);
        expect(OBFUSCATION_OPTIONS.stringArrayEncoding).toEqual(["rc4"]);
        expect(OBFUSCATION_OPTIONS.stringArrayThreshold).toBe(0.8);
        expect(OBFUSCATION_OPTIONS.splitStrings).toBe(true);
        expect(OBFUSCATION_OPTIONS.controlFlowFlattening).toBe(true);
        expect(OBFUSCATION_OPTIONS.controlFlowFlatteningThreshold).toBe(0.75);
        expect(OBFUSCATION_OPTIONS.deadCodeInjectionThreshold).toBe(0.3);
    });
});

describe("archName", () => {
    it("names electron-builder's Arch enum values", () => {
        expect(archName(3)).toBe("arm64");
        expect(archName(1)).toBe("x64");
        expect(archName(4)).toBe("universal");
        expect(archName("arm64")).toBe("arm64");
    });
});
