// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// 40-task nano run: glob({ pattern, folder: "~/Desktop" }) searched Bhai's working directory.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { glob } from "./glob.js";

const dir = mkdtempSync(join(tmpdir(), "bhai-glob-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("reads folder as the path to search", async () => {
    writeFileSync(join(dir, "b.pdf"), "x");
    const r = JSON.parse(await glob.handler({ pattern: "*.pdf", folder: dir }));
    expect(r.base_path).toBe(dir);
    expect(r.files).toEqual([join(dir, "b.pdf")]);
});

// Full-50 PLAN run: glob({ pattern: "~/Downloads/*.pdf" }) searched Bhai's working directory.
it("takes the folder from the start of a home or absolute pattern", async () => {
    const home = mkdtempSync(join(homedir(), ".bhai-glob-"));
    try {
        writeFileSync(join(home, "c.pdf"), "x");
        const r = JSON.parse(await glob.handler({ pattern: `~/${home.slice(homedir().length + 1)}/*.pdf` }));
        expect(r.base_path).toBe(home);
        expect(r.files).toEqual([join(home, "c.pdf")]);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
