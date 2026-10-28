// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Playwright sends a page callback as fn.toString(). The release obfuscator
// rewrites string literals into calls to a decoder that only exists in Node,
// so an unmarked callback throws "ReferenceError: <decoder> is not defined" in
// the page — only in the packaged app (browser_extract, captcha detection and
// the popup guard all broke this way). Every inline callback must sit between
// the obfuscator's disable/enable comments, the enable one leading the next
// argument (the only place esbuild keeps it).
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..");
const METHODS = new Set(["evaluate", "evaluateHandle", "waitForFunction", "$eval", "$$eval", "evaluateAll"]);

function files(dir: string, out: string[] = []): string[] {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) files(p, out);
        else if (p.endsWith(".ts") && !/\.(test|d)\.ts$/.test(p)) out.push(p);
    }
    return out;
}

describe("page callbacks survive the release obfuscator", () => {
    it("every inline evaluate/waitForFunction callback is marked", () => {
        const unmarked: string[] = [];
        for (const file of files(SRC)) {
            const text = fs.readFileSync(file, "utf8");
            if (!/\.(evaluate|evaluateHandle|waitForFunction|\$eval|\$\$eval|evaluateAll)\(/.test(text)) continue;
            const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
            const visit = (n: ts.Node) => {
                if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && METHODS.has(n.expression.name.text)) {
                    const args = n.arguments;
                    const i = args.findIndex((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
                    if (i >= 0) {
                        const lead = text.slice(args[i].getFullStart(), args[i].getStart());
                        const next = args[i + 1] ? text.slice(args[i + 1].getFullStart(), args[i + 1].getStart()) : "";
                        if (!lead.includes("javascript-obfuscator:disable") || !next.includes("javascript-obfuscator:enable")) {
                            unmarked.push(`${path.relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
                        }
                    }
                }
                ts.forEachChild(n, visit);
            };
            visit(sf);
        }
        expect(unmarked).toEqual([]);
    });
});
