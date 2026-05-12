// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Tiered Perception Cascade (Phase 4) — orchestrates AX / OCR / vision-grounding
 * tiers to find a click target for a natural-language instruction with the lowest
 * possible latency.
 *
 * Cascade order (confidence-gated; first sufficient tier wins):
 *   1. Click memory recall      (~5 ms,   conf ≥ 0.90 — Phase 5; stubbed for now)
 *   2. AX exact-label match     (~50-200ms, conf ≥ 0.95)
 *   3. AX fuzzy-label match     (~50-200ms, conf ≥ 0.80)
 *   4. OmniParser caption match (~200-800ms,conf ≥ 0.80; opt-in, requires deps)
 *   5. UI-TARS grounding        (~400-800ms,conf ≥ 0.70; Full tier only)
 *   6. Cloud VLM (fallback)     (~1500-4000ms — caller's responsibility; we just return null)
 *
 * Each tier respects the capability detector's profile gating: AX always available,
 * OmniParser only on Standard+, UI-TARS only on Full.
 *
 * The router does NOT execute the click — it returns a ClickTarget that the caller
 * passes to os_computer_action with coordSystem='screen'.
 */

import {
    type AxDump,
    type AxFlatElement,
    dumpAccessibilityTree,
    findElementByLabel,
    flattenInteractive,
} from "./ax-dump.js";
import { type CapabilityReport, detectCapabilities } from "./capability-detector.js";
import { detectElements, findElementByCaption } from "./omniparser.js";
import { type ScreenDimensions, scaleImageToScreen } from "./screen-dimensions.js";
import { groundClick, isUITarsAvailable } from "./ui-tars.js";

export type CascadeTier = "memory" | "ax_exact" | "ax_fuzzy" | "omniparser" | "ui_tars" | "cloud_vlm_required";

export interface ClickTarget {
    x: number;
    y: number;
    confidence: number;
    source: CascadeTier;
    reasoning?: string;
    /** Per-tier elapsed time so callers can profile + memorize fast paths. */
    elapsedMsByTier: Partial<Record<CascadeTier, number>>;
    /** Total wall-clock for the cascade call. */
    totalMs: number;
    /** Tiers attempted (in order); helpful for telemetry + click-memory training. */
    triedTiers: CascadeTier[];
    /** ID of the matched element for AX-based hits (null otherwise). */
    matchedElementId?: number;
    /** Label of the matched element (when known). */
    matchedLabel?: string;
}

export interface CascadeOptions {
    /** Optional screenshot path/base64 — required for omniparser + ui_tars tiers. */
    screenshotPath?: string;
    /** Force-skip these tiers (useful for testing). */
    skipTiers?: CascadeTier[];
    /** Confidence threshold overrides per-tier. */
    thresholds?: Partial<Record<CascadeTier, number>>;
    /** Skip the capability detector and force a profile (testing). */
    forceProfile?: CapabilityReport["profile"];
    /** AX dump to reuse (avoids re-probing if caller already has one). */
    axDumpHint?: AxDump;
    /**
     * Screen dimensions for the monitor the screenshot was captured from.
     * REQUIRED for OmniParser and UI-TARS tiers — their output coordinates are
     * in image-pixel space (0..imageWidth) and must be scaled + offset to the
     * monitor's screen-pixel space before they can be clicked. Without this,
     * OmniParser/UI-TARS coords would land at the wrong place on any DPI-scaled
     * display or partial-screen capture.
     */
    screenDims?: ScreenDimensions;
}

const DEFAULT_THRESHOLDS: Record<CascadeTier, number> = {
    memory: 0.9,
    ax_exact: 0.95,
    ax_fuzzy: 0.8,
    omniparser: 0.8,
    ui_tars: 0.7,
    cloud_vlm_required: 0,
};

/**
 * Run the perception cascade. Returns a ClickTarget on success, or null when
 * no tier yields sufficient confidence and the caller must fall back to a cloud VLM.
 */
export async function findClickTarget(instruction: string, opts: CascadeOptions = {}): Promise<ClickTarget | null> {
    const cascadeStart = Date.now();
    const elapsed: Partial<Record<CascadeTier, number>> = {};
    const tried: CascadeTier[] = [];
    const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
    const skip = new Set(opts.skipTiers || []);

    const profile = opts.forceProfile || (await detectCapabilities()).profile;

    // Tier 1: memory recall (placeholder until Phase 5 implements click memory).
    if (!skip.has("memory")) {
        tried.push("memory");
        const memStart = Date.now();
        const memHit = await tryMemoryRecall(instruction);
        elapsed.memory = Date.now() - memStart;
        if (memHit && memHit.confidence >= thresholds.memory) {
            return finalize(memHit, "memory", { tried, elapsed, cascadeStart });
        }
    }

    // Tier 2+3: AX exact then fuzzy. (Dump runs once; each tier's elapsed is recorded
    // AFTER the dump so the times reflect actual match-work, not dump cost.)
    let axDump = opts.axDumpHint;
    let axElements: AxFlatElement[] | null = null;
    if (!skip.has("ax_exact") || !skip.has("ax_fuzzy")) {
        if (!axDump) {
            try {
                axDump = await dumpAccessibilityTree({ depth: 20 });
            } catch {
                /* no AX — skip both tiers */
            }
        }
        if (axDump && !axDump.error) {
            axElements = flattenInteractive(axDump);
            if (!skip.has("ax_exact")) {
                tried.push("ax_exact");
                const exactStart = Date.now();
                const exact = findElementByLabel(axElements, instruction, 0.95);
                elapsed.ax_exact = Date.now() - exactStart; // record even on miss
                if (exact) {
                    return finalize(
                        {
                            x: exact.center.x,
                            y: exact.center.y,
                            confidence: 0.95,
                            source: "ax_exact",
                            matchedElementId: exact.id,
                            matchedLabel: exact.label,
                        },
                        "ax_exact",
                        { tried, elapsed, cascadeStart },
                    );
                }
            }
            if (!skip.has("ax_fuzzy")) {
                tried.push("ax_fuzzy");
                const fuzzyStart = Date.now();
                const fuzzy = findElementByLabel(axElements, instruction, thresholds.ax_fuzzy);
                elapsed.ax_fuzzy = Date.now() - fuzzyStart;
                if (fuzzy) {
                    return finalize(
                        {
                            x: fuzzy.center.x,
                            y: fuzzy.center.y,
                            confidence: 0.85,
                            source: "ax_fuzzy",
                            matchedElementId: fuzzy.id,
                            matchedLabel: fuzzy.label,
                        },
                        "ax_fuzzy",
                        { tried, elapsed, cascadeStart },
                    );
                }
            }
        }
    }

    // Tiers 4 + 5 require a screenshot path AND ML deps.
    if (!opts.screenshotPath) {
        return null;
    }

    // Tier 4: OmniParser (Standard tier and up).
    if (!skip.has("omniparser") && (profile === "standard" || profile === "full")) {
        tried.push("omniparser");
        const omStart = Date.now();
        try {
            const result = await detectElements(opts.screenshotPath, { captions: true, maxElements: 100 });
            elapsed.omniparser = Date.now() - omStart;
            if (!result.error && result.elements.length > 0) {
                const match = findElementByCaption(result.elements, instruction);
                if (match) {
                    const screen = toScreenCoords(match.center.x, match.center.y, result.imageWidth, opts.screenDims);
                    return finalize(
                        {
                            x: screen.x,
                            y: screen.y,
                            confidence: 0.82,
                            source: "omniparser",
                            matchedElementId: match.id,
                            matchedLabel: match.caption,
                        },
                        "omniparser",
                        { tried, elapsed, cascadeStart },
                    );
                }
            }
        } catch {
            elapsed.omniparser = Date.now() - omStart;
        }
    }

    // Tier 5: UI-TARS local grounding (Full tier only, requires Ollama).
    // Short-circuit via capability-detector's deps.ollama check before paying the 3s
    // TCP-timeout cost on a box where Ollama is never installed.
    if (!skip.has("ui_tars") && profile === "full") {
        const caps = await detectCapabilities();
        if (caps.deps.ollama) {
            tried.push("ui_tars");
            const utStart = Date.now();
            try {
                const avail = await isUITarsAvailable();
                if (avail.available) {
                    const grounded = await groundClick(opts.screenshotPath, instruction);
                    elapsed.ui_tars = Date.now() - utStart;
                    if (!grounded.error && grounded.confidence >= thresholds.ui_tars) {
                        const screen = toScreenCoords(grounded.x, grounded.y, grounded.imageWidth, opts.screenDims);
                        return finalize(
                            {
                                x: screen.x,
                                y: screen.y,
                                confidence: grounded.confidence,
                                source: "ui_tars",
                                reasoning: grounded.reasoning,
                            },
                            "ui_tars",
                            { tried, elapsed, cascadeStart },
                        );
                    }
                } else {
                    elapsed.ui_tars = Date.now() - utStart;
                }
            } catch {
                elapsed.ui_tars = Date.now() - utStart;
            }
        }
    }

    // No tier yielded sufficient confidence — caller falls through to cloud VLM.
    // Do NOT add cloud_vlm_required to triedTiers (router never actually ran it).
    return null;
}

/**
 * Permanent stub. Click-memory recall *intentionally* lives in `os_smart_click`
 * (src/tools/os-smart-click.ts Step 0) and NOT here, because the cascade has no
 * access to (app, windowTitle, monitor dims) required to key + denormalize a
 * stored site. Keeping this tier as a tried-but-skipped slot preserves telemetry
 * shape while avoiding a double-recall path with mismatched confidence thresholds.
 */
async function tryMemoryRecall(
    _instruction: string,
): Promise<Omit<ClickTarget, "elapsedMsByTier" | "totalMs" | "triedTiers"> | null> {
    return null;
}

function finalize(
    candidate: Omit<ClickTarget, "elapsedMsByTier" | "totalMs" | "triedTiers">,
    _source: CascadeTier,
    ctx: { tried: CascadeTier[]; elapsed: Partial<Record<CascadeTier, number>>; cascadeStart: number },
): ClickTarget {
    return {
        ...candidate,
        elapsedMsByTier: { ...ctx.elapsed },
        totalMs: Date.now() - ctx.cascadeStart,
        triedTiers: [...ctx.tried],
    };
}

/**
 * Convert OmniParser/UI-TARS image-pixel coords to screen-absolute coords.
 * Falls back to image-pixel coords when screenDims or imageWidth is missing —
 * the caller will get the wrong click in that case, but this preserves
 * the existing (broken) behavior so tests + integrators that haven't yet
 * passed screenDims aren't surprised by a NaN.
 */
function toScreenCoords(
    rawX: number,
    rawY: number,
    imageWidth: number | undefined,
    dims: ScreenDimensions | undefined,
): { x: number; y: number } {
    if (!dims || !imageWidth || imageWidth <= 0) {
        return { x: Math.round(rawX), y: Math.round(rawY) };
    }
    const r = scaleImageToScreen({ rawX, rawY, imageWidth, dims });
    return { x: r.x, y: r.y };
}

/**
 * Helper for callers to format a router result for inclusion in tool output.
 */
export function formatCascadeResult(result: ClickTarget | null): string {
    if (!result) return "cascade: no tier reached threshold → fall through to cloud VLM";
    const parts = [
        `source=${result.source}`,
        `confidence=${result.confidence.toFixed(2)}`,
        `(${result.x},${result.y})`,
        `total=${result.totalMs}ms`,
        `tried=[${result.triedTiers.join(",")}]`,
    ];
    if (result.matchedLabel) parts.push(`label="${result.matchedLabel.slice(0, 40)}"`);
    return parts.join(" ");
}
