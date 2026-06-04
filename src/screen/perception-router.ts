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
    clearAxFailureCache,
    dumpAccessibilityTree,
    findElementByLabel,
    flattenInteractive,
} from "./ax-dump.js";
import { type CapabilityReport, detectCapabilities } from "./capability-detector.js";
import { detectElements, findElementByCaption, omniParserWeightsPresent } from "./omniparser.js";
import { type ScreenDimensions, scaleImageToScreen } from "./screen-dimensions.js";
import { groundClick, isUITarsAvailable, isUITarsHealthy } from "./ui-tars.js";
import { cloudGroundClick } from "./cloud-grounding.js";
import type { LLMClient } from "../llm.js";

export type CascadeTier =
    | "memory" | "ax_exact" | "ax_fuzzy" | "omniparser" | "ui_tars" | "cloud_grounding" | "cloud_vlm_required";

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
    /**
     * LLM client for the cloud_grounding tier. Required for cloud grounding to
     * fire (Lite/Standard, or degraded-Full). Without it, the cascade returns
     * null at the cloud tier and the caller falls back to the agentic VLM.
     */
    llm?: LLMClient;
}

const DEFAULT_THRESHOLDS: Record<CascadeTier, number> = {
    memory: 0.9,
    ax_exact: 0.95,
    ax_fuzzy: 0.8,
    omniparser: 0.8,
    ui_tars: 0.7,
    cloud_grounding: 0.6,
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

    // Tier 2+3: AX exact then fuzzy. Runs the match against a flattened AX dump.
    // Returns a finalized ClickTarget on hit, else null. Pushes tier-tried +
    // elapsed as a side effect so telemetry reflects every attempt.
    const matchAx = (els: AxFlatElement[]): ClickTarget | null => {
        if (!skip.has("ax_exact")) {
            tried.push("ax_exact");
            const t = Date.now();
            const exact = findElementByLabel(els, instruction, thresholds.ax_exact);
            elapsed.ax_exact = Date.now() - t;
            if (exact) {
                return finalize(
                    { x: exact.center.x, y: exact.center.y, confidence: thresholds.ax_exact, source: "ax_exact", matchedElementId: exact.id, matchedLabel: exact.label },
                    "ax_exact", { tried, elapsed, cascadeStart },
                );
            }
        }
        if (!skip.has("ax_fuzzy")) {
            tried.push("ax_fuzzy");
            const t = Date.now();
            const fuzzy = findElementByLabel(els, instruction, thresholds.ax_fuzzy);
            elapsed.ax_fuzzy = Date.now() - t;
            if (fuzzy) {
                return finalize(
                    { x: fuzzy.center.x, y: fuzzy.center.y, confidence: 0.85, source: "ax_fuzzy", matchedElementId: fuzzy.id, matchedLabel: fuzzy.label },
                    "ax_fuzzy", { tried, elapsed, cascadeStart },
                );
            }
        }
        return null;
    };

    let axDump = opts.axDumpHint;
    if (!skip.has("ax_exact") || !skip.has("ax_fuzzy")) {
        if (!axDump) {
            try {
                axDump = await dumpAccessibilityTree({ depth: 20 });
            } catch {
                /* no AX — skip both tiers */
            }
        }
        if (axDump && !axDump.error) {
            const hit = matchAx(flattenInteractive(axDump));
            if (hit) return hit;

            // Cold-window retry: a freshly-activated window's AX tree is often
            // incomplete on first dump (still settling), so a real element
            // misses, then hits moments later. Re-dump ONCE before paying the
            // slow/possibly-billed vision tiers. Skip when the caller supplied
            // a full-depth hint (it already settled the window). Gated.
            const axDumpHintShallow = !!opts.axDumpHint && (opts.axDumpHint.depth ?? 0) < 20;
            const retryEligible = (!opts.axDumpHint || axDumpHintShallow) && process.env.ATLAS_NO_AX_RETRY !== "true";
            if (retryEligible) {
                const delayMs = Number(process.env.ATLAS_AX_RETRY_DELAY_MS) || 250;
                await new Promise((r) => setTimeout(r, delayMs));
                clearAxFailureCache();
                try {
                    const redump = await dumpAccessibilityTree({ depth: 20 });
                    if (redump && !redump.error) {
                        const retryHit = matchAx(flattenInteractive(redump));
                        if (retryHit) return retryHit;
                    }
                } catch {
                    /* re-dump failed — fall through to vision tiers */
                }
            }
        }
    }

    // Tiers 4 + 5 require a screenshot path AND ML deps.
    if (!opts.screenshotPath) {
        return null;
    }

    // Tier 4: OmniParser (Standard tier and up). Short-circuit when the
    // icon_detect weights aren't present — otherwise we spawn python on every
    // call just to get `omniparser_weights_missing` back (wasteful). Kill-switch
    // ATLAS_NO_OMNIPARSER force-skips regardless.
    if (
        !skip.has("omniparser") &&
        (profile === "standard" || profile === "full") &&
        process.env.ATLAS_NO_OMNIPARSER !== "true" &&
        omniParserWeightsPresent()
    ) {
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
    // `uiTarsUsable` tracks whether local grounding was actually available this
    // run — drives the degraded-Full self-heal gate on the cloud tier below.
    let uiTarsUsable = false;
    if (!skip.has("ui_tars") && profile === "full") {
        const caps = await detectCapabilities();
        if (caps.deps.ollama) {
            tried.push("ui_tars");
            const utStart = Date.now();
            try {
                const avail = await isUITarsAvailable();
                // Pulled AND vision-inference actually works. A pulled-but-broken
                // quant (crashing mmproj) is treated as NOT usable so we skip it
                // and fall to cloud grounding instead of eating a 30s crash/timeout
                // per click. The health probe is one-time cached. Bypass with
                // ATLAS_NO_UITARS_HEALTHCHECK=true.
                const healthy = avail.available && (
                    process.env.ATLAS_NO_UITARS_HEALTHCHECK === "true" ||
                    (await isUITarsHealthy()).healthy
                );
                if (healthy) {
                    uiTarsUsable = true;
                    const grounded = await groundClick(opts.screenshotPath, instruction, { keepAlive: "30m" });
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

    // Tier 6: Cloud grounding (cheap VLM). Fires on Lite/Standard (no local
    // grounding) and on degraded Full (Full hardware but UI-TARS not pulled).
    // Skipped on healthy Full (local UI-TARS handled it → zero cloud cost) and
    // when no LLM client was provided. This replaces the old behavior where a
    // missed click bounced to the expensive agentic model to re-ground.
    const cloudEligible = profile !== "full" || !uiTarsUsable;
    if (!skip.has("cloud_grounding") && cloudEligible && opts.llm && process.env.ATLAS_NO_CLOUD_GROUNDING !== "true") {
        tried.push("cloud_grounding");
        const cgStart = Date.now();
        try {
            const grounded = await cloudGroundClick(opts.screenshotPath, instruction, { llm: opts.llm });
            elapsed.cloud_grounding = Date.now() - cgStart;
            if (!grounded.error && grounded.confidence >= thresholds.cloud_grounding) {
                const screen = toScreenCoords(grounded.x, grounded.y, grounded.imageWidth, opts.screenDims);
                return finalize(
                    {
                        x: screen.x,
                        y: screen.y,
                        confidence: grounded.confidence,
                        source: "cloud_grounding",
                        reasoning: grounded.reasoning,
                    },
                    "cloud_grounding",
                    { tried, elapsed, cascadeStart },
                );
            }
        } catch {
            elapsed.cloud_grounding = Date.now() - cgStart;
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
