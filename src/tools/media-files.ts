// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Images and PDFs: convert/resize a photo, merge/split PDFs. Without these, "convert
// this HEIC to JPG" or "combine these PDFs" meant shell commands, which small models
// fumble and file routes don't offer. Outputs go next to the input and never replace
// an existing file.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { manageRefusal } from "./files.js";
import type { ToolDefinition } from "./get-current-time.js";

const execFileAsync = promisify(execFile);
const IMAGE_FORMATS: Record<string, string> = { jpg: "jpeg", jpeg: "jpeg", png: "png", heic: "heic", tiff: "tiff", gif: "gif", bmp: "bmp", pdf: "pdf" };

/** `wanted`, or "name 2.ext", "name 3.ext"… if it exists. */
function freePath(wanted: string): string {
    const ext = path.extname(wanted);
    let p = wanted;
    for (let n = 2; fs.existsSync(p); n++) p = `${wanted.slice(0, wanted.length - ext.length)} ${n}${ext}`;
    return p;
}

/** The one file named like `p` in the usual folders (two levels down), if exactly one. */
function sameNameNearby(p: string): string | undefined {
    const name = path.basename(p);
    const hits: string[] = [];
    const walk = (d: string, left: number) => {
        let ents: fs.Dirent[];
        try {
            ents = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of ents) {
            if (e.name.startsWith(".")) continue;
            if (e.name === name && e.isFile()) hits.push(path.join(d, e.name));
            else if (e.isDirectory() && left > 0) walk(path.join(d, e.name), left - 1);
        }
    };
    for (const dir of ["Desktop", "Documents", "Downloads"]) walk(path.join(os.homedir(), dir), 2);
    return hits.length === 1 ? hits[0] : undefined;
}

/** Checks the inputs; a path that isn't there but one file of that name is nearby means that
 *  one (gpt-4.1-nano asked for ~/Desktop/photo.png; it was in ~/Desktop/BhaiEval). */
function checkIn(paths: string[]): { paths: string[]; note?: string } | { error: string } {
    const out: string[] = [];
    let note: string | undefined;
    for (const p of paths) {
        let q = p;
        if (!fs.existsSync(p)) {
            const near = sameNameNearby(p);
            if (!near) return { error: `Not found: ${p}` };
            [q, note] = [near, `${p} doesn't exist; used ${near}.`];
        }
        const refused = manageRefusal(q, true);
        if (refused) return { error: refused };
        out.push(q);
    }
    return { paths: out, note };
}

const fail = (error: string) => JSON.stringify({ success: false, error });

export const imageEdit: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "image_edit",
            description:
                "Convert an image to another format (jpg, png, heic, tiff, gif, bmp, pdf), resize it, or read its size and format. Saves next to the original, never replacing a file. Only that: to change what's IN a picture (remove something, change the background, restyle) use generate_image with source.",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["convert", "resize", "info"] },
                    path: { type: "string", description: "The image file" },
                    format: { type: "string", description: "convert: jpg, png, heic, tiff, gif, bmp or pdf" },
                    width: { type: "number", description: "resize: width in pixels (keeps the proportions unless height is given too)" },
                    height: { type: "number", description: "resize: height in pixels" },
                    output: { type: "string", description: "Where to save (default: next to the original)" },
                },
                required: ["action", "path"],
            },
        },
    },
    async handler(input) {
        const action = String(input.action ?? "");
        const checked = checkIn([path.resolve(String(input.path ?? "").trim())]);
        if ("error" in checked) return fail(checked.error);
        const src = checked.paths[0];
        const found = checked.note ? { note_path: checked.note } : {};

        const info = async (p: string) => {
            if (process.platform === "darwin") {
                const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "format", p]);
                const get = (k: string) => new RegExp(`${k}: (\\S+)`).exec(stdout)?.[1];
                return { width: Number(get("pixelWidth")), height: Number(get("pixelHeight")), format: get("format") };
            }
            const sharp = (await import("sharp")).default;
            const m = await sharp(p).metadata();
            return { width: m.width, height: m.height, format: m.format };
        };

        try {
            if (action === "info") return JSON.stringify({ success: true, path: src, ...found, ...(await info(src)) });

            const fmt = String(input.format ?? "").toLowerCase().replace(/^\./, "");
            if (action === "convert" && !IMAGE_FORMATS[fmt])
                return fail(`format must be one of: ${Object.keys(IMAGE_FORMATS).join(", ")}`);
            // gpt-4.1-nano "converted" photo.png to png on the way to a JPG.
            if (action === "convert" && (await info(src)).format === IMAGE_FORMATS[fmt])
                return fail(`${path.basename(src)} is already ${fmt}. Convert it to the format you want instead.`);
            const width = Number(input.width) || 0;
            const height = Number(input.height) || 0;
            if (action === "resize" && !width && !height) return fail("resize needs width and/or height.");
            if (action !== "convert" && action !== "resize") return fail("action must be convert, resize or info.");

            const ext = action === "convert" ? `.${fmt === "jpeg" ? "jpg" : fmt}` : path.extname(src);
            const base = src.slice(0, src.length - path.extname(src).length);
            const wanted = input.output
                ? path.resolve(String(input.output))
                : action === "resize"
                  ? `${base}-${width || "auto"}x${height || "auto"}${ext}`
                  : `${base}${ext}`;
            const out = freePath(wanted);
            const refused = manageRefusal(out, false);
            if (refused) return fail(refused);

            if (process.platform === "darwin") {
                const args =
                    action === "convert"
                        ? ["-s", "format", IMAGE_FORMATS[fmt]]
                        : width && height
                          ? ["-z", String(height), String(width)]
                          : width
                            ? ["--resampleWidth", String(width)]
                            : ["--resampleHeight", String(height)];
                await execFileAsync("sips", [...args, src, "--out", out], { timeout: 60_000 });
            } else {
                const sharp = (await import("sharp")).default;
                let img = sharp(src);
                if (action === "resize") img = img.resize(width || undefined, height || undefined, { fit: width && height ? "fill" : "inside" });
                else img = img.toFormat(IMAGE_FORMATS[fmt] as "jpeg");
                await img.toFile(out);
            }
            return JSON.stringify({
                success: true,
                action,
                saved: out,
                ...found,
                ...(await info(out)),
                ...(out !== wanted ? { note: `${wanted} already existed, so this is a new file.` } : {}),
            });
        } catch (err) {
            return fail((err as Error).message.slice(0, 300));
        }
    },
};

/** "1-3, 5" → [0, 1, 2, 4] (0-based), within 1..count. */
export function parsePages(spec: string, count: number): number[] {
    const out: number[] = [];
    for (const part of spec.split(/[,\s]+/).filter(Boolean)) {
        const [a, b] = part.split("-").map((n) => (n === "" ? Number.NaN : Number(n)));
        const lo = Number.isNaN(a) ? 1 : a;
        const hi = part.includes("-") ? (Number.isNaN(b) ? count : b) : lo;
        for (let p = lo; p <= hi; p++) if (p >= 1 && p <= count && !out.includes(p - 1)) out.push(p - 1);
    }
    return out;
}

export const pdfEdit: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "pdf_edit",
            description:
                "Merge PDFs into one, pull some pages out into a new PDF, or count a PDF's pages. Saves next to the first file, never replacing one.",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["merge", "extract_pages", "info"] },
                    paths: { type: "array", items: { type: "string" }, description: "merge: the PDFs in order. Otherwise one PDF." },
                    pages: { type: "string", description: "extract_pages: e.g. '1-3, 5'" },
                    output: { type: "string", description: "Where to save (default: next to the first PDF)" },
                },
                required: ["action", "paths"],
            },
        },
    },
    async handler(input) {
        const action = String(input.action ?? "");
        const raw = input.paths ?? (input as { path?: unknown }).path;
        const asked = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((p) => path.resolve(String(p).trim()));
        if (!asked.length) return fail("Provide 'paths'.");
        const checked = checkIn(asked);
        if ("error" in checked) return fail(checked.error);
        const paths = checked.paths;
        try {
            const { PDFDocument } = await import("pdf-lib");
            const load = async (p: string) => PDFDocument.load(fs.readFileSync(p), { ignoreEncryption: true });

            if (action === "info") {
                const docs = await Promise.all(paths.map(load));
                return JSON.stringify({ success: true, files: paths.map((p, i) => ({ path: p, pages: docs[i].getPageCount() })) });
            }
            if (action !== "merge" && action !== "extract_pages") return fail("action must be merge, extract_pages or info.");
            if (action === "merge" && paths.length < 2) return fail("merge needs two or more PDFs.");

            const out = await PDFDocument.create();
            for (const p of action === "merge" ? paths : paths.slice(0, 1)) {
                const doc = await load(p);
                const pick =
                    action === "merge" ? doc.getPageIndices() : parsePages(String(input.pages ?? ""), doc.getPageCount());
                if (!pick.length) return fail(`No such pages in ${path.basename(p)} (it has ${doc.getPageCount()}).`);
                for (const page of await out.copyPages(doc, pick)) out.addPage(page);
            }
            const first = paths[0].slice(0, paths[0].length - path.extname(paths[0]).length);
            const wanted = input.output
                ? path.resolve(String(input.output))
                : action === "merge"
                  ? `${path.join(path.dirname(paths[0]), "Merged")}.pdf`
                  : `${first} (pages ${String(input.pages).replace(/\s+/g, "")}).pdf`;
            const dest = freePath(wanted.toLowerCase().endsWith(".pdf") ? wanted : `${wanted}.pdf`);
            const refused = manageRefusal(dest, false);
            if (refused) return fail(refused);
            fs.writeFileSync(dest, await out.save());
            return JSON.stringify({
                success: true,
                action,
                saved: dest,
                pages: out.getPageCount(),
                ...(dest !== wanted ? { note: `${wanted} already existed, so this is a new file.` } : {}),
            });
        } catch (err) {
            return fail((err as Error).message.slice(0, 300));
        }
    },
};
