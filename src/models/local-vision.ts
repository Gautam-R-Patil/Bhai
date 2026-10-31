// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Local Vision Model (SmolVLM-256M) ────────────
 * Always-on ambient visual awareness using SmolVLM-256M.
 * Encodes images in only 81 tokens (vs 16K for Qwen2-VL).
 * Runs on CPU. Provides lightweight image understanding for:
 *   - Screen change detection
 *   - Ambient desktop awareness
 *   - Quick image description without API calls
 *   - Screenshot analysis for proactive monitors
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withCursorHidden } from "../screen/agent-cursor.js";

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────

export interface VisionResult {
    description: string;
    objects: string[];              // Detected objects/elements
    textContent: string;            // Any text visible in image
    sceneType: string;              // "desktop" | "webpage" | "document" | "photo" | "unknown"
    confidence: number;
    source: "smolvlm" | "ollama-llava" | "fallback";
    processingMs: number;
}

export interface ScreenChangeDetection {
    hasChanged: boolean;
    changeType: "none" | "minor" | "major" | "app_switch";
    description: string;
}

// ── State ─────────────────────────────────────

let lastScreenHash = "";
let lastScreenDescription = "";
const SMOLVLM_MODEL = "smolvlm";  // Ollama model name

// ── Vision Analysis ───────────────────────────

/**
 * Analyze an image using local vision model.
 * Tries SmolVLM via Ollama, then LLaVA, then basic heuristics.
 */
export async function analyzeImage(
    imagePath: string,
    prompt = "Describe what you see in this image briefly.",
): Promise<VisionResult> {
    const start = Date.now();

    if (!fs.existsSync(imagePath)) {
        return emptyResult(start);
    }

    // Try SmolVLM via Ollama
    try {
        const result = await queryOllamaVision(imagePath, prompt, SMOLVLM_MODEL);
        if (result) {
            result.processingMs = Date.now() - start;
            result.source = "smolvlm";
            return result;
        }
    } catch { /* */ }

    // Try LLaVA as fallback (more common in Ollama)
    try {
        const result = await queryOllamaVision(imagePath, prompt, "llava");
        if (result) {
            result.processingMs = Date.now() - start;
            result.source = "ollama-llava";
            return result;
        }
    } catch { /* */ }

    // Fallback: file metadata + basic analysis
    return {
        description: "Image analysis unavailable (no local vision model)",
        objects: [],
        textContent: "",
        sceneType: "unknown",
        confidence: 0.1,
        source: "fallback",
        processingMs: Date.now() - start,
    };
}

/**
 * Quick screen analysis for proactive monitoring.
 * Takes a screenshot and describes what's visible.
 */
export async function analyzeScreen(
    prompt = "What application is the user working in? What are they doing? Brief answer.",
): Promise<VisionResult> {
    const tmpPath = path.join(tmpdir(), "bhai-vision-screen.png");

    try {
        // Take a downsized screenshot (faster processing)
        await withCursorHidden(() => execFileAsync("screencapture", ["-x", "-t", "png", tmpPath]));

        // Downscale for faster VLM processing
        try {
            await execFileAsync("sips", ["-Z", "512", tmpPath], { timeout: 3000 });
        } catch { /* sips not available or failed */ }

        return await analyzeImage(tmpPath, prompt);
    } catch {
        return emptyResult(Date.now());
    } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* */ }
    }
}

// ── Screen Change Detection ───────────────────

/**
 * Detect if the screen has changed significantly since last check.
 * Uses image hashing for fast comparison without VLM.
 */
export async function detectScreenChange(): Promise<ScreenChangeDetection> {
    const tmpPath = path.join(tmpdir(), "bhai-vision-change.png");

    try {
        await withCursorHidden(() => execFileAsync("screencapture", ["-x", "-t", "png", tmpPath]));

        // Simple file hash for change detection
        const stat = fs.statSync(tmpPath);
        const hash = `${stat.size}_${stat.mtimeMs}`;

        if (hash === lastScreenHash) {
            return { hasChanged: false, changeType: "none", description: "No change" };
        }

        const previousHash = lastScreenHash;
        lastScreenHash = hash;

        if (!previousHash) {
            return { hasChanged: false, changeType: "none", description: "First check" };
        }

        // Size-based heuristic for change magnitude
        const sizeDiff = Math.abs(stat.size - parseInt(previousHash.split("_")[0] || "0"));
        const changeRatio = sizeDiff / Math.max(stat.size, 1);

        if (changeRatio > 0.3) {
            return { hasChanged: true, changeType: "major", description: "Major screen change detected" };
        } else if (changeRatio > 0.05) {
            return { hasChanged: true, changeType: "minor", description: "Minor screen change detected" };
        }

        return { hasChanged: false, changeType: "none", description: "Negligible change" };
    } catch {
        return { hasChanged: false, changeType: "none", description: "Detection failed" };
    } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* */ }
    }
}

// ── Ollama Integration ────────────────────────

async function queryOllamaVision(
    imagePath: string,
    prompt: string,
    model: string,
): Promise<VisionResult | null> {
    const imageData = fs.readFileSync(imagePath).toString("base64");

    try {
        const response = await fetch("http://localhost:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                prompt,
                images: [imageData],
                stream: false,
                options: { num_predict: 200 }, // Keep response short
            }),
            signal: AbortSignal.timeout(15000), // 15s timeout
        });

        if (!response.ok) return null;

        const data = await response.json() as { response: string };
        const description = data.response?.trim() || "";

        if (description.length < 5) return null;

        // Extract scene type from description
        const sceneType = classifyScene(description);

        return {
            description,
            objects: extractObjects(description),
            textContent: "", // Would need OCR for text
            sceneType,
            confidence: 0.7,
            source: "smolvlm",
            processingMs: 0,
        };
    } catch {
        return null;
    }
}

function classifyScene(description: string): VisionResult["sceneType"] {
    const lower = description.toLowerCase();
    if (lower.includes("code") || lower.includes("terminal") || lower.includes("editor")) return "desktop";
    if (lower.includes("website") || lower.includes("browser") || lower.includes("page")) return "webpage";
    if (lower.includes("document") || lower.includes("pdf") || lower.includes("word")) return "document";
    if (lower.includes("photo") || lower.includes("image") || lower.includes("picture")) return "photo";
    return "desktop"; // Default for screen captures
}

function extractObjects(description: string): string[] {
    // Simple extraction: find nouns and app names
    const appNames = ["Safari", "Chrome", "Firefox", "Terminal", "Code", "Slack", "Discord",
        "Finder", "Mail", "Messages", "Calendar", "Notes", "Xcode"];
    const found = appNames.filter(app => description.includes(app));
    return found;
}

function emptyResult(start: number): VisionResult {
    return {
        description: "",
        objects: [],
        textContent: "",
        sceneType: "unknown",
        confidence: 0,
        source: "fallback",
        processingMs: Date.now() - start,
    };
}
