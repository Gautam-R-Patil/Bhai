// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * OmniParser-v2 element detector wrapper.
 *
 * Shells out to scripts/omniparser_detect.py which uses YOLOv8 (and optionally
 * Florence-2) to find interactive UI elements in a screenshot. Gracefully
 * fails-open when the Python deps or model weights aren't installed — the
 * cascade router then falls through to OCR / vision-VLM.
 *
 * Install steps (user-facing):
 *   pip install ultralytics pillow
 *   # For OmniParser weights:
 *   huggingface-cli download microsoft/OmniParser-v2.0 --local-dir ~/.cache/omniparser
 *   # (Florence-2 captions optional, +770MB)
 *   huggingface-cli download microsoft/Florence-2-base --local-dir ~/.cache/florence2
 */

import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Reject screenshot paths outside known-safe directories (tmpdir + ATLAS Files/Screenshots).
 * Prevents an LLM-supplied path from causing arbitrary file reads via the Python script.
 */
function isSafeScreenshotPath(p: string): boolean {
    const abs = resolve(p);
    const cwd = resolve("");
    // Reject filesystem-root and tiny paths — ATLAS_WORKSPACE="/" would otherwise let any
    // absolute path pass startsWith. Found via DEEP R2 review.
    const isMeaningfulDir = (d: string): boolean => {
        if (!d || d === cwd) return false;
        if (d === "/" || d === "\\" || /^[A-Za-z]:\\?$/.test(d)) return false;
        if (d.length < 4) return false;
        return true;
    };
    const allowedDirs = [
        resolve(tmpdir()),
        "/tmp", // common shorthand for the per-user system tmp
        "/private/tmp", // macOS canonical (os.tmpdir() returns /var/folders/...)
        resolve(process.env.HOME || "", "Desktop", "A.T.L.A.S Files"),
        resolve(process.env.HOME || "", "Documents", "A.T.L.A.S Files"),
        resolve(process.env.HOME || "", "A.T.L.A.S Files"),
        resolve(process.env.HOME || "", "Library", "Caches", "atlas"),
        process.env.ATLAS_WORKSPACE ? resolve(process.env.ATLAS_WORKSPACE) : "",
    ].filter(isMeaningfulDir);
    return allowedDirs.some((d) => abs === d || abs.startsWith(`${d}/`) || abs.startsWith(`${d}\\`));
}

export interface OmniParserElement {
    id: number;
    bbox: [number, number, number, number]; // x1, y1, x2, y2
    score: number;
    classId: number;
    caption: string;
    role: string;
    center: { x: number; y: number };
}

export interface OmniParserResult {
    elements: OmniParserElement[];
    imageWidth: number;
    imageHeight: number;
    model: string;
    elapsedMs: number;
    error?: string;
}

export interface OmniParserOptions {
    captions?: boolean;
    maxElements?: number;
    confThreshold?: number;
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Detect interactive UI elements in a screenshot.
 * Returns `{ elements: [] }` with `error` field if the tool isn't installed.
 */
export async function detectElements(screenshotPath: string, opts: OmniParserOptions = {}): Promise<OmniParserResult> {
    if (!isSafeScreenshotPath(screenshotPath)) {
        return failureResult(`screenshot_path_rejected:must be under tmpdir or ATLAS Files directory`);
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const script = join(__dirname, "..", "..", "scripts", "omniparser_detect.py");
    const args = [script, screenshotPath];
    if (opts.captions) args.push("--captions");
    if (opts.maxElements) args.push("--max-elements", String(opts.maxElements));
    if (opts.confThreshold !== undefined) args.push("--conf-threshold", String(opts.confThreshold));

    // Cross-OS python binary picker (Windows ships `python`, others `python3`).
    const pyBin = process.platform === "win32" ? "python" : "python3";
    try {
        const { stdout } = await execFileAsync(pyBin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
        const trimmed = stdout.trim();
        if (trimmed.startsWith("error|")) {
            return failureResult(trimmed.slice("error|".length));
        }
        const parsed = JSON.parse(trimmed) as {
            elements: Array<{
                id: number;
                bbox: number[];
                score: number;
                class_id: number;
                caption: string;
                role: string;
            }>;
            image_size: [number, number];
            model: string;
            elapsed_ms: number;
        };
        const elements: OmniParserElement[] = parsed.elements.map((e) => ({
            id: e.id,
            bbox: [e.bbox[0], e.bbox[1], e.bbox[2], e.bbox[3]] as [number, number, number, number],
            score: e.score,
            classId: e.class_id,
            caption: e.caption,
            role: e.role,
            center: { x: Math.round((e.bbox[0] + e.bbox[2]) / 2), y: Math.round((e.bbox[1] + e.bbox[3]) / 2) },
        }));
        return {
            elements,
            imageWidth: parsed.image_size[0],
            imageHeight: parsed.image_size[1],
            model: parsed.model,
            elapsedMs: parsed.elapsed_ms,
        };
    } catch (err) {
        // Capture Python stderr (traceback) instead of generic "Command failed: python3 ..."
        const e = err as Error & { stderr?: string };
        return failureResult(e.stderr?.toString().trim() || e.message);
    }
}

function failureResult(message: string): OmniParserResult {
    return {
        elements: [],
        imageWidth: 0,
        imageHeight: 0,
        model: "unavailable",
        elapsedMs: 0,
        error: message,
    };
}

/**
 * Find the best-matching element by caption substring. Returns null if no element
 * has a caption that matches OR if captions weren't generated.
 */
export function findElementByCaption(elements: OmniParserElement[], query: string): OmniParserElement | null {
    if (!query) return null;
    const q = query.toLowerCase().trim();
    let best: { el: OmniParserElement; score: number } | null = null;
    for (const el of elements) {
        const cap = (el.caption || "").toLowerCase();
        if (!cap) continue;
        let textScore = 0;
        if (cap === q) textScore = 1.0;
        else if (cap.includes(q) || q.includes(cap)) textScore = 0.85;
        // Combine text-match score with detector confidence so identical text scores
        // pick the higher-confidence detection.
        const combined = textScore * 0.9 + el.score * 0.1;
        if (!best || combined > best.score) best = { el, score: combined };
    }
    if (!best || best.score < 0.5) return null;
    return best.el;
}
