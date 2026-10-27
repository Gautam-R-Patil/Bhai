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
 * Both tools accept EITHER a screenshot_path (file on disk under tmpdir/ATLAS Files) OR
 * a screenshot_base64 (encoded image data — written to a temp file internally then cleaned up).
 * This makes them reachable from the agent loop where os_screenshot returns base64 only.
 *
 * Both tools gracefully fail-open when the underlying Python/Ollama deps aren't installed
 * — the cascade router (Phase 4) handles falling through to cloud VLM.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectElements } from "../screen/omniparser.js";
import { DEFAULT_UI_TARS_TAG, groundClick, isUITarsAvailable } from "../screen/ui-tars.js";
import type { ToolDefinition } from "./get-current-time.js";

/** Write a base64-encoded image to a temp file. Returns the absolute path. Caller must unlink. */
async function base64ToTempFile(base64: string, ext = "png"): Promise<string> {
    const tmp = join(tmpdir(), `atlas_ground_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`);
    const buf = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
    await fs.writeFile(tmp, buf, { mode: 0o600 });
    return tmp;
}

/** Resolve either a path or a base64 blob into a safe, temp-file-backed path. */
async function resolveScreenshotInput(
    input: Record<string, unknown>,
): Promise<{ path: string; cleanup: () => Promise<void> } | { error: string }> {
    const path = input.screenshot_path as string | undefined;
    const b64 = input.screenshot_base64 as string | undefined;
    if (path) {
        return {
            path,
            cleanup: async () => {
                /* user-owned, don't delete */
            },
        };
    }
    if (b64) {
        const tmp = await base64ToTempFile(b64);
        return {
            path: tmp,
            cleanup: async () => {
                try {
                    await fs.unlink(tmp);
                } catch {
                    /* best effort */
                }
            },
        };
    }
    return { error: "Provide either screenshot_path (file on disk) OR screenshot_base64 (from os_screenshot)" };
}

export const osVisualize: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_visualize",
            description:
                "Detect interactive UI elements in a screenshot using OmniParser-v2 (YOLOv8). Returns numbered bounding boxes — useful for Canvas apps (Figma, Photoshop) where AX is empty. Requires `pip install ultralytics` + OmniParser weights. Pass screenshot_base64 from os_screenshot, OR screenshot_path under tmpdir/ATLAS Files.",
            parameters: {
                type: "object",
                properties: {
                    screenshot_path: {
                        type: "string",
                        description:
                            "Absolute path to PNG/JPEG under tmpdir or Bhai Files (rejected otherwise — security).",
                    },
                    screenshot_base64: {
                        type: "string",
                        description:
                            "Base64-encoded image (e.g. from os_screenshot's screenshot_base64 field). Preferred — no path-restriction risk.",
                    },
                    captions: {
                        type: "boolean",
                        description: "Generate semantic captions via Florence-2 (extra 770MB model). Default: false.",
                    },
                    max_elements: { type: "number", description: "Cap at this many elements (default 50)." },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        const resolved = await resolveScreenshotInput(input);
        if ("error" in resolved) return JSON.stringify({ success: false, error: resolved.error });

        const captions = (input.captions as boolean) || false;
        const maxElements =
            typeof input.max_elements === "number" ? Math.max(1, Math.min(200, input.max_elements)) : 50;

        try {
            const result = await detectElements(resolved.path, { captions, maxElements });
            if (result.error) {
                return JSON.stringify({
                    success: false,
                    error: result.error,
                    hint: result.error.includes("yolo_not_installed")
                        ? "Install Ultralytics: `pip install ultralytics pillow`"
                        : result.error.includes("omniparser_weights_missing")
                          ? "Download OmniParser weights: `huggingface-cli download microsoft/OmniParser-v2.0 --local-dir ~/.cache/omniparser`"
                          : result.error.includes("pillow_not_installed")
                            ? "Install Pillow: `pip install pillow`"
                            : result.error.includes("image_too_large")
                              ? "Screenshot exceeds 8K — capture a smaller region."
                              : "OmniParser detection failed — see error field.",
                });
            }

            const summary = result.elements
                .map(
                    (e) =>
                        `[${e.id}] bbox=(${e.bbox[0]},${e.bbox[1]})-(${e.bbox[2]},${e.bbox[3]}) center=(${e.center.x},${e.center.y}) score=${e.score}${e.caption ? ` "${e.caption.slice(0, 40)}"` : ""}`,
                )
                .join("\n");

            return JSON.stringify({
                success: true,
                element_count: result.elements.length,
                image_size: { width: result.imageWidth, height: result.imageHeight },
                image_width: result.imageWidth,
                model: result.model,
                elapsed_ms: result.elapsedMs,
                elements: summary,
                tip: `Click via os_computer_action with action='click', coordSystem='image', imageWidth=${result.imageWidth}, coord=[center.x, center.y]. The 'image' coordSystem auto-scales to current screen — avoids Retina/multi-monitor coord bugs.`,
            });
        } finally {
            await resolved.cleanup();
        }
    },
};

export const osGround: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_ground",
            description:
                "Predict click coordinates from a screenshot + natural-language instruction using UI-TARS-1.5-7B (local). Returns (x, y, confidence). Requires Ollama + `ui-tars:7b` (~4.5GB). Pass screenshot_base64 from os_screenshot, OR screenshot_path under tmpdir/ATLAS Files.",
            parameters: {
                type: "object",
                properties: {
                    screenshot_path: {
                        type: "string",
                        description: "Absolute path to PNG/JPEG under tmpdir or Bhai Files (rejected otherwise).",
                    },
                    screenshot_base64: {
                        type: "string",
                        description: "Base64-encoded image (preferred — from os_screenshot's screenshot_base64 field).",
                    },
                    instruction: {
                        type: "string",
                        description:
                            'Natural-language target description (e.g. "the Save button", "the X to close the dialog").',
                    },
                    model: { type: "string", description: "Ollama model tag (defaults to the configured UI-TARS tag, ATLAS_UI_TARS_TAG)." },
                },
                required: ["instruction"],
            },
        },
    },

    async handler(input) {
        const instruction = input.instruction as string;
        // Use the SAME tag the cascade + groundClick use (ATLAS_UI_TARS_TAG, else
        // the verified-working DEFAULT_UI_TARS_TAG). The old hardcoded "ui-tars:7b"
        // never matched the pulled GGUF, so os_ground always reported
        // model_not_pulled and told the user to pull a tag the system never uses.
        const model = (input.model as string) || process.env.ATLAS_UI_TARS_TAG || DEFAULT_UI_TARS_TAG;
        if (!instruction) return JSON.stringify({ success: false, error: "instruction required" });

        // Fast availability check (60s cached) BEFORE the image read + Ollama round-trip.
        const avail = await isUITarsAvailable({ model });
        if (!avail.available) {
            return JSON.stringify({
                success: false,
                error: avail.reason,
                hint: avail.reason?.startsWith("ollama_not_running")
                    ? "Start Ollama: `ollama serve` (or install: https://ollama.com)"
                    : avail.reason === "model_not_pulled"
                      ? `Pull the model: \`ollama pull ${model}\` (~4.5GB)`
                      : avail.reason?.startsWith("non_loopback_host")
                        ? "OLLAMA_HOST must be loopback (127.0.0.1, ::1, localhost)."
                        : "UI-TARS unavailable — fall back to cloud VLM via os_screenshot + visual prompt.",
            });
        }

        const resolved = await resolveScreenshotInput(input);
        if ("error" in resolved) return JSON.stringify({ success: false, error: resolved.error });

        try {
            const result = await groundClick(resolved.path, instruction, { model });
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
                // CRITICAL: x/y are in image-pixel space. The legacy os_click assumes the LLM is
                // looking at a 1280px-wide image, so passing UI-TARS coords (from the un-resized
                // screenshot) directly to os_click misses by 50%+ on Retina. Tell the agent to
                // use the structured action with coordSystem='image' instead.
                tip:
                    result.confidence >= 0.7
                        ? "High confidence. Click via os_computer_action with action='click', coordSystem='image', imageWidth=<width of the screenshot you passed>, coord=[x, y]. Use the screenshot's actual width — auto-scales to screen."
                        : "Low confidence — consider os_inspect for native apps (cross-OS AX path is more accurate when available) OR re-screenshot and try again.",
            });
        } finally {
            await resolved.cleanup();
        }
    },
};
