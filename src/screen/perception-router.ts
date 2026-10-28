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

import type { LLMClient } from "../llm.js";
import {
    type AxDump,
    type AxFlatElement,
    clearAxFailureCache,
    dumpAccessibilityTree,
    dumpDock,
    flattenInteractive,
    isAxPermissionError,
    type LabelMatch,
    matchElementByLabel,
} from "./ax-dump.js";
import { type CapabilityReport, detectCapabilities } from "./capability-detector.js";
import { cloudGroundClick } from "./cloud-grounding.js";
import {
    detectElements,
    findElementByCaption,
    omniParserCaptionsPresent,
    omniParserWeightsPresent,
} from "./omniparser.js";
import { type ScreenDimensions, scaleImageToScreen } from "./screen-dimensions.js";

export type CascadeTier =
    | "memory"
    | "ax_exact"
    | "ax_fuzzy"
    | "omniparser"
    | "ui_tars"
    | "cloud_grounding"
    | "cloud_vlm_required";

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
    /**
     * AX-tier hits: enough to AXPress / scroll-to-visible the element instead of
     * clicking pixels. `offscreen` = its center is outside its window, so the
     * coordinates alone can't be clicked.
     */
    ax?: { pid: number; path: number[]; role: string; bbox: AxFlatElement["bbox"]; offscreen?: boolean };
}

/** Why the cascade found nothing — so a permission problem doesn't look like a bad label. */
export interface CascadeMiss {
    reason: "ambiguous" | "disabled" | "ax_permission_missing" | "ax_unavailable" | "not_found";
    app?: string;
    axElementCount?: number;
    axError?: string;
    /** Best-scoring AX labels that still fell short. */
    nearest?: Array<{ label: string; role: string; score: number; at: { x: number; y: number } }>;
    /** Equally good matches the instruction can't tell apart. */
    ambiguous?: Array<{ label: string; role: string; at: { x: number; y: number } }>;
    /** Per-tier failure ("timeout_30000ms", "cloud_grounding_disabled", "unparseable", "no_screenshot", ...). */
    tierErrors: Partial<Record<CascadeTier, string>>;
    triedTiers: CascadeTier[];
    totalMs: number;
}

export interface CascadeOptions {
    /** Optional screenshot path/base64 — required for omniparser + ui_tars tiers. */
    screenshotPath?: string;
    /**
     * Lazy alternative to screenshotPath/screenDims: called once, only when the
     * cascade reaches a vision tier (AX hits never pay for a capture).
     */
    screenshot?: () => Promise<{ path: string; dims?: ScreenDimensions } | null>;
    /** Called with the reasons when the cascade returns null. */
    onMiss?: (miss: CascadeMiss) => void;
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
    /** cloud_grounding model (default Haiku) and how long it may take. */
    groundingModel?: string;
    groundingTimeoutMs?: number;
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

    const miss: CascadeMiss = { reason: "not_found", tierErrors: {}, triedTiers: tried, totalMs: 0 };
    const missed = (): null => {
        miss.totalMs = Date.now() - cascadeStart;
        opts.onMiss?.(miss);
        return null;
    };

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
    // elapsed as a side effect so telemetry reflects every attempt; a tie or a
    // disabled-only match is noted on `miss` (and ends the cascade: vision would
    // just pick one of the tied elements blindly).
    const matchAx = (dump: AxDump): ClickTarget | null => {
        const els = flattenInteractive(dump);
        miss.app = dump.app;
        miss.axElementCount = els.length;
        const toTarget = (m: LabelMatch, tier: "ax_exact" | "ax_fuzzy", confidence: number): ClickTarget | null => {
            if (m.ambiguous) miss.reason = "ambiguous";
            else if (m.disabled && miss.reason === "not_found") miss.reason = "disabled";
            miss.nearest = m.nearest.map((c) => ({
                label: c.el.label || c.el.value,
                role: c.el.role,
                score: Math.round(c.score * 100) / 100,
                at: c.el.center,
            }));
            miss.ambiguous = m.ambiguous?.map((el) => ({ label: el.label || el.value, role: el.role, at: el.center }));
            const el = m.el;
            if (!el) return null;
            return finalize(
                {
                    x: el.center.x,
                    y: el.center.y,
                    confidence,
                    source: tier,
                    matchedElementId: el.id,
                    matchedLabel: el.label,
                    ax: { pid: dump.pid, path: el.path, role: el.role, bbox: el.bbox, offscreen: el.offscreen },
                },
                tier,
                { tried, elapsed, cascadeStart },
            );
        };
        if (!skip.has("ax_exact")) {
            tried.push("ax_exact");
            const t = Date.now();
            const hit = toTarget(
                matchElementByLabel(els, instruction, thresholds.ax_exact, dump.app),
                "ax_exact",
                thresholds.ax_exact,
            );
            elapsed.ax_exact = Date.now() - t;
            if (hit || miss.reason === "ambiguous") return hit;
        }
        if (!skip.has("ax_fuzzy")) {
            tried.push("ax_fuzzy");
            const t = Date.now();
            const hit = toTarget(
                matchElementByLabel(els, instruction, thresholds.ax_fuzzy, dump.app),
                "ax_fuzzy",
                0.85,
            );
            elapsed.ax_fuzzy = Date.now() - t;
            if (hit) return hit;
        }
        return null;
    };

    // The Dock (and its app icons) isn't the frontmost app, so the normal dump
    // never sees it: search it when the front app has no match, or first when
    // the instruction names the Dock.
    const tryDock = async (): Promise<ClickTarget | null> => {
        const dock = await dumpDock();
        if (!dock) return null;
        const keep = { ...miss };
        const hit = matchAx(dock);
        if (!hit) Object.assign(miss, keep); // report the front app's near-misses, not the Dock's
        return hit;
    };

    let axDump = opts.axDumpHint;
    if (!skip.has("ax_exact") || !skip.has("ax_fuzzy")) {
        if (/\bdock\b/i.test(instruction)) {
            const hit = await tryDock();
            if (hit) return hit;
        }
        if (!axDump) {
            try {
                axDump = await dumpAccessibilityTree({ depth: 20 });
            } catch {
                /* no AX — skip both tiers */
            }
        }
        if (axDump?.error) {
            miss.axError = axDump.error;
            miss.reason = isAxPermissionError(axDump.error) ? "ax_permission_missing" : "ax_unavailable";
        } else if (axDump && !axDump.partial) {
            // A partial dump (a read timed out) is missing elements: matching it could pick a
            // look-alike label read before the cut, so it counts as an AX miss.
            const hit = matchAx(axDump);
            if (hit) return hit;
            if (miss.reason === "ambiguous") return missed();

            // Cold-window retry: a freshly-activated window's AX tree is often
            // incomplete on first dump (still settling), so a real element
            // misses, then hits moments later. Re-dump ONCE before paying the
            // slow/possibly-billed vision tiers (also when the hint came from the
            // caller — os_smart_click's hint is a pre-click dump, not "settled"). Gated.
            if (process.env.ATLAS_NO_AX_RETRY !== "true") {
                const delayMs = Number(process.env.ATLAS_AX_RETRY_DELAY_MS) || 250;
                await new Promise((r) => setTimeout(r, delayMs));
                clearAxFailureCache();
                try {
                    const redump = await dumpAccessibilityTree({ depth: 20 });
                    if (redump && !redump.error && !redump.partial) {
                        const retryHit = matchAx(redump);
                        if (retryHit) return retryHit;
                        if ((miss.reason as CascadeMiss["reason"]) === "ambiguous") return missed();
                    }
                } catch {
                    /* re-dump failed — fall through to vision tiers */
                }
            }
            if (!/\bdock\b/i.test(instruction)) {
                const hit = await tryDock();
                if (hit) return hit;
            }
        }
    }

    // Tiers 4 + 5 require a screenshot (captured lazily, only now).
    let screenshotPath = opts.screenshotPath;
    let screenDims = opts.screenDims;
    if (!screenshotPath && opts.screenshot) {
        try {
            const shot = await opts.screenshot();
            if (shot) {
                screenshotPath = shot.path;
                screenDims = shot.dims ?? screenDims;
            }
        } catch {
            /* no screenshot — vision tiers can't run */
        }
    }
    if (!screenshotPath) {
        miss.tierErrors.cloud_grounding = "no_screenshot";
        return missed();
    }

    // Tier 4: OmniParser (Standard tier and up). Short-circuit when the
    // icon_detect weights aren't present — otherwise we spawn python on every
    // call just to get `omniparser_weights_missing` back (wasteful). Also skip
    // when Florence-2 captions aren't cached: matching is caption-only, so a
    // caption-less run can never hit. Kill-switch ATLAS_NO_OMNIPARSER force-skips.
    if (
        !skip.has("omniparser") &&
        profile === "standard" &&
        process.env.ATLAS_NO_OMNIPARSER !== "true" &&
        omniParserWeightsPresent() &&
        omniParserCaptionsPresent()
    ) {
        tried.push("omniparser");
        const omStart = Date.now();
        try {
            const result = await detectElements(screenshotPath, { captions: true, maxElements: 100 });
            elapsed.omniparser = Date.now() - omStart;
            if (result.error) miss.tierErrors.omniparser = String(result.error);
            if (!result.error && result.elements.length > 0) {
                const match = findElementByCaption(result.elements, instruction);
                if (match) {
                    const screen = toScreenCoords(match.center.x, match.center.y, result.imageWidth, screenDims);
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
        } catch (err) {
            elapsed.omniparser = Date.now() - omStart;
            miss.tierErrors.omniparser = (err as Error).message.slice(0, 120);
        }
    }

    // Tier 6: Cloud grounding (VLM). Fires once the local tiers missed. (Tier 5,
    // local UI-TARS, went with the old "full" profile: ~4.5 GB and ~5 GB of RAM
    // for a lower hit rate than this one cloud call.) Skipped
    // when no LLM client was provided. This replaces the old behavior where a
    // missed click bounced to the expensive agentic model to re-ground.
    if (skip.has("cloud_grounding")) {
        miss.tierErrors.cloud_grounding = "skipped";
    } else if (process.env.ATLAS_NO_CLOUD_GROUNDING === "true") {
        miss.tierErrors.cloud_grounding = "cloud_grounding_disabled";
    } else if (!opts.llm) {
        miss.tierErrors.cloud_grounding = "no_llm_client";
    } else {
        tried.push("cloud_grounding");
        const cgStart = Date.now();
        try {
            const grounded = await cloudGroundClick(screenshotPath, instruction, {
                llm: opts.llm,
                model: opts.groundingModel,
                timeoutMs: opts.groundingTimeoutMs,
            });
            elapsed.cloud_grounding = Date.now() - cgStart;
            if (grounded.error) miss.tierErrors.cloud_grounding = grounded.error;
            else if (grounded.confidence < thresholds.cloud_grounding) {
                miss.tierErrors.cloud_grounding = `low_confidence:${grounded.confidence}`;
            }
            if (!grounded.error && grounded.confidence >= thresholds.cloud_grounding) {
                const screen = toScreenCoords(grounded.x, grounded.y, grounded.imageWidth, screenDims);
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
        } catch (err) {
            elapsed.cloud_grounding = Date.now() - cgStart;
            miss.tierErrors.cloud_grounding = (err as Error).message.slice(0, 120);
        }
    }

    // No tier yielded sufficient confidence — caller falls through to cloud VLM.
    // Do NOT add cloud_vlm_required to triedTiers (router never actually ran it).
    return missed();
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
export function formatCascadeResult(result: ClickTarget | null, miss?: CascadeMiss): string {
    if (!result) {
        if (!miss) return "cascade: no tier reached threshold → fall through to cloud VLM";
        const errs = Object.entries(miss.tierErrors).map(([t, e]) => `${t}:${e}`);
        return `cascade: no tier reached threshold (${miss.reason}${miss.axError ? `: ${miss.axError}` : ""}) tried=[${miss.triedTiers.join(",")}]${errs.length ? ` errors=[${errs.join(", ")}]` : ""}`;
    }
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
