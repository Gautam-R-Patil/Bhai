// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Launch guards for the task-critical browser path (Site Skill runtime, browser
// tools, Chrome bridge): no fixed sleeps, nothing that only runs on a Mac.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ts = (dir: string) =>
    readdirSync(path.join(root, dir))
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => `${dir}/${f}`);
const FILES = [
    ...ts("src/skills/site"),
    // CAPTCHA solving is human-paced on purpose (and polls solver APIs): not a page wait.
    ...ts("src/tools/browser").filter((f) => !path.basename(f).startsWith("captcha")),
    "chrome-extension/background.js",
    "chrome-extension/content.js",
];

function hits(re: RegExp, allow?: RegExp): string[] {
    return FILES.flatMap((f) =>
        readFileSync(path.join(root, f), "utf8")
            .split("\n")
            .flatMap((line, i) => {
                const t = line.trim();
                if (t.startsWith("//") || t.startsWith("*") || !re.test(line) || allow?.test(line)) return [];
                return [`${f}:${i + 1}: ${t}`];
            }),
    );
}

describe("task-critical browser path", () => {
    it("has no fixed sleeps: wait on a page condition (waitForPageReady, waitForFunction), polls end in `// poll`", () => {
        const fixed =
            /\b(?:sleep|waitForTimeout)\(\s*\d+\s*\)|new Promise\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*setTimeout\(\s*\1\s*,\s*\d+\s*\)\s*\)/;
        expect(hits(fixed, /\/\/ poll\b/)).toEqual([]);
    });

    it("calls nothing macOS-only (it has to run the same on Windows)", () => {
        const mac = /osascript|screencapture|\bswift\b|\.swift\b|pbcopy|pbpaste|dump_ax|sandbox-exec|NSWorkspace/;
        expect(hits(mac)).toEqual([]);
    });
});
