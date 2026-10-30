// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// From the all-nano eval: find_files("BhaiEval", folder ~/Desktop) found nothing for a folder
// made seconds before, because Spotlight hadn't indexed it yet.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => Object.defineProperty(process, "platform", { value: "darwin" }));
vi.mock("node:child_process", async (orig) => ({
    ...(await orig<typeof import("node:child_process")>()),
    // Spotlight knows nothing yet.
    execFile: (_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) =>
        cb(null, { stdout: "", stderr: "" }),
}));

const { findFiles } = await import("../file-utils.js");

describe("find_files before Spotlight has indexed", () => {
    const dir = mkdtempSync(join(tmpdir(), "bhai-find-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("scans the folder it was given", async () => {
        mkdirSync(join(dir, "BhaiEval"));
        writeFileSync(join(dir, "BhaiEval", "notes.txt"), "eval");
        const r = JSON.parse(await findFiles.handler({ query: "bhaieval", folder: dir }));
        expect(r.files.map((f: { path: string }) => f.path)).toEqual([join(dir, "BhaiEval")]);
        const notes = JSON.parse(await findFiles.handler({ query: "notes", folder: dir }));
        expect(notes.files[0].path).toBe(join(dir, "BhaiEval", "notes.txt"));
    });
});
