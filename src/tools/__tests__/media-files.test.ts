// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Converting/resizing images and merging/splitting PDFs had no tool (shell only).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imageEdit, parsePages, pdfEdit } from "../media-files.js";

const run = async (tool: typeof imageEdit, args: Record<string, unknown>) => JSON.parse(await tool.handler(args));

describe("image_edit and pdf_edit", () => {
    const dir = mkdtempSync(join(homedir(), ".bhai-media-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    beforeAll(async () => {
        await sharp({ create: { width: 400, height: 200, channels: 3, background: "#3366ff" } })
            .png()
            .toFile(join(dir, "photo.png"));
        for (const [name, n] of [["a.pdf", 2], ["b.pdf", 3]] as const) {
            const doc = await PDFDocument.create();
            for (let i = 0; i < n; i++) doc.addPage();
            writeFileSync(join(dir, name), await doc.save());
        }
    });

    it("converts, resizes and reads an image, never replacing a file", async () => {
        const c = await run(imageEdit, { action: "convert", path: join(dir, "photo.png"), format: "jpg" });
        expect(c.saved).toBe(join(dir, "photo.jpg"));
        expect(readFileSync(c.saved).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG
        const again = await run(imageEdit, { action: "convert", path: join(dir, "photo.png"), format: "jpg" });
        expect(again.saved).toBe(join(dir, "photo 2.jpg"));

        const r = await run(imageEdit, { action: "resize", path: join(dir, "photo.png"), width: 100 });
        expect([r.width, r.height]).toEqual([100, 50]); // proportions kept
        expect(await run(imageEdit, { action: "info", path: join(dir, "photo.png") })).toMatchObject({ width: 400, height: 200 });
        expect((await run(imageEdit, { action: "convert", path: join(dir, "photo.png"), format: "xyz" })).error).toMatch(/format/);
    });

    it("merges PDFs, pulls pages out, counts pages", async () => {
        const m = await run(pdfEdit, { action: "merge", paths: [join(dir, "a.pdf"), join(dir, "b.pdf")], output: join(dir, "both.pdf") });
        expect(m).toMatchObject({ success: true, pages: 5, saved: join(dir, "both.pdf") });
        const x = await run(pdfEdit, { action: "extract_pages", paths: [join(dir, "both.pdf")], pages: "2-3, 5" });
        expect(x.pages).toBe(3);
        expect(existsSync(x.saved)).toBe(true);
        expect((await run(pdfEdit, { action: "info", paths: [join(dir, "b.pdf")] })).files[0].pages).toBe(3);
    });

    it("reads page ranges", () => {
        expect(parsePages("1-3, 5", 10)).toEqual([0, 1, 2, 4]);
        expect(parsePages("8-", 10)).toEqual([7, 8, 9]);
        expect(parsePages("12", 10)).toEqual([]);
    });
});
