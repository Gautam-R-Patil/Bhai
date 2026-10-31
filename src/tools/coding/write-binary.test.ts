// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// 50-task run: gpt-4.1-nano "made a PDF" by writing a sentence to photo.pdf.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { write } from "./write.js";

const dir = mkdtempSync(join(homedir(), ".bhai-write-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("won't write text into a binary format", async () => {
    const r = JSON.parse(await write.handler({ file_path: join(dir, "photo.pdf"), content: "This is a PDF" }));
    expect(r.error).toMatch(/pdf_edit/);
    expect(JSON.parse(await write.handler({ file_path: join(dir, "notes.txt"), content: "ok" })).success).toBe(true);
});
