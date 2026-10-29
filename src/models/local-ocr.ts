// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Local OCR Model ──────────────────────────────
 * Integration for GLM-OCR (0.9B, #1 OmniDocBench V1.5, 94.62).
 * Handles text, formula, table recognition at 1.86 pages/sec.
 * Deployable via Ollama or vLLM.
 *
 * Falls back to macOS native OCR (Vision framework) when model unavailable.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withCursorHidden } from "../screen/agent-cursor.js";

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────

export interface OCRResult {
    text: string;
    regions: Array<{
        text: string;
        type: "text" | "formula" | "table" | "heading";
        bounds: { x: number; y: number; width: number; height: number };
        confidence: number;
    }>;
    source: "glm-ocr" | "macos-vision" | "fallback";
    processingMs: number;
}

// ── State ─────────────────────────────────────

let ollamaAvailable: boolean | null = null;
const GLM_OCR_MODEL = "glm-ocr";

// ── OCR Pipeline ──────────────────────────────

/**
 * Run OCR on an image file. Tries GLM-OCR via Ollama first,
 * falls back to macOS Vision framework.
 */
export async function runOCR(imagePath: string): Promise<OCRResult> {
    const start = Date.now();

    if (!fs.existsSync(imagePath)) {
        return { text: "", regions: [], source: "fallback", processingMs: 0 };
    }

    // Try GLM-OCR via Ollama
    if (await isOllamaAvailable()) {
        try {
            const result = await runGLMOCR(imagePath);
            result.processingMs = Date.now() - start;
            return result;
        } catch {
            console.warn("[OCR] GLM-OCR failed, falling back to macOS Vision");
        }
    }

    // Fallback: macOS Vision framework
    try {
        const result = await runMacOSVision(imagePath);
        result.processingMs = Date.now() - start;
        return result;
    } catch {
        return { text: "", regions: [], source: "fallback", processingMs: Date.now() - start };
    }
}

/**
 * Run OCR on a screenshot (takes screenshot first if no path provided).
 */
export async function ocrScreen(region?: { x: number; y: number; w: number; h: number }): Promise<OCRResult> {
    const tmpPath = path.join(tmpdir(), "atlas-ocr-screenshot.png");

    try {
        if (region) {
            await withCursorHidden(() => execFileAsync("screencapture", [
                "-x", "-R", `${region.x},${region.y},${region.w},${region.h}`, tmpPath,
            ]));
        } else {
            await withCursorHidden(() => execFileAsync("screencapture", ["-x", tmpPath]));
        }

        return await runOCR(tmpPath);
    } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* */ }
    }
}

// ── GLM-OCR via Ollama ────────────────────────

async function runGLMOCR(imagePath: string): Promise<OCRResult> {
    // Read image as base64
    const imageData = fs.readFileSync(imagePath).toString("base64");

    // Call Ollama API
    const response = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: GLM_OCR_MODEL,
            prompt: "Extract all text from this image. Include tables and formulas. Return plain text.",
            images: [imageData],
            stream: false,
        }),
    });

    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);

    const data = await response.json() as { response: string };
    const text = data.response || "";

    return {
        text,
        regions: [{ text, type: "text", bounds: { x: 0, y: 0, width: 0, height: 0 }, confidence: 0.9 }],
        source: "glm-ocr",
        processingMs: 0,
    };
}

// ── macOS Vision Framework ────────────────────

async function runMacOSVision(imagePath: string): Promise<OCRResult> {
    // Use the built-in macOS Vision framework via Swift/AppleScript
    const script = `
        use framework "Vision"
        use framework "AppKit"

        set imagePath to "${imagePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
        set imageURL to current application's NSURL's fileURLWithPath:imagePath
        set img to current application's NSImage's alloc()'s initWithContentsOfURL:imageURL

        if img is missing value then return ""

        set cgImage to img's CGImageForProposedRect:(missing value) context:(missing value) hints:(missing value)
        set requestHandler to current application's VNImageRequestHandler's alloc()'s initWithCGImage:cgImage options:(current application's NSDictionary's dictionary())

        set ocrRequest to current application's VNRecognizeTextRequest's alloc()'s init()
        ocrRequest's setRecognitionLevel:(current application's VNRequestTextRecognitionLevelAccurate)

        requestHandler's performRequests:(current application's NSArray's arrayWithObject:ocrRequest) |error|:(missing value)

        set results to ocrRequest's results()
        set outputText to ""

        repeat with obs in results
            set outputText to outputText & (obs's topCandidates:1's firstObject()'s |string|() as text) & linefeed
        end repeat

        return outputText
    `;

    try {
        const { stdout } = await execFileAsync("osascript", ["-l", "AppleScript", "-e", script], {
            timeout: 10000,
        });
        const text = stdout.trim();
        return {
            text,
            regions: [{ text, type: "text", bounds: { x: 0, y: 0, width: 0, height: 0 }, confidence: 0.85 }],
            source: "macos-vision",
            processingMs: 0,
        };
    } catch {
        // Even simpler fallback using screencapture + shortcuts
        return { text: "", regions: [], source: "fallback", processingMs: 0 };
    }
}

// ── Availability Check ────────────────────────

async function isOllamaAvailable(): Promise<boolean> {
    if (ollamaAvailable !== null) return ollamaAvailable;

    try {
        const response = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
        if (response.ok) {
            const data = await response.json() as { models: Array<{ name: string }> };
            ollamaAvailable = data.models?.some(m => m.name.includes("glm-ocr")) || false;
            if (!ollamaAvailable) {
                console.log("[OCR] GLM-OCR model not found in Ollama. Using macOS Vision fallback.");
            }
            return ollamaAvailable;
        }
    } catch { /* */ }

    ollamaAvailable = false;
    return false;
}
