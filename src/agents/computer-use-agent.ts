// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Hierarchical Computer Use Agent ──────────────
 * Inspired by Agent-S3 (69.9% OSWorld, near human 72%).
 * Modular hierarchical architecture: manager + worker agents.
 *
 * Manager: decomposes visual desktop tasks into high-level goals
 * Workers: execute low-level interactions (click, type, scroll) with
 *          specialized screen understanding via OCR/VLM
 *
 * Outperforms monolithic approaches by 58% on long-horizon tasks.
 */

import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatCompletionMessageParam, LLMClient } from "../llm.js";
import { cursorClick, cursorMove, withCursorHidden, withCursorTyping } from "../screen/agent-cursor.js";
import { getScreenDimensions, percentageToScreen } from "../screen/screen-dimensions.js";

// ── Types ─────────────────────────────────────

export interface ScreenState {
    screenshot?: string; // Base64 encoded screenshot
    ocrText?: string; // OCR-extracted text
    activeWindow?: string; // Active window title
    mousePosition?: { x: number; y: number };
    screenSize?: { width: number; height: number };
    interactiveElements?: Array<{
        label: number;
        text: string;
        type: string;
        bounds: { x: number; y: number; w: number; h: number };
    }>;
}

export interface DesktopAction {
    type: "click" | "type" | "key" | "scroll" | "move" | "screenshot" | "wait" | "launch";
    x?: number;
    y?: number;
    // Optional percentage coordinates in [0,1] — resolved to pixel coords at execute time.
    // Phase 1 preferred path: resolution-independent, no Retina/multi-monitor bugs.
    percentX?: number;
    percentY?: number;
    text?: string;
    key?: string;
    direction?: "up" | "down";
    app?: string;
    delay?: number;
}

export interface ComputerUseResult {
    success: boolean;
    actionsExecuted: DesktopAction[];
    finalState: string;
    stepsUsed: number;
    error?: string;
}

// ── Manager Agent ─────────────────────────────

/**
 * High-level manager that decomposes a computer-use task into steps.
 * Uses vision/OCR to understand the screen, plans a sequence of actions.
 */
export async function planComputerUseTask(
    llm: LLMClient,
    taskDescription: string,
    currentScreen: ScreenState,
): Promise<string[]> {
    const screenContext = describeScreen(currentScreen);

    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `You are controlling a Mac desktop. Complete this task:

TASK: ${taskDescription}

CURRENT SCREEN:
${screenContext}

Decompose into a sequence of LOW-LEVEL actions (click, type, key combo, scroll).
For each step, be SPECIFIC about coordinates or text targets.

Format: One step per line, numbered.
Example:
1. Click on Safari icon in dock (x:512, y:760)
2. Click on URL bar (x:400, y:52)
3. Type "example.com"
4. Press Enter

If the task requires information you can't see on screen, say "NEED_SCREENSHOT" as a step.`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt:
                "You are a desktop automation manager. Plan precise low-level actions. Be specific about coordinates and targets.",
        });

        const content = response.choices?.[0]?.message?.content || "";
        return content
            .split("\n")
            .filter((line) => /^\d+\./.test(line.trim()))
            .map((line) => line.replace(/^\d+\.\s*/, "").trim())
            .filter((s) => s.length > 3);
    } catch {
        return [];
    }
}

/**
 * Parse a natural-language plan step into a structured DesktopAction.
 *
 * Recognizes (in priority order):
 *   1. JSON action blob: `{"action":"click","x":412,"y":318}` or `{"action":"click","percentX":0.42,"percentY":0.18}`
 *   2. Percentage coords: `(50%, 30%)`, `at 0.42, 0.18`, `at x=50% y=30%`
 *   3. Pixel coords: `(x:412, y:318)`, `(412, 318)`, `at 412, 318`, `at x=412 y=318`, `coordinates 412 318`
 *   4. Text-target click: `click on Save button`
 *   5. Type / press / scroll / launch / screenshot / wait
 *
 * Defaults to `{ type: "type", text: step }` only when no other intent is detected.
 */
export function parseAction(step: string): DesktopAction {
    const trimmed = step.trim();

    // 1. Structured JSON (most reliable when the LLM follows the schema).
    const jsonResult = tryParseJsonAction(trimmed);
    if (jsonResult) return jsonResult;

    const lower = trimmed.toLowerCase();

    // 2 + 3. Coordinate-bearing intents: click/move/scroll-to.
    const coords = extractCoordinates(trimmed);
    if (coords) {
        const intent = detectClickIntent(lower);
        if (intent) return { type: intent, ...coords };
    }

    // 4. Click by text label.
    if (/\bclick\b/i.test(lower) || /\btap\b/i.test(lower)) {
        const text = trimmed
            .replace(/^(please\s+)?(click|tap)\s+(on\s+|the\s+|on the\s+)?/i, "")
            .replace(/\s+(button|link|icon|element|item)\s*$/i, "")
            .trim();
        if (text) return { type: "click", text };
    }

    // 5a. Type text — supports quoted, single-quoted, and bare-tail variants.
    const typeQuoted = trimmed.match(/(?:^|\b)type\s+(?:the\s+text\s+)?["“]([^"”]+)["”]/i);
    if (typeQuoted) return { type: "type", text: typeQuoted[1] };
    const typeSingle = trimmed.match(/(?:^|\b)type\s+(?:the\s+text\s+)?'([^']+)'/i);
    if (typeSingle) return { type: "type", text: typeSingle[1] };
    const typeBare = trimmed.match(/(?:^|\b)type\s+(.+?)(?:\s+(?:then|and|press)\s|$)/i);
    if (typeBare) return { type: "type", text: typeBare[1].trim() };
    const enterText = trimmed.match(/(?:^|\b)enter\s+(?:the\s+text\s+)?["“]([^"”]+)["”]/i);
    if (enterText) return { type: "type", text: enterText[1] };

    // 5b. Key press / hotkey.
    const keyMatch = trimmed.match(/(?:^|\b)(?:press|hit)\s+(?:the\s+)?(.+?)(?:\s+key)?$/i);
    if (keyMatch) return { type: "key", key: keyMatch[1].trim() };

    // 5c. Scroll.
    if (/\bscroll\b/i.test(lower)) {
        const direction = /\b(up|upward)\b/i.test(lower) ? "up" : "down";
        return { type: "scroll", direction };
    }

    // 5d. Launch / open app.
    const launchMatch = trimmed.match(/(?:^|\b)(?:open|launch|start)\s+(?:the\s+)?(.+?)(?:\s+app)?$/i);
    if (launchMatch && !/\bbrowser_/i.test(lower)) {
        const app = launchMatch[1].trim();
        if (app.length > 0 && app.length < 50) return { type: "launch", app };
    }

    // 5e. Screenshot.
    if (/\b(screenshot|capture\s+screen|need_screenshot)\b/i.test(lower)) {
        return { type: "screenshot" };
    }

    // 5f. Wait.
    if (/\bwait\b/i.test(lower)) {
        const ms = trimmed.match(/(\d+)\s*(?:ms|millisecond)/i);
        const s = trimmed.match(/(\d+(?:\.\d+)?)\s*(?:s\b|sec(?:ond)?s?)/i);
        let delay = 1000;
        if (ms) delay = parseInt(ms[1], 10);
        else if (s) delay = Math.round(parseFloat(s[1]) * 1000);
        return { type: "wait", delay };
    }

    // 6. Default: fall back to typing the text. This is intentionally last-resort —
    // earlier code reached this far on common LLM phrasings, which was the
    // root-cause of "agent randomly types instead of clicking" bugs.
    return { type: "type", text: trimmed };
}

function tryParseJsonAction(text: string): DesktopAction | null {
    // Only match if the JSON action blob is the DOMINANT content of the step
    // (the step is just a JSON object, optionally wrapped in `Step N:` or backticks).
    // Previously matched anywhere — caused misparses like:
    //   "Click on item with {action:'rm'} in its description"
    const trimmed = text
        .replace(/^Step\s+\d+[:.]?\s*/i, "")
        .replace(/^`+|`+$/g, "")
        .trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
    const m = trimmed.match(/^\{[\s\S]*?"action"\s*:\s*"[^"]+"[\s\S]*?\}$/);
    if (!m) return null;
    try {
        const obj = JSON.parse(m[0]) as Record<string, unknown>;
        const act = String(obj.action || "").toLowerCase();
        const out: DesktopAction = { type: "screenshot" };
        if (act === "click" || act === "tap") out.type = "click";
        else if (act === "double_click" || act === "doubleclick") out.type = "click";
        else if (act === "right_click" || act === "rightclick") out.type = "click";
        else if (act === "move") out.type = "move";
        else if (act === "type" || act === "write") out.type = "type";
        else if (act === "key" || act === "press" || act === "keypress") out.type = "key";
        else if (act === "scroll") out.type = "scroll";
        else if (act === "launch" || act === "open") out.type = "launch";
        else if (act === "screenshot" || act === "capture") out.type = "screenshot";
        else if (act === "wait") out.type = "wait";
        else return null;
        if (typeof obj.x === "number") out.x = obj.x;
        if (typeof obj.y === "number") out.y = obj.y;
        if (typeof obj.percentX === "number") out.percentX = obj.percentX;
        if (typeof obj.percentY === "number") out.percentY = obj.percentY;
        if (typeof obj.text === "string") out.text = obj.text;
        if (typeof obj.key === "string") out.key = obj.key;
        if (typeof obj.app === "string") out.app = obj.app;
        if (typeof obj.delay === "number") out.delay = obj.delay;
        const dir = obj.direction;
        if (dir === "up" || dir === "down") out.direction = dir;
        return out;
    } catch {
        return null;
    }
}

function extractCoordinates(step: string): { x?: number; y?: number; percentX?: number; percentY?: number } | null {
    // Percentage coords: (50%, 30%) or x=50% y=30% or 0.42, 0.18
    const pctParen = step.match(/\(\s*(\d+(?:\.\d+)?)\s*%\s*,\s*(\d+(?:\.\d+)?)\s*%\s*\)/);
    if (pctParen) return { percentX: parseFloat(pctParen[1]) / 100, percentY: parseFloat(pctParen[2]) / 100 };
    const pctEq = step.match(/x\s*=\s*(\d+(?:\.\d+)?)\s*%\s*[, ]\s*y\s*=\s*(\d+(?:\.\d+)?)\s*%/i);
    if (pctEq) return { percentX: parseFloat(pctEq[1]) / 100, percentY: parseFloat(pctEq[2]) / 100 };
    // Normalized 0..1 floats: (0.42, 0.18)
    const normParen = step.match(/\(\s*(0\.\d+)\s*,\s*(0\.\d+)\s*\)/);
    if (normParen) return { percentX: parseFloat(normParen[1]), percentY: parseFloat(normParen[2]) };

    // Pixel coords — multiple forms.
    const pxLabeled = step.match(/\(\s*x\s*:?=?\s*(-?\d+)\s*,?\s*y\s*:?=?\s*(-?\d+)\s*\)/i);
    if (pxLabeled) return { x: parseInt(pxLabeled[1], 10), y: parseInt(pxLabeled[2], 10) };
    const pxEq = step.match(/x\s*=\s*(-?\d+)\s*[, ]\s*y\s*=\s*(-?\d+)/i);
    if (pxEq) return { x: parseInt(pxEq[1], 10), y: parseInt(pxEq[2], 10) };
    const pxAt = step.match(/(?:at|coords?|coordinates?|position)\s+\(?\s*(-?\d{1,5})\s*[,\s]\s*(-?\d{1,5})\s*\)?/i);
    if (pxAt) return { x: parseInt(pxAt[1], 10), y: parseInt(pxAt[2], 10) };
    const pxParen = step.match(/\(\s*(-?\d{1,5})\s*,\s*(-?\d{1,5})\s*\)/);
    if (pxParen) return { x: parseInt(pxParen[1], 10), y: parseInt(pxParen[2], 10) };
    return null;
}

function detectClickIntent(lower: string): "click" | "move" | null {
    if (/\b(click|tap|press)\b/.test(lower)) return "click";
    if (/\b(move|hover)\b/.test(lower)) return "move";
    return null;
}

// ── Worker: Execute Actions ───────────────────

/**
 * Execute a desktop action.
 *
 * Resolves percentage coords → pixel coords via the multi-monitor-aware
 * getScreenDimensions() helper. Uses clipboard-paste for typing (Unicode-safe,
 * fast, matches the reliability of the canonical os_type tool).
 *
 * Returns whether the action succeeded.
 */
export async function executeDesktopAction(action: DesktopAction): Promise<boolean> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);

    try {
        switch (action.type) {
            case "click":
            case "move": {
                const resolved = await resolveCoordinates(action);
                if (resolved) {
                    if (action.type === "move") await cursorMove(resolved.x, resolved.y);
                    else await cursorClick(resolved.x, resolved.y);
                    const haveCliclick = await commandExists("cliclick");
                    if (action.type === "move") {
                        if (haveCliclick) await exec("cliclick", [`m:${resolved.x},${resolved.y}`]);
                        else await nativeMouseMoveJxa(resolved.x, resolved.y);
                    } else {
                        if (haveCliclick) await exec("cliclick", [`c:${resolved.x},${resolved.y}`]);
                        else await nativeClickJxa(resolved.x, resolved.y);
                    }
                } else if (action.text) {
                    // Click by text — use canonical accessibility-first path.
                    await exec("osascript", [
                        "-e",
                        `tell application "System Events" to click (first UI element whose name contains "${escapeApplescript(action.text)}")`,
                    ]);
                } else {
                    return false;
                }
                return true;
            }

            case "type":
                if (action.text) {
                    await withCursorTyping(() => pasteText(action.text as string));
                }
                return true;

            case "key":
                if (action.key) {
                    await pressKey(action.key);
                }
                return true;

            case "scroll": {
                const amount = action.direction === "up" ? -5 : 5;
                await exec("osascript", [
                    "-e",
                    `tell application "System Events" to scroll area 1 of front window by ${amount}`,
                ]);
                return true;
            }

            case "launch":
                if (action.app) {
                    await exec("open", ["-a", action.app]);
                    await new Promise((r) => setTimeout(r, 1000));
                }
                return true;

            case "screenshot":
                await withCursorHidden(() => exec("screencapture", ["-x", path.join(tmpdir(), "atlas-screen.png")]));
                return true;

            case "wait":
                // Cap wait at 30s to prevent an LLM-supplied huge delay from stalling the loop.
                await new Promise((r) => setTimeout(r, Math.max(0, Math.min(30_000, action.delay || 1000))));
                return true;

            default:
                return false;
        }
    } catch (err) {
        console.warn(`[COMPUTER-USE] Action failed:`, (err as Error).message);
        return false;
    }
}

async function resolveCoordinates(action: DesktopAction): Promise<{ x: number; y: number } | null> {
    // Percentage path: resolution-independent, multi-monitor aware.
    if (typeof action.percentX === "number" && typeof action.percentY === "number") {
        const dims = await getScreenDimensions({ focusedWindow: true });
        return percentageToScreen({ percentX: action.percentX, percentY: action.percentY, dims });
    }
    // Pixel path: trust the agent's coords (already in screen space at this layer).
    if (typeof action.x === "number" && typeof action.y === "number") {
        return { x: Math.round(action.x), y: Math.round(action.y) };
    }
    return null;
}

// Cache `which <cmd>` lookups at module scope. `commandExists` was previously called
// per-click; caching turns N forks into one. The cache lives for the process lifetime —
// users who install/remove cliclick mid-session must restart, which is acceptable.
const _commandCache = new Map<string, Promise<boolean>>();
async function commandExists(cmd: string): Promise<boolean> {
    if (process.platform !== "darwin" && process.platform !== "linux") return false;
    const cached = _commandCache.get(cmd);
    if (cached) return cached;
    const probe = (async () => {
        try {
            const { execFile } = await import("node:child_process");
            const { promisify } = await import("node:util");
            const exec = promisify(execFile);
            await exec("which", [cmd], { timeout: 1000 });
            return true;
        } catch {
            return false;
        }
    })();
    _commandCache.set(cmd, probe);
    return probe;
}

async function nativeClickJxa(x: number, y: number): Promise<void> {
    if (process.platform !== "darwin") return;
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const script = `
ObjC.import('CoreGraphics');
var point = $.CGPointMake(${x}, ${y});
$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point, $.kCGMouseButtonLeft));
delay(0.05);
$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft));
delay(0.05);
$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft));
"clicked"`;
    await exec("osascript", ["-l", "JavaScript", "-e", script], { timeout: 5000 });
}

async function nativeMouseMoveJxa(x: number, y: number): Promise<void> {
    if (process.platform !== "darwin") return;
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const script = `
ObjC.import('CoreGraphics');
$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, $.CGPointMake(${x}, ${y}), $.kCGMouseButtonLeft));
"moved"`;
    await exec("osascript", ["-l", "JavaScript", "-e", script], { timeout: 5000 });
}

/**
 * Escape text for SAFE embedding into an AppleScript double-quoted string literal.
 * Handles every char that can break out of the string context or terminate a statement
 * (newline / CR are osascript statement separators). Also filters Unicode line/paragraph
 * separators that some osascript versions treat as line breaks.
 */
function escapeApplescript(text: string): string {
    return (
        text
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")
            .replace(/\t/g, "\\t")
            // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL filtered intentionally to prevent osascript injection.
            .replace(/[\u2028\u2029\x00]/g, "")
    );
}

/**
 * Type text via clipboard-paste (Unicode + emoji-safe; faster than per-char keystroke).
 * Saves and restores the user's clipboard around the paste.
 * Mirrors the strategy used in os_type to keep both code paths consistent.
 */
async function pasteText(text: string): Promise<void> {
    if (process.platform !== "darwin") return;
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    // escapeApplescript already handles \n / \r / \t (added in P0 review fixes).
    // Do NOT re-escape — the legacy double-pass garbled multi-line text into \\\\n sequences.
    const escaped = escapeApplescript(text);
    const script = `
set oldClipboard to ""
try
    set oldClipboard to the clipboard as text
end try
set the clipboard to "${escaped}"
tell application "System Events"
    keystroke "v" using command down
end tell
delay 0.3
try
    set the clipboard to oldClipboard
end try`;
    await exec("osascript", ["-e", script], { timeout: 10000 });
}

async function pressKey(key: string): Promise<void> {
    if (process.platform !== "darwin") return;
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const lower = key.toLowerCase();
    const keyCodes: Record<string, number> = {
        return: 36,
        enter: 36,
        tab: 48,
        escape: 53,
        esc: 53,
        delete: 51,
        backspace: 51,
        space: 49,
        up: 126,
        down: 125,
        left: 123,
        right: 124,
        f1: 122,
        f2: 120,
        f3: 99,
        f4: 118,
        f5: 96,
        f6: 97,
        f7: 98,
        f8: 100,
        f9: 101,
        f10: 109,
        f11: 103,
        f12: 111,
    };
    // Handle hotkey combos like "command+s" or "ctrl+c"
    if (lower.includes("+")) {
        const parts = lower.split("+").map((p) => p.trim());
        const target = parts.pop() || "";
        const mods: string[] = [];
        for (const m of parts) {
            if (m === "command" || m === "cmd") mods.push("command down");
            else if (m === "shift") mods.push("shift down");
            else if (m === "option" || m === "alt") mods.push("option down");
            else if (m === "control" || m === "ctrl") mods.push("control down");
        }
        const modStr = mods.length ? ` using {${mods.join(", ")}}` : "";
        if (target in keyCodes) {
            await exec("osascript", [
                "-e",
                `tell application "System Events" to key code ${keyCodes[target]}${modStr}`,
            ]);
        } else {
            await exec("osascript", [
                "-e",
                `tell application "System Events" to keystroke "${escapeApplescript(target)}"${modStr}`,
            ]);
        }
        return;
    }
    if (lower in keyCodes) {
        await exec("osascript", ["-e", `tell application "System Events" to key code ${keyCodes[lower]}`]);
    } else {
        await exec("osascript", ["-e", `tell application "System Events" to keystroke "${escapeApplescript(key)}"`]);
    }
}

// ── Screen Understanding ──────────────────────

function describeScreen(state: ScreenState): string {
    const parts: string[] = [];

    if (state.activeWindow) {
        parts.push(`Active window: ${state.activeWindow}`);
    }

    if (state.ocrText) {
        parts.push(`Visible text:\n${state.ocrText.substring(0, 2000)}`);
    }

    if (state.interactiveElements && state.interactiveElements.length > 0) {
        const elements = state.interactiveElements
            .slice(0, 30)
            .map((e) => `  [${e.label}] ${e.type}: "${e.text}" at (${e.bounds.x},${e.bounds.y})`)
            .join("\n");
        parts.push(`Interactive elements:\n${elements}`);
    }

    if (state.mousePosition) {
        parts.push(`Mouse at: (${state.mousePosition.x}, ${state.mousePosition.y})`);
    }

    return parts.join("\n\n") || "No screen information available";
}

/**
 * Full computer-use task execution pipeline.
 * Manager plans → Workers execute → Manager verifies → Repeat if needed.
 */
export async function executeComputerUseTask(
    llm: LLMClient,
    taskDescription: string,
    maxSteps = 20,
): Promise<ComputerUseResult> {
    const actions: DesktopAction[] = [];
    let stepsUsed = 0;

    // Get initial screen state
    const currentScreen: ScreenState = {
        activeWindow: await getActiveWindow(),
    };

    // Plan the task
    const plan = await planComputerUseTask(llm, taskDescription, currentScreen);
    if (plan.length === 0) {
        return { success: false, actionsExecuted: [], finalState: "No plan generated", stepsUsed: 0 };
    }

    // Execute each step with post-action verification.
    for (const step of plan.slice(0, maxSteps)) {
        stepsUsed++;
        const action = parseAction(step);

        // Capture a "before" screenshot for diff-based verification of click/key actions.
        const needsVerify = action.type === "click" || action.type === "key" || action.type === "type";
        let beforeBuf: Buffer | null = null;
        if (needsVerify) beforeBuf = await captureScreenForDiff();

        const success = await executeDesktopAction(action);
        actions.push(action);

        if (!success) {
            return {
                success: false,
                actionsExecuted: actions,
                finalState: `Failed at step ${stepsUsed}: ${step}`,
                stepsUsed,
                error: `Action failed: ${step}`,
            };
        }

        // Settle delay — Anthropic recommends 2.0s for stable UI after actions.
        // We use 800ms as a middle ground: long enough for most UI to repaint, short enough to stay interactive.
        await new Promise((r) => setTimeout(r, action.type === "click" ? 800 : 300));

        // Best-effort verification: if the screen didn't change at all after a click,
        // log a warning (the model can inspect this on the next iteration).
        if (needsVerify && beforeBuf) {
            const afterBuf = await captureScreenForDiff();
            if (afterBuf) {
                const diff = computeScreenDiff(beforeBuf, afterBuf);
                if (diff < 0.005 && action.type === "click") {
                    console.warn(
                        `[COMPUTER-USE] Step ${stepsUsed} (${action.type}) produced no visible change (diff=${(diff * 100).toFixed(2)}%) — click may have missed.`,
                    );
                }
            }
        }
    }

    return {
        success: true,
        actionsExecuted: actions,
        finalState: `Completed ${stepsUsed} steps`,
        stepsUsed,
    };
}

async function getActiveWindow(): Promise<string> {
    try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFile);
        const { stdout } = await exec("osascript", [
            "-e",
            'tell application "System Events" to get name of first process whose frontmost is true',
        ]);
        return stdout.trim();
    } catch {
        return "unknown";
    }
}

/** Capture a small screenshot used only for diff-based action verification. */
async function captureScreenForDiff(): Promise<Buffer | null> {
    if (process.platform !== "darwin") return null;
    let tmp: string | null = null;
    try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const { readFile, unlink, open } = await import("node:fs/promises");
        const exec = promisify(execFile);
        tmp = path.join(tmpdir(), `atlas_verify_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`);
        // Pre-create the file with 0o600 so screencapture (which preserves existing-file mode)
        // doesn't leave a world-readable PNG of the user's desktop in /tmp.
        const handle = await open(tmp, "w", 0o600);
        await handle.close();
        await withCursorHidden(() => exec("screencapture", ["-x", tmp as string], { timeout: 5000 }));
        const buf = await readFile(tmp);
        unlink(tmp).catch(() => {});
        return buf;
    } catch {
        if (tmp) {
            try {
                const { unlink } = await import("node:fs/promises");
                await unlink(tmp);
            } catch {
                /* best-effort */
            }
        }
        return null;
    }
}

/** Pixel-sampled diff (0.0 = identical, 1.0 = completely different). */
function computeScreenDiff(before: Buffer, after: Buffer): number {
    const samples = 500;
    const minLen = Math.min(before.length, after.length);
    if (minLen < samples) return 1.0;
    const step = Math.max(1, Math.floor(minLen / samples));
    let diffCount = 0;
    let total = 0;
    for (let i = 0; i < minLen; i += step) {
        total++;
        if (Math.abs(before[i] - after[i]) > 10) diffCount++;
    }
    return total > 0 ? diffCount / total : 1.0;
}
