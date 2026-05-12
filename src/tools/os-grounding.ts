// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Vision-grounding tools (Phase 3):
 *   - os_visualize: OmniParser-v2 element detector — returns numbered list of bounding boxes
 *     for any UI element in a screenshot. Works on Canvas-based apps (Figma, Photoshop)
 *     where the AX tree is empty.
 *   - os_ground: UI-TARS-1.5-7B grounding model — takes (screenshot, instruction) and
 *     returns predicted click coords. ~400ms on M-series.
 *
 * Both tools gracefully fail-open when the underlying Python/Ollama deps aren't installed
 * — the cascade router (Phase 4) handles falling through to cloud VLM.
 */

import { detectElements } from "../screen/omniparser.js";
import { groundClick, isUITarsAvailable } from "../screen/ui-tars.js";
import type { ToolDefinition } from "./get-current-time.js";

export const osVisualize: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_visualize",
            description:
                "Detect interactive UI elements in a screenshot using OmniParser-v2 (YOLOv8). Returns a numbered list of bounding boxes — useful for Canvas-based apps (Figma, Photoshop) and pages where the accessibility tree is empty. Requires `pip install ultralytics` + OmniParser weights cached. Falls open if not installed.",
            parameters: {
                type: "object",
                properties: {
                    screenshot_path: {
                        type: "string",
                        description: "Absolute path to a screenshot PNG/JPEG. Use os_screenshot first if you don't have one.",
                    },
                    captions: {
                        type: "boolean",
                        description: "Generate semantic captions for each element via Florence-2 (requires extra 770MB model cache). Default: false.",
                    },
                    max_elements: {
                        type: "number",
                        description: "Cap at this many elements (default 50).",
                    },
                },
                required: ["screenshot_path"],
            },
        },
    },

    async handler(input) {
        const screenshotPath = input.screenshot_path as string;
        if (!screenshotPath) return JSON.stringify({ success: false, error: "screenshot_path required" });
        const captions = (input.captions as boolean) || false;
        const maxElements = typeof input.max_elements === "number" ? Math.max(1, Math.min(200, input.max_elements)) : 50;

        const result = await detectElements(screenshotPath, { captions, maxElements });
        if (result.error) {
            return JSON.stringify({
                success: false,
                error: result.error,
                hint: result.error.includes("yolo_not_installed")
                    ? "Install Ultralytics: `pip install ultralytics pillow`"
                    : result.error.includes("model_not_cached")
                        ? "Download OmniParser weights: `huggingface-cli download microsoft/OmniParser-v2.0 --local-dir ~/.cache/omniparser`"
                        : result.error.includes("pillow_not_installed")
                            ? "Install Pillow: `pip install pillow`"
                            : "OmniParser detection failed — see error field.",
            });
        }

        const summary = result.elements
            .map((e) => `[${e.id}] bbox=(${e.bbox[0]},${e.bbox[1]})-(${e.bbox[2]},${e.bbox[3]}) center=(${e.center.x},${e.center.y}) score=${e.score}${e.caption ? ` "${e.caption.slice(0, 40)}"` : ""}`)
            .join("\n");

        return JSON.stringify({
            success: true,
            element_count: result.elements.length,
            image_size: { width: result.imageWidth, height: result.imageHeight },
            model: result.model,
            elapsed_ms: result.elapsedMs,
            elements: summary,
            tip: "Use os_click with x,y from the center field, or pair with os_ground for a smarter pick.",
        });
    },
};

export const osGround: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_ground",
            description:
                "Predict click coordinates from a screenshot + natural-language instruction using UI-TARS-1.5-7B. Returns (x, y, confidence). Requires Ollama + `ui-tars:7b` model pulled (~4.5GB). Falls open if unavailable.",
            parameters: {
                type: "object",
                properties: {
                    screenshot_path: {
                        type: "string",
                        description: "Absolute path to a screenshot PNG/JPEG.",
                    },
                    instruction: {
                        type: "string",
                        description: 'Natural-language description of what to click (e.g. "the Save button", "the close X in the top-right of the dialog").',
                    },
                    model: {
                        type: "string",
                        description: 'Ollama model tag (default: "ui-tars:7b").',
                    },
                },
                required: ["screenshot_path", "instruction"],
            },
        },
    },

    async handler(input) {
        const screenshotPath = input.screenshot_path as string;
        const instruction = input.instruction as string;
        const model = (input.model as string) || "ui-tars:7b";
        if (!screenshotPath || !instruction) {
            return JSON.stringify({ success: false, error: "screenshot_path AND instruction required" });
        }

        // Fast availability check before paying for the image read + Ollama round-trip.
        const avail = await isUITarsAvailable({ model });
        if (!avail.available) {
            return JSON.stringify({
                success: false,
                error: avail.reason,
                hint: avail.reason === "ollama_not_running"
                    ? "Start Ollama: `ollama serve` (or install: https://ollama.com)"
                    : avail.reason === "model_not_pulled"
                        ? `Pull the model: \`ollama pull ${model}\` (~4.5GB)`
                        : "UI-TARS unavailable — fall back to cloud VLM via os_screenshot + visual prompt.",
            });
        }

        const result = await groundClick(screenshotPath, instruction, { model });
        if (result.error) {
            return JSON.stringify({ success: false, error: result.error });
        }

        return JSON.stringify({
            success: true,
            x: result.x,
            y: result.y,
            confidence: result.confidence,
            reasoning: result.reasoning,
            model: result.model,
            elapsed_ms: result.elapsedMs,
            tip: result.confidence >= 0.7
                ? "High confidence — safe to os_click with these coords."
                : "Low confidence — consider os_inspect for native apps OR verify with os_screenshot after click.",
        });
    },
};
