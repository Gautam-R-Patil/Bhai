// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// TypeScript wrapper for native Rust browser-agent acceleration module.
// Mirrors the pattern of src/native/index.ts — graceful JS fallback if .node unavailable.
//
// Exports:
//   Browser agent:  scoreElementCandidates, setVideoPlayerState, getVideoPlayerState,
//                   invalidateVideoState, checkBrowserRateLimit, recordBrowserAction,
//                   detectActionLoop, resetActionLoop, getHoverHint,
//                   recordHoverSuccess, recordHoverFailure
//   IP guard:       validateJsCode, obfuscateInjectedVariable, rewriteInternalVars,
//                   signBrowserAction, verifyBrowserAction, getActionAuditTail,
//                   getModuleFingerprint, encryptSensitive, decryptSensitive

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ElementCandidate {
    label: number;
    tag: string;
    text: string;
    className: string;
    ariaLabel: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ScoredElement {
    label: number;
    score: number;
    reason: string;
}

export interface HoverHint {
    x: number;
    y: number;
    confidence: number;
}

interface NativeBrowserModule {
    // browser_agent
    scoreElementCandidates(
        desc: string,
        candidates: ElementCandidate[],
        vw?: number | null,
        vh?: number | null,
    ): ScoredElement[];
    setVideoPlayerState(url: string, stateJson: string): void;
    getVideoPlayerState(url: string): string | null;
    invalidateVideoState(url: string): void;
    getVideoCacheStats(): string;
    checkBrowserActionRateLimit(actionType: string, url: string): boolean;
    recordBrowserAction(actionType: string, url: string, selector: string, success: boolean): void;
    detectActionLoop(actionType: string, selector: string, url: string): boolean;
    resetActionLoop(actionType: string, selector: string, url: string): void;
    getBrowserActionStats(): string;
    getHoverHint(url: string, selector: string): HoverHint | null;
    recordHoverSuccess(url: string, selector: string, x: number, y: number): void;
    recordHoverFailure(url: string, selector: string): void;
    // ip_guard
    validateJsCode(code: string): string; // throws on blocked patterns
    obfuscateInjectedVariable(name: string): string;
    rewriteInternalVars(code: string): string;
    signBrowserAction(toolName: string, paramsJson: string): string;
    verifyBrowserAction(toolName: string, paramsJson: string, signature: string): boolean;
    getActionAuditTail(n: number): string;
    getIpGuardStats(): string;
    getModuleFingerprint(): string;
    encryptSensitive(plaintext: string): string;
    decryptSensitive(encrypted: string): string;
    // browser_guard
    classifyCaptcha(html: string): { kind: string; confidence: number; signals: string[] };
    scorePopupRisk(html: string): {
        cookieBannerProb: number;
        modalProb: number;
        runGuardEagerly: boolean;
        signals: string[];
    };
    getStealthUserAgent(platform: string, seed: number): string;
    getStealthInitScript(seed: number): string;
    compressElementsForLlm(elements: object[], maxTextLen?: number | null, maxElements?: number | null): string;
    humanTypingDelayMs(charCode: number, baseWpm: number): number;
    humanClickDwellMs(elementArea: number, seed: number): number;
    humanMouseParams(startX: number, startY: number, endX: number, endY: number, seed: number): number[];
}

// ── Load native module ────────────────────────────────────────────────────────

let native: NativeBrowserModule | null = null;

try {
    const nativePath = path.join(process.cwd(), "native", "index.js");
    const require = createRequire(import.meta.url);
    const mod = require(nativePath) as Record<string, unknown>;
    // Verify the key functions are present
    if (typeof mod.scoreElementCandidates === "function" && typeof mod.validateJsCode === "function") {
        native = mod as unknown as NativeBrowserModule;
        console.log("🦀 Browser agent native module loaded");
    }
} catch {
    // Native module not available — JS fallbacks used transparently
}

// ── Fallback implementations ──────────────────────────────────────────────────

function fallbackScoreElementCandidates(description: string, candidates: ElementCandidate[]): ScoredElement[] {
    const desc = description.toLowerCase();
    return candidates
        .map((el) => {
            let score = 0;
            const combined = `${el.text} ${el.ariaLabel} ${el.className}`.toLowerCase();
            // Simple token overlap
            const tokens = desc.split(/\s+/);
            const matches = tokens.filter((t) => combined.includes(t)).length;
            score += (matches / Math.max(tokens.length, 1)) * 0.5;
            if (el.className.includes("ytp-mute") && desc.includes("mute")) score += 0.3;
            if (el.className.includes("ytp-subtitles") && (desc.includes("caption") || desc.includes("subtitle")))
                score += 0.3;
            if (el.className.includes("ytp-play") && (desc.includes("play") || desc.includes("pause"))) score += 0.3;
            return { label: el.label, score: Math.min(score, 1), reason: "js_fallback" };
        })
        .sort((a, b) => b.score - a.score);
}

function fallbackValidateJsCode(code: string): string {
    const blocked = [
        "XMLHttpRequest",
        "fetch(",
        "WebSocket(",
        "eval(",
        "__proto__",
        "__hoverAddedNodes",
        "__hoverObserver",
    ];
    for (const p of blocked) {
        if (code.includes(p)) throw new Error(`ip_guard: blocked pattern '${p}'`);
    }
    return code;
}

// Session-scoped opaque names for JS fallback (not cryptographically derived, but functional)
const _fallbackVarMap = new Map<string, string>();
let _fallbackVarCounter = 0;
function fallbackObfuscate(name: string): string {
    if (!_fallbackVarMap.has(name)) {
        _fallbackVarMap.set(name, `__fb${(_fallbackVarCounter++).toString(16).padStart(4, "0")}`);
    }
    return _fallbackVarMap.get(name)!;
}

function fallbackRewriteVars(code: string): string {
    const internals = ["__hoverAddedNodes", "__hoverObserver", "__ytPlayerEvents", "__ytReady", "__ytStateChanges"];
    let result = code;
    for (const v of internals) result = result.replaceAll(v, fallbackObfuscate(v));
    return result;
}

// ── Exported API — thin passthrough with graceful fallback ───────────────────

/** Score DOM element candidates against a description. Best match is first. */
export function scoreElementCandidates(
    description: string,
    candidates: ElementCandidate[],
    viewportWidth?: number,
    viewportHeight?: number,
): ScoredElement[] {
    if (native)
        return (native as any)["scoreElementCandidates"](
            description,
            candidates,
            viewportWidth ?? null,
            viewportHeight ?? null,
        );
    return fallbackScoreElementCandidates(description, candidates);
}

/** Cache video player state after an action to avoid redundant page.evaluate() calls. */
export function setVideoPlayerState(url: string, stateJson: string): void {
    (native as any)?.["setVideoPlayerState"](url, stateJson);
}

/** Get cached player state. Returns null if not cached or stale (>10s). */
export function getVideoPlayerState(url: string): string | null {
    return (native as any)?.["getVideoPlayerState"](url) ?? null;
}

/** Invalidate video state cache for a URL (call on navigation). */
export function invalidateVideoState(url: string): void {
    (native as any)?.["invalidateVideoState"](url);
}

/** Check rate limit for a browser action on a URL. Returns false if throttled. */
export function checkBrowserRateLimit(actionType: string, url: string): boolean {
    return (native as any)?.["checkBrowserActionRateLimit"](actionType, url) ?? true; // fallback: allow
}

/** Record a browser action outcome for loop detection and stats. */
export function recordBrowserAction(actionType: string, url: string, selector: string, success: boolean): void {
    (native as any)?.["recordBrowserAction"](actionType, url, selector, success);
}

/** Detect if the agent is looping on the same failed action. Returns true = loop. */
export function detectActionLoop(actionType: string, selector: string, url: string): boolean {
    return (native as any)?.["detectActionLoop"](actionType, selector, url) ?? false;
}

/** Reset loop counter after the agent intentionally changes strategy. */
export function resetActionLoop(actionType: string, selector: string, url: string): void {
    (native as any)?.["resetActionLoop"](actionType, selector, url);
}

/** Get cached hover coordinates for a (url, selector) pair. Returns null if unknown. */
export function getHoverHint(url: string, selector: string): HoverHint | null {
    return (native as any)?.["getHoverHint"](url, selector) ?? null;
}

/** Record a successful hover at these coordinates. Updates EMA cache. */
export function recordHoverSuccess(url: string, selector: string, x: number, y: number): void {
    (native as any)?.["recordHoverSuccess"](url, selector, x, y);
}

/** Record a failed hover attempt. Lowers confidence for this selector. */
export function recordHoverFailure(url: string, selector: string): void {
    (native as any)?.["recordHoverFailure"](url, selector);
}

/**
 * Validate JavaScript code before passing to page.evaluate().
 * Blocks network exfiltration, ATLAS internals access, eval, __proto__.
 * Throws if blocked, returns original code if clean.
 */
export function validateJsCode(code: string): string {
    if (native) return (native as any)["validateJsCode"](code);
    return fallbackValidateJsCode(code);
}

/**
 * Return session-scoped opaque name for a proprietary injected variable.
 * Prevents reverse-engineering of our MutationObserver injection patterns.
 */
export function obfuscateInjectedVariable(name: string): string {
    if (native) return (native as any)["obfuscateInjectedVariable"](name);
    return fallbackObfuscate(name);
}

/**
 * Rewrite all ATLAS internal variable references in a JS code string
 * to their obfuscated session-scoped equivalents.
 */
export function rewriteInternalVars(code: string): string {
    if (native) return (native as any)["rewriteInternalVars"](code);
    return fallbackRewriteVars(code);
}

/**
 * HMAC-sign a browser tool call for tamper-evident audit trail.
 * Returns hex HMAC-SHA256.
 */
export function signBrowserAction(toolName: string, paramsJson: string): string {
    return (native as any)?.["signBrowserAction"](toolName, paramsJson) ?? "";
}

/** Verify a previously-issued action signature. */
export function verifyBrowserAction(toolName: string, paramsJson: string, signature: string): boolean {
    return (native as any)?.["verifyBrowserAction"](toolName, paramsJson, signature) ?? false;
}

/** Get last N entries of the tamper-evident action audit log as JSON. */
export function getActionAuditTail(n: number): string {
    return (native as any)?.["getActionAuditTail"](n) ?? "[]";
}

/** Get the compile-time module integrity fingerprint for boot-time tamper detection. */
export function getModuleFingerprint(): string {
    return (native as any)?.["getModuleFingerprint"]() ?? "unavailable";
}

/** Encrypt sensitive data with the session AES-256-GCM key. */
export function encryptSensitive(plaintext: string): string | null {
    try {
        return (native as any)?.["encryptSensitive"](plaintext) ?? null;
    } catch {
        return null;
    }
}

/** Decrypt data encrypted with encryptSensitive(). */
export function decryptSensitive(encrypted: string): string | null {
    try {
        return (native as any)?.["decryptSensitive"](encrypted) ?? null;
    } catch {
        return null;
    }
}

/** Whether the native module is loaded and active. */
export function isNativeBrowserAvailable(): boolean {
    return native !== null;
}

// ── browser_guard exports ─────────────────────────────────────────────────────

/** Classify CAPTCHA type from page HTML. Rust pattern matching — zero JS eval overhead. */
export function classifyCaptchaFromHtml(html: string): { kind: string; confidence: number; signals: string[] } {
    return (native as any)?.["classifyCaptcha"](html) ?? { kind: "none", confidence: 0, signals: [] };
}

/** Score popup/overlay risk from page HTML. Returns probabilities for cookie banner and modals. */
export function scorePopupRisk(html: string): {
    cookieBannerProb: number;
    modalProb: number;
    runGuardEagerly: boolean;
} {
    return (native as any)?.["scorePopupRisk"](html) ?? { cookieBannerProb: 0, modalProb: 0, runGuardEagerly: false };
}

/** Get Rust-generated stealth init script to inject via addInitScript(). Varies by session seed. */
export function getStealthInitScript(seed: number): string | null {
    return (native as any)?.["getStealthInitScript"](seed) ?? null;
}

/** Compress element list for LLM — deduplicates, groups repeats, truncates. ~30-50% fewer tokens. */
export function compressElementsForLlm(
    elements: Array<{
        label: number;
        tag: string;
        text: string;
        x: number;
        y: number;
        width?: number;
        height?: number;
        isOcr?: boolean;
        editorType?: string | null;
    }>,
    maxTextLen = 40,
    maxElements = 80,
): string {
    if (native) {
        // Ensure width/height have default 0 if not provided
        const withDims = elements.map((e) => ({ ...e, width: e.width ?? 0, height: e.height ?? 0 }));
        try {
            return (native as any)["compressElementsForLlm"](withDims, maxTextLen, maxElements);
        } catch {
            /* fallback */
        }
    }
    // JS fallback uses OpenCLI [N]<tag>text format
    return elements
        .slice(0, maxElements)
        .map((e) => {
            const t = (e.text ?? "").substring(0, maxTextLen);
            if (e.editorType) return `[${e.label}]<code-editor:${e.editorType}>`;
            if (e.isOcr) return `[${e.label}]<ocr>${t}`;
            return t ? `[${e.label}]<${e.tag}>${t}` : `[${e.label}]<${e.tag}>`;
        })
        .join("\n");
}

/** Rust human-like typing delay for a character (WPM-based with punctuation pauses). */
export function humanTypingDelayMs(charCode: number, wpm = 65): number {
    return (native as any)?.["humanTypingDelayMs"](charCode, wpm) ?? 35;
}

/** Rust Fitts's-law mouse movement: returns [steps, pre_pause_ms]. */
export function humanMouseParams(sx: number, sy: number, ex: number, ey: number, seed: number): [number, number] {
    const r = (native as any)?.["humanMouseParams"](sx, sy, ex, ey, seed);
    return r ? [r[0], r[1]] : [8, 120];
}
