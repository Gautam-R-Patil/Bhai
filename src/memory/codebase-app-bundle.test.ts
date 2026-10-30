// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The first-coding-turn index skips the packaged app's own folder; a real repo is still indexed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "codebase-bundle-data-"));

function project(withBundle: boolean): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codebase-bundle-"));
    fs.writeFileSync(path.join(dir, "main.ts"), "export function hello(): string { return 'hi'; }\n");
    if (withBundle) fs.writeFileSync(path.join(dir, "bot-bundle.mjs"), "/* obfuscated */\n");
    return dir;
}

it("indexes a project but not Bhai's own bundle folder", async () => {
    const { ensureIndexForCoding, getArchitectureSnippet } = await import("./codebase-index.js");
    const { hasSidecar } = await import("./codebase-sidecar.js");
    const repo = project(false);
    const app = project(true);
    await ensureIndexForCoding(repo);
    await ensureIndexForCoding(app);
    expect(hasSidecar(repo)).toBe(true);
    expect(hasSidecar(app)).toBe(false);
    expect(await getArchitectureSnippet(app)).toBe("");
});
