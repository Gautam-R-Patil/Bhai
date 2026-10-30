// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Moving, copying and renaming files had no tool: models dragged in Finder or used shell mv.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compressFiles } from "../file-utils.js";
import { fileManage, listDirectory } from "../files.js";

const run = async (args: Record<string, unknown>) => JSON.parse(await fileManage.handler(args));

describe("file_manage", () => {
    const dir = mkdtempSync(join(homedir(), ".bhai-file-manage-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("makes a folder, moves files into it, renames and copies", async () => {
        writeFileSync(join(dir, "a.txt"), "a");
        writeFileSync(join(dir, "b.txt"), "b");
        expect((await run({ action: "new_folder", paths: [join(dir, "Reports")] })).success).toBe(true);

        const moved = await run({ action: "move", paths: [join(dir, "a.txt"), join(dir, "b.txt")], destination: join(dir, "Reports") });
        expect(moved.success).toBe(true);
        expect(existsSync(join(dir, "Reports", "a.txt")) && !existsSync(join(dir, "a.txt"))).toBe(true);

        expect((await run({ action: "rename", paths: [join(dir, "Reports", "a.txt")], destination: "old-a.txt" })).success).toBe(true);
        expect(readFileSync(join(dir, "Reports", "old-a.txt"), "utf8")).toBe("a");

        expect((await run({ action: "copy", paths: [join(dir, "Reports")], destination: join(dir, "Backup") })).success).toBe(true);
        expect(readFileSync(join(dir, "Backup", "b.txt"), "utf8")).toBe("b");
        expect(existsSync(join(dir, "Reports", "b.txt"))).toBe(true);
    });

    it("never overwrites, never moves a folder into itself, checks everything first", async () => {
        mkdirSync(join(dir, "x"), { recursive: true });
        writeFileSync(join(dir, "x", "keep.txt"), "original");
        writeFileSync(join(dir, "keep.txt"), "new");
        const clash = await run({ action: "move", paths: [join(dir, "keep.txt")], destination: join(dir, "x") });
        expect(clash.error).toMatch(/Already exists/);
        expect(readFileSync(join(dir, "x", "keep.txt"), "utf8")).toBe("original");
        expect(existsSync(join(dir, "keep.txt"))).toBe(true); // untouched

        expect((await run({ action: "move", paths: [join(dir, "x")], destination: join(dir, "x", "inner") })).error).toMatch(
            /inside itself/,
        );
        // One missing source: nothing moves.
        writeFileSync(join(dir, "c.txt"), "c");
        const partial = await run({ action: "move", paths: [join(dir, "c.txt"), join(dir, "nope.txt")], destination: join(dir, "x") });
        expect(partial.error).toMatch(/Not found/);
        expect(existsSync(join(dir, "c.txt"))).toBe(true);
    });

    // From the harder eval: nano made the folder via destination, then moved a.pdf to
    // ".../PDFs" before it existed, and the PDF became a file named PDFs.
    it("reads the model's intent: destination folders, extensionless new folders", async () => {
        const base = join(dir, "intent");
        mkdirSync(base);
        writeFileSync(join(base, "a.pdf"), "a");
        writeFileSync(join(base, "b.pdf"), "b");
        expect((await run({ action: "new_folder", paths: [base], destination: join(base, "Made") })).created).toEqual([
            join(base, "Made"),
        ]);
        const r = await run({ action: "move", paths: [join(base, "a.pdf")], destination: join(base, "PDFs") });
        expect(r.made_folder).toBe(join(base, "PDFs"));
        expect(readFileSync(join(base, "PDFs", "a.pdf"), "utf8")).toBe("a");
        // An extension in the destination is still a new name.
        await run({ action: "move", paths: [join(base, "b.pdf")], destination: join(base, "c.pdf") });
        expect(existsSync(join(base, "c.pdf"))).toBe(true);
    });

    // From the 35-task nano run: action "write" seven times, told only "Provide 'paths'".
    it("points other jobs at their tool", async () => {
        expect((await run({ action: "write", file_path: join(dir, "t.txt") })).error).toMatch(/use write/);
        expect((await run({ action: "zip", paths: [dir] })).error).toMatch(/compress_files/);
        expect((await run({ action: "merge", paths: [dir] })).error).toMatch(/pdf_edit/);
    });

    // From the media eval: "convert photo.png to a JPG" done as a rename.
    it("won't pass a rename off as a conversion", async () => {
        writeFileSync(join(dir, "pic.png"), "png bytes");
        const r = await run({ action: "rename", paths: [join(dir, "pic.png")], destination: "pic.jpg" });
        expect(r.error).toMatch(/image_edit/);
        expect(existsSync(join(dir, "pic.png"))).toBe(true);
        // Text formats rename freely.
        writeFileSync(join(dir, "n.txt"), "n");
        expect((await run({ action: "rename", paths: [join(dir, "n.txt")], destination: "n.md" })).success).toBe(true);
    });

    // From the 35-task nano run: ditto replaced an existing BhaiEval.zip without a word.
    it.skipIf(process.platform !== "darwin")("compress_files never replaces an archive", async () => {
        const src = join(dir, "zipme");
        mkdirSync(src);
        writeFileSync(join(src, "f.txt"), "f");
        writeFileSync(join(dir, "zipme.zip"), "precious");
        const r = JSON.parse(await compressFiles.handler({ action: "zip", paths: [src], archive_path: join(dir, "zipme.zip") }));
        expect(r.archive).toBe(join(dir, "zipme 2.zip"));
        expect(readFileSync(join(dir, "zipme.zip"), "utf8")).toBe("precious");
        // Named after the folder, in output_dir.
        const r2 = JSON.parse(await compressFiles.handler({ action: "zip", paths: [src], output_dir: src }));
        expect(r2.archive).toBe(join(src, "zipme.zip"));
        // Zipping a zip is a mistaken unzip.
        const z = JSON.parse(await compressFiles.handler({ action: "zip", paths: [join(dir, "zipme.zip")] }));
        expect(z.error).toMatch(/already a zip/);
    });

    // From the harder eval: asked to count the .txt files, gpt-4.1-nano counted every file.
    it("list_directory counts each kind", async () => {
        const sub = join(dir, "kinds");
        mkdirSync(sub);
        for (const f of ["a.txt", "b.txt", "c.md"]) writeFileSync(join(sub, f), f);
        mkdirSync(join(sub, "inner"));
        const r = JSON.parse(await listDirectory.handler({ path: sub }));
        expect(r.by_kind).toEqual({ txt: 2, md: 1, folders: 1 });
    });
});
