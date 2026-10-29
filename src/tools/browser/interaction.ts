// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Interaction Tools ─────────────────
// Click, type, scroll, hover, drag, keyboard

import { vaultCall } from "../../security/vault.js";
import type { ToolDefinition } from "../get-current-time.js";
import { agentCursor } from "./agent-cursor.js";
import { checkAuthWall } from "./auth-wall.js";
import { getCurrentMode } from "./browser-backend.js";
import { CAPTCHA_HINT, quickCaptchaCheck } from "./captcha.js";
import {
    ATLAS_HUD_JS,
    buildElementsText,
    getActivePage,
    getActivePageIndex,
    getBrowser,
    getInteractiveElements,
    getLastElementMap,
    invalidateCache,
    SCROLL_INDICATOR_JS,
    setActivePageIndex,
    setLastElementMap,
    waitForPageReady,
} from "./core.js";
import {
    detectActionLoop,
    getHoverHint,
    obfuscateInjectedVariable,
    recordBrowserAction,
    recordHoverFailure,
    recordHoverSuccess,
} from "./native-browser.js";
import { armDialogAccept, takePageEvents } from "./popup-guard.js";
import { typeVaultText } from "./vault-typing.js";

const ACCEPT_DIALOG_PARAM = {
    type: "boolean",
    description:
        "Accept a confirm()/prompt() dialog this action opens (default: dismiss it). Use only when the user wants that confirmation.",
};

/** After a mutating action: wait for the page to settle (or the caller's explicit wait). */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page or ChromePageProxy
async function settleAfterAction(page: any, waitAfterMs: unknown): Promise<void> {
    if (waitAfterMs !== undefined) {
        if ((waitAfterMs as number) > 0) await page.waitForTimeout(waitAfterMs as number);
    } else {
        await waitForPageReady(page, 1500);
    }
    invalidateCache(); // the action changed the page: the next scan must be fresh
}

// ═══════════════════════════════════════════════
// TOOL: Click at coordinates or label
// ═══════════════════════════════════════════════

export const browserClickAt: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_click_at",
            description:
                "Click an element by its label number (from browser_scan) or x,y coordinates. PREFER using 'label' for accurate clicks.",
            parameters: {
                type: "object",
                properties: {
                    label: {
                        type: "number",
                        description: "Element label number from the browser_scan text list (PREFERRED — most accurate)",
                    },
                    x: { type: "number", description: "X coordinate (fallback if no label)" },
                    y: { type: "number", description: "Y coordinate (fallback if no label)" },
                    double_click: { type: "boolean", description: "Double click" },
                    ctrl: { type: "boolean", description: "Hold Ctrl/Cmd" },
                    shift: { type: "boolean", description: "Hold Shift" },
                    alt: { type: "boolean", description: "Hold Alt" },
                    meta: { type: "boolean", description: "Hold Meta/Cmd" },
                    wait_after_ms: {
                        type: "number",
                        description: "Fixed wait after clicking (default: wait until the page settles, max 1.5s)",
                    },
                    accept_dialog: ACCEPT_DIALOG_PARAM,
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const context = await getBrowser();
            let page = await getActivePage();
            armDialogAccept(input.accept_dialog === true);
            const lastElementMap = getLastElementMap();

            // ── Loop detection: warn if agent is hammering the same failed target ──
            const clickTarget = String(input.label ?? `${input.x},${input.y}`);
            if (detectActionLoop("click", clickTarget, page.url())) {
                return JSON.stringify({
                    error: `Loop detected: "click ${clickTarget}" has failed ${3}+ consecutive times. Try: browser_scan to refresh labels, browser_hover to reveal hidden controls, or browser_video_control for video player actions.`,
                    loop_detected: true,
                });
            }

            // ── Snapshot tab count BEFORE the click ──
            const tabCountBefore = context.pages().length;

            // Resolve coordinates and Handle from label or direct x,y
            let x: number, y: number;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let handle: any = null;

            if (input.label !== undefined) {
                const labelNum = Number(input.label);
                const el = lastElementMap.find((e) => e.label === labelNum);
                if (!el) {
                    return JSON.stringify({
                        error: `Label ${input.label} not found. Run browser_scan to refresh element labels.`,
                    });
                }
                x = el.x;
                y = el.y;
                handle = el.handle;
            } else if (input.x !== undefined && input.y !== undefined) {
                x = input.x as number;
                y = input.y as number;
            } else {
                return JSON.stringify({ error: "Provide 'label' (preferred) or 'x' + 'y' coordinates" });
            }

            // HUD: show what element is being clicked
            const hudLabel =
                input.label !== undefined
                    ? `🖱 Clicking "${(lastElementMap.find((e) => e.label === Number(input.label))?.text || "").substring(0, 30) || `#${input.label}`}"`
                    : `🖱 Clicking (${Math.round(x)}, ${Math.round(y)})`;
            await page
                .evaluate(`(${ATLAS_HUD_JS})(${JSON.stringify({ label: hudLabel, done: false })})`)
                .catch(() => {});

            const modifiers: string[] = [];
            if (input.ctrl) {
                await page.keyboard.down("Control");
                modifiers.push("Ctrl");
            }
            if (input.shift) {
                await page.keyboard.down("Shift");
                modifiers.push("Shift");
            }
            if (input.alt) {
                await page.keyboard.down("Alt");
                modifiers.push("Alt");
            }
            if (input.meta) {
                await page.keyboard.down("Meta");
                modifiers.push("Meta");
            }

            // Ensure modifiers are always released — even when errors are thrown below.
            // Without this, a click failure leaves modifier keys held for the whole session.
            const releaseModifiers = async () => {
                if (input.meta) await page.keyboard.up("Meta").catch(() => {});
                if (input.alt) await page.keyboard.up("Alt").catch(() => {});
                if (input.shift) await page.keyboard.up("Shift").catch(() => {});
                if (input.ctrl) await page.keyboard.up("Control").catch(() => {});
            };

            let executionMethod = "coordinates";
            const initialUrl = page.url();

            // Try to auto-recover from unexpected overlays blocking the click
            const attemptRecovery = async () => {
                console.log("Attempting error recovery: Dismissing active modal/overlay");
                await page.keyboard.press("Escape");
                await page.waitForTimeout(300);
            };

            try {
                if (handle) {
                    try {
                        // Hybrid Action: Try to use the native DOM handle first for maximum stability
                        // Bounded: an aria-ref Locator whose element is gone waits (30s default) instead of failing.
                        await handle.scrollIntoViewIfNeeded({ timeout: 1000 });
                        await agentCursor(page, handle, input.double_click ? "double" : "click");

                        if (input.double_click) {
                            await handle.dblclick({ timeout: 2000 });
                        } else {
                            await handle.click({ timeout: 2000 });
                        }
                        executionMethod = "element_handle";
                    } catch (handleErr) {
                        const errMsg = (handleErr as Error).message;
                        // A Locator matching nothing now (page changed since the scan) is a stale label.
                        const gone = typeof handle.count === "function" && (await handle.count().catch(() => 1)) === 0;
                        if (errMsg.includes("intercepts pointer events") || errMsg.includes("overlay")) {
                            await attemptRecovery();
                            try {
                                // Retry once after recovery
                                if (input.double_click) {
                                    await handle.dblclick({ timeout: 2000 });
                                } else {
                                    await handle.click({ timeout: 2000 });
                                }
                                executionMethod = "element_handle_recovered";
                            } catch {
                                executionMethod = "coordinates_fallback";
                                await page.waitForTimeout(150);
                                await (input.double_click ? page.mouse.dblclick(x, y) : page.mouse.click(x, y));
                            }
                        } else if (gone || /detached|not attached|not visible/.test(errMsg)) {
                            return JSON.stringify({
                                error: `Target vanished or detached: the page changed since the scan, or a dropdown/modal closed before the click. Run browser_scan for fresh labels (re-open the dropdown first if it closed).`,
                                raw_error: errMsg,
                            });
                        } else {
                            executionMethod = "coordinates_fallback";
                            await page.waitForTimeout(150);
                            await (input.double_click ? page.mouse.dblclick(x, y) : page.mouse.click(x, y));
                        }
                    }
                } else {
                    // Pure coordinate fallback
                    await agentCursor(page, { x, y }, input.double_click ? "double" : "click");
                    if (input.double_click) {
                        await page.mouse.dblclick(x, y);
                    } else {
                        await page.mouse.click(x, y);
                    }
                }
            } finally {
                await releaseModifiers();
            }

            await settleAfterAction(page, input.wait_after_ms);
            armDialogAccept(false); // an armed accept never outlives its action

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const stateTransitions: any = {};

            // ── New tab (target=_blank link, OAuth/payment popup): follow it ──
            const allPages = context.pages();
            if (allPages.length > tabCountBefore) {
                const newIdx = allPages.length - 1;
                const opener = page;
                page = allPages[newIdx];
                await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
                await waitForPageReady(page, 1500);
                await page.bringToFront().catch(() => {});
                setActivePageIndex(newIdx, { page, opener }); // closing it (or it closing itself) returns to the opener
                stateTransitions.new_tab = `The click opened a new tab; switched to it (tab ${newIdx}). browser_switch_tab with close_active:true returns to the previous tab.`;
            }

            // State Verifier
            const finalUrl = page.url();
            const navigated = initialUrl !== finalUrl;
            let captchaType: string | null = null;
            if (navigated) {
                stateTransitions.navigation = `Navigated from ${initialUrl} to ${finalUrl}`;
                await waitForPageReady(page);
                captchaType = await quickCaptchaCheck(page);
            }
            // Login/OTP wall after a navigation (may import the Chrome session and reload).
            const authFields = navigated && !captchaType ? await checkAuthWall(page) : {};

            const newElementMap = await getInteractiveElements(page);
            setLastElementMap(newElementMap);

            // Record success for native loop/rate tracker
            recordBrowserAction("click", page.url(), String(input.label ?? `${x},${y}`), true);
            await page.evaluate(`(${ATLAS_HUD_JS})(${JSON.stringify({ label: "", done: true })})`).catch(() => {});

            return JSON.stringify({
                success: true,
                clicked_at: { x, y },
                label: input.label,
                method: executionMethod,
                state_changes: stateTransitions,
                modifiers,
                title: await page.title(),
                url: page.url(),
                open_tabs: context.pages().length,
                // Ahead of the element list, which the result cap cuts first.
                ...(captchaType ? { captcha_detected: true, captcha_type: captchaType, hint: CAPTCHA_HINT } : {}),
                ...authFields,
                ...takePageEvents(),
                interactive_elements_text: buildElementsText(),
            });
        } catch (err) {
            // Record failure for loop detection
            try {
                const pg = await getActivePage();
                const clickTarget = String(input.label ?? `${input.x},${input.y}`);
                recordBrowserAction("click", pg.url(), clickTarget, false);
            } catch {
                /* non-fatal */
            }
            return JSON.stringify({ error: `Click failed: ${(err as Error).message}`, ...takePageEvents() });
        } finally {
            armDialogAccept(false); // early returns (stale label, loop, vanished target) included
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Click by text/selector (fallback)
// ═══════════════════════════════════════════════

export const browserClick: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_click",
            description:
                "Click an element by CSS selector or visible text. If this fails, use browser_click_at with coordinates instead.",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "CSS selector" },
                    text: { type: "string", description: "Visible text to click" },
                    wait_after_ms: {
                        type: "number",
                        description: "Fixed wait after clicking (default: wait until the page settles, max 1.5s)",
                    },
                    accept_dialog: ACCEPT_DIALOG_PARAM,
                },
                required: [],
            },
        },
    },
    async handler(input) {
        armDialogAccept(input.accept_dialog === true);
        try {
            const page = await getActivePage();

            if (input.text) {
                const el = page.getByText(input.text as string, { exact: false }).first();
                const box = await el.boundingBox().catch(() => null);
                if (box) {
                    const cx = box.x + box.width / 2;
                    const cy = box.y + box.height / 2;
                    await agentCursor(page, { x: cx, y: cy }, "click");
                    await page.mouse.click(cx, cy);
                } else {
                    return JSON.stringify({
                        error: `Text "${input.text}" not found on visible page. Use browser_scan to see elements, then browser_click_at with label.`,
                    });
                }
            } else if (input.selector) {
                const el = page.locator(input.selector as string).first();
                const box = await el.boundingBox().catch(() => null);
                if (box) {
                    const cx = box.x + box.width / 2;
                    const cy = box.y + box.height / 2;
                    await agentCursor(page, { x: cx, y: cy }, "click");
                    await page.mouse.click(cx, cy);
                } else {
                    return JSON.stringify({
                        error: `Selector "${input.selector}" not found. Use browser_scan to see elements, then browser_click_at with label.`,
                    });
                }
            } else {
                return JSON.stringify({ error: "Provide 'selector' or 'text'" });
            }

            await settleAfterAction(page, input.wait_after_ms);
            const newElementMap = await getInteractiveElements(page);
            setLastElementMap(newElementMap);
            return JSON.stringify({
                success: true,
                clicked: input.selector || input.text,
                title: await page.title(),
                url: page.url(),
                ...takePageEvents(),
                interactive_elements_text: buildElementsText(),
            });
        } catch (err) {
            return JSON.stringify({
                error: `Click failed: ${(err as Error).message}. Use browser_scan + browser_click_at with label instead.`,
                ...takePageEvents(),
            });
        } finally {
            armDialogAccept(false);
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Right click
// ═══════════════════════════════════════════════

export const browserRightClick: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_right_click",
            description: "Right-click at specific x,y coordinates. Shows a red circle indicator.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number", description: "X coordinate" },
                    y: { type: "number", description: "Y coordinate" },
                },
                required: ["x", "y"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const x = input.x as number;
            const y = input.y as number;

            await agentCursor(page, { x, y }, "right");
            await page.waitForTimeout(200);
            await page.mouse.click(x, y, { button: "right" });
            await page.waitForTimeout(200);
            invalidateCache();

            return JSON.stringify({ success: true, right_clicked_at: { x, y } });
        } catch (err) {
            return JSON.stringify({ error: `Right click failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Click and hold
// ═══════════════════════════════════════════════

export const browserHoldClick: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_hold_click",
            description: "Click and hold at x,y coordinates for a specified duration. Shows a green circle indicator.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number", description: "X coordinate" },
                    y: { type: "number", description: "Y coordinate" },
                    duration_ms: { type: "number", description: "How long to hold in milliseconds (default: 1000)" },
                },
                required: ["x", "y"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const x = input.x as number;
            const y = input.y as number;
            const duration = (input.duration_ms as number) || 1000;

            await agentCursor(page, { x, y }, "hold");
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.waitForTimeout(duration);
            await page.mouse.up();
            invalidateCache();

            return JSON.stringify({ success: true, held_at: { x, y }, duration_ms: duration });
        } catch (err) {
            return JSON.stringify({ error: `Hold click failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Drag
// ═══════════════════════════════════════════════

export const browserDrag: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_drag",
            description: "Click and drag from one point to another.",
            parameters: {
                type: "object",
                properties: {
                    from_x: { type: "number", description: "Start X coordinate" },
                    from_y: { type: "number", description: "Start Y coordinate" },
                    to_x: { type: "number", description: "End X coordinate" },
                    to_y: { type: "number", description: "End Y coordinate" },
                    steps: {
                        type: "number",
                        description: "Number of intermediate steps (default: 10, higher is smoother)",
                    },
                    ctrl: { type: "boolean", description: "Hold Ctrl/Cmd" },
                    shift: { type: "boolean", description: "Hold Shift (Constrains movement)" },
                    alt: { type: "boolean", description: "Hold Alt (Duplicates in design tools)" },
                    meta: { type: "boolean", description: "Hold Meta/Cmd" },
                },
                required: ["from_x", "from_y", "to_x", "to_y"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const fx = input.from_x as number;
            const fy = input.from_y as number;
            const tx = input.to_x as number;
            const ty = input.to_y as number;
            const steps = (input.steps as number) || 10;

            const modifiers: string[] = [];
            if (input.ctrl) {
                await page.keyboard.down("Control");
                modifiers.push("Ctrl");
            }
            if (input.shift) {
                await page.keyboard.down("Shift");
                modifiers.push("Shift");
            }
            if (input.alt) {
                await page.keyboard.down("Alt");
                modifiers.push("Alt");
            }
            if (input.meta) {
                await page.keyboard.down("Meta");
                modifiers.push("Meta");
            }

            await agentCursor(page, { x: fx, y: fy }, "hold");
            await page.mouse.move(fx, fy);
            await page.mouse.down();
            await agentCursor(page, { x: tx, y: ty }, "hover"); // never alongside the real move (Chrome bridge)
            await page.mouse.move(tx, ty, { steps });
            await page.mouse.up();

            if (input.meta) await page.keyboard.up("Meta");
            if (input.alt) await page.keyboard.up("Alt");
            if (input.shift) await page.keyboard.up("Shift");
            if (input.ctrl) await page.keyboard.up("Control");

            await page.waitForTimeout(200);
            invalidateCache();

            return JSON.stringify({
                success: true,
                dragged: { from: { x: fx, y: fy }, to: { x: tx, y: ty } },
                modifiers,
            });
        } catch (err) {
            return JSON.stringify({ error: `Drag failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Scroll
// ═══════════════════════════════════════════════

export const browserScroll: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_scroll",
            description:
                "Scroll the page. Supports vertical, horizontal scrolling, and Ctrl+scroll for zooming (useful for Figma, maps, etc).",
            parameters: {
                type: "object",
                properties: {
                    direction: { type: "string", description: "'up', 'down', 'left', or 'right'" },
                    amount: { type: "number", description: "Pixels to scroll (default: 500)" },
                    x: { type: "number", description: "X position to scroll at (default: center)" },
                    y: { type: "number", description: "Y position to scroll at (default: center)" },
                    zoom: {
                        type: "boolean",
                        description: "Hold Ctrl while scrolling (zoom in/out for Figma, maps, etc)",
                    },
                },
                required: ["direction"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const amount = (input.amount as number) || 500;
            const x = (input.x as number) || 640;
            const y = (input.y as number) || 400;

            let deltaX = 0;
            let deltaY = 0;
            switch (input.direction) {
                case "up":
                    deltaY = -amount;
                    break;
                case "down":
                    deltaY = amount;
                    break;
                case "left":
                    deltaX = -amount;
                    break;
                case "right":
                    deltaX = amount;
                    break;
            }

            await agentCursor(page, { x, y }, "scroll");
            if (input.zoom) {
                await page.mouse.move(x, y);
                await page.keyboard.down("Control");
                await page.mouse.wheel(deltaX, deltaY);
                await page.keyboard.up("Control");
            } else {
                // Use page.mouse.wheel() — native CDP Input.dispatchMouseEvent.
                // Never throws ReferenceErrors unlike page.evaluate() with compiled lambdas.
                // Also correctly triggers virtual scroll lists (React, AG Grid, etc.)
                // and fires scroll event handlers that page.evaluate/scrollBy can miss.
                await page.mouse.move(x, y);
                await page.mouse.wheel(deltaX, deltaY);
                // Scroll direction indicator
                await page
                    .evaluate(
                        `(${SCROLL_INDICATOR_JS})(${JSON.stringify({ direction: input.direction, amount, x, y })})`,
                    )
                    .catch(() => {});
            }

            // Every stored position is stale now (and infinite feeds load more):
            // settle, then rescan so the returned labels match the scrolled page.
            await settleAfterAction(page, undefined);
            const newElementMap = await getInteractiveElements(page, true);
            setLastElementMap(newElementMap);

            return JSON.stringify({
                success: true,
                scrolled: input.direction,
                pixels: amount,
                zoom: !!input.zoom,
                interactive_elements_text: buildElementsText(),
            });
        } catch (err) {
            return JSON.stringify({ error: `Scroll failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Type text
// ═══════════════════════════════════════════════

export const browserType: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_type",
            description:
                "Type text. Either click a label/coordinate first, or just type at the currently focused element. Can also press special keys.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Text to type" },
                    label: {
                        type: "number",
                        description:
                            "Label number of the input field from the last browser_scan (optional, but PREFERRED over x/y)",
                    },
                    x: { type: "number", description: "X coordinate to click first (optional)" },
                    y: { type: "number", description: "Y coordinate to click first (optional)" },
                    press_enter: { type: "boolean", description: "Press Enter after typing" },
                    key: {
                        type: "string",
                        description:
                            "Press a special key instead of typing text (e.g. 'Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown')",
                    },
                    clear_first: {
                        type: "boolean",
                        description:
                            "Replace the field's content. Default: true for input/textarea fields; in rich editors (Docs, Notion, contenteditable) text goes in at the caret unless this is explicitly true.",
                    },
                    wait_after_ms: {
                        type: "number",
                        description: "Fixed wait after typing/pressing (default: wait until the page settles)",
                    },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const lastElementMap = getLastElementMap();

            // Click target if specified
            if (input.label !== undefined) {
                const el = lastElementMap.find((e) => e.label === (input.label as number));
                if (el) {
                    // Scrolled in first, so the cursor glides to where the click lands.
                    await Promise.resolve(el.handle?.scrollIntoViewIfNeeded?.({ timeout: 1000 })).catch(() => {});
                    await agentCursor(page, el.handle ?? el, "click");
                    if (el.handle) {
                        try {
                            await el.handle.focus({ timeout: 1000 }); // bounded: a stale aria-ref waits otherwise
                            await el.handle.click({ timeout: 2000 });
                        } catch {
                            await page.mouse.click(el.x, el.y);
                        }
                    } else {
                        await page.mouse.click(el.x, el.y);
                    }
                    await page.waitForTimeout(300);
                } else {
                    return JSON.stringify({
                        error: `Label ${input.label} not found. Run browser_scan to refresh elements.`,
                    });
                }
            } else if (input.x !== undefined && input.y !== undefined) {
                await agentCursor(page, { x: input.x as number, y: input.y as number }, "click");
                await page.mouse.click(input.x as number, input.y as number);
                await page.waitForTimeout(300);
            }

            // A saved secret (vault.ts) is typed only after its origin check, here, after the click above.
            const secret = !!vaultCall();
            if (secret && !input.text)
                return JSON.stringify({ error: "Type a saved secret as `text`, one field per call." });

            // Press special key
            if (input.key && !secret) {
                await page.keyboard.press(input.key as string);
            } else {
                if (input.text) {
                    await agentCursor(page, null, "type");
                    if (secret) {
                        // Replaced by default, as before (a vault field is a plain input).
                        const clear = input.clear_first !== false;
                        if (clear) {
                            await page.keyboard.press("ControlOrMeta+a");
                            await page.waitForTimeout(50);
                        }
                        const refused = await typeVaultText(page, input.text as string, clear);
                        if (refused) return JSON.stringify({ error: refused });
                    } else {
                        // Replace only a plain field's value by default: select-all in a
                        // Docs/Notion editor would select (and overwrite) the whole document.
                        const focus = await page.evaluate(FOCUS_KIND_JS).catch(() => "other");
                        // "unknown" (cross-origin iframe, closed shadow root): the old default, replace.
                        const clear =
                            input.clear_first === true ||
                            (input.clear_first !== false && (focus === "field" || focus === "unknown"));
                        if (getCurrentMode() === "chrome") {
                            // The extension types in one shot; it clears itself (synthetic Ctrl+A selects nothing).
                            await page.keyboard.type(input.text as string, { clear });
                        } else {
                            await typeHumanLike(page, input.text as string, clear);
                        }
                    }
                }
                if (input.press_enter) {
                    const urlBefore = page.url();
                    await page.keyboard.press("Enter");
                    // A navigation ends the wait as soon as it commits (Playwright only:
                    // the Chrome bridge proxy has no waitForURL). Then wait for the page
                    // — new or updated in place (SPA search) — to settle.
                    if (typeof (page as { waitForURL?: unknown }).waitForURL === "function") {
                        await page
                            .waitForURL((u: URL) => u.toString() !== urlBefore, { timeout: 1500 })
                            .catch(() => {});
                    }
                    await waitForPageReady(page);
                }
            }

            await settleAfterAction(page, input.wait_after_ms);
            const newElementMap = await getInteractiveElements(page);
            setLastElementMap(newElementMap);
            // The typed text is not echoed (it may hold a secret); its length is enough.
            return JSON.stringify({
                success: true,
                ...(input.key && !secret
                    ? { pressed: input.key }
                    : input.text
                      ? { typed_chars: String(input.text).length }
                      : {}),
                ...(!(input.key && !secret) && input.press_enter ? { pressed_enter: true } : {}),
                url: page.url(),
                ...takePageEvents(),
                interactive_elements_text: buildElementsText(),
            });
        } catch (err) {
            return JSON.stringify({ error: `Type failed: ${(err as Error).message}` });
        }
    },
};

// What has focus (through same-origin iframes and open shadow roots): a plain text
// field, a rich/contenteditable editor, other, or unknown (focus can't be inspected).
export const FOCUS_KIND_JS = `(() => {
  let a = document.activeElement;
  for (;;) {
    if (a && a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
    if (a && a.tagName === "IFRAME") {
      let d = null;
      try { d = a.contentDocument; } catch {}
      if (!d) return "unknown";
      a = d.activeElement;
      continue;
    }
    break;
  }
  if (!a) return "other";
  if (a.tagName.includes("-") && !a.shadowRoot && !a.isContentEditable) return "unknown";
  if (a.tagName === "TEXTAREA") return "field";
  if (a.tagName === "INPUT") return /^(text|search|email|url|tel|password|number)$/.test(a.type) ? "field" : "other";
  return a.isContentEditable ? "editable" : "other";
})()`;

/** Playwright typing with Rust-computed human-like per-character delays for the first few characters. */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page
async function typeHumanLike(page: any, text: string, clear: boolean): Promise<void> {
    if (clear) {
        await page.keyboard.press("ControlOrMeta+a"); // cross-platform; selects the field only
        await page.waitForTimeout(50);
    }
    // Rust humanTypingDelayMs gives realistic WPM-based delays per character
    // Fall back to 35ms uniform if native unavailable
    let delayFn: (charCode: number) => number;
    try {
        const { createRequire } = await import("node:module");
        const path = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const __d = path.default.dirname(fileURLToPath(import.meta.url));
        const req = createRequire(import.meta.url);
        const nm = req(path.default.resolve(__d, "../../../native/index.js")) as Record<string, unknown>;
        if (typeof nm.humanTypingDelayMs === "function") {
            const nativeFn = nm.humanTypingDelayMs as (c: number, wpm: number) => number;
            delayFn = (c) => nativeFn(c, 65); // ~65 WPM realistic
        } else {
            delayFn = () => 35;
        }
    } catch {
        delayFn = () => 35;
    }

    // Human rhythm for the first few characters only: per-character
    // delays on long text overran the tool timeout (~45+ chars) while
    // typing carried on in the background.
    const HUMAN_CHARS = 15;
    for (const ch of text.slice(0, HUMAN_CHARS)) {
        await page.keyboard.type(ch, { delay: 0 });
        const delay = delayFn(ch.charCodeAt(0));
        if (delay > 0) await page.waitForTimeout(delay);
    }
    if (text.length > HUMAN_CHARS) await page.keyboard.type(text.slice(HUMAN_CHARS), { delay: 10 });
}

// ═══════════════════════════════════════════════
// TOOL: Hover (move mouse without clicking)
// ═══════════════════════════════════════════════

export const browserHover: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_hover",
            description:
                "Move the mouse to x,y WITHOUT clicking to reveal hover menus, tooltips, dropdown panels, video player controls (e.g. YouTube — hover center of player to reveal mute/captions/seek bar), or highlight elements in Figma/design tools. Uses interpolated mouse movement (steps) to properly trigger CSS :hover transitions — essential for opacity-animated controls. After hover, optionally rescans page to return newly visible elements.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number", description: "X coordinate (0-1280)" },
                    y: { type: "number", description: "Y coordinate (0-800)" },
                    duration: {
                        type: "number",
                        description: "How long to dwell after hover in ms (default: 600 — enough for CSS transitions)",
                    },
                    steps: {
                        type: "number",
                        description:
                            "Interpolated mouse movement steps (default: 8). Higher = more intermediate mousemove events, better for CSS :hover transitions on video players and menus.",
                    },
                    wait_for: {
                        type: "string",
                        description:
                            "Optional CSS selector to wait for after hover (e.g. '.ytp-chrome-bottom', '.dropdown-menu'). Waits up to 3s for element to become visible.",
                    },
                    rescan: {
                        type: "boolean",
                        description:
                            "If true, rescans interactive elements after hover and returns newly visible ones (default: true). Use to see what the hover revealed.",
                    },
                },
                required: ["x", "y"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const x = input.x as number;
            const y = input.y as number;
            const duration = (input.duration as number) || 600;
            const steps = (input.steps as number) || 8;
            const waitFor = input.wait_for as string | undefined;
            const rescan = (input.rescan as boolean) !== false; // default true
            const url = page.url();

            // Derive session-scoped opaque names for our injected variables (IP protection)
            const varNodes = obfuscateInjectedVariable("__hoverAddedNodes");
            const varObserver = obfuscateInjectedVariable("__hoverObserver");

            // Check native hover hint — skip hover if we have a confident cached coordinate
            const hint = getHoverHint(url, waitFor ?? `${x},${y}`);
            const effectiveX = hint && hint.confidence > 0.7 ? hint.x : x;
            const effectiveY = hint && hint.confidence > 0.7 ? hint.y : y;

            // Inject MutationObserver using obfuscated variable names (IP protection)
            await page
                .evaluate(
                    /* javascript-obfuscator:disable */ ([nNodes, nObs]: string[]) => {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const w = window as any;
                        w[nNodes] = [];
                        w[nObs] = new MutationObserver((mutations: MutationRecord[]) => {
                            for (const m of mutations) {
                                m.addedNodes.forEach((node: Node) => {
                                    if (node.nodeType === 1) {
                                        const el = node as Element;
                                        w[nNodes].push({
                                            tag: el.tagName,
                                            className: el.className?.toString().substring(0, 80),
                                            id: el.id,
                                        });
                                    }
                                });
                            }
                        });
                        w[nObs].observe(document.body, { childList: true, subtree: true });
                    },
                    /* javascript-obfuscator:enable */ [varNodes, varObserver],
                )
                .catch(() => {}); // non-fatal

            // Interpolated mouse movement — Rust computes Fitts's-law steps for human-like motion
            let moveSteps = steps;
            let prePause = 0;
            try {
                const { createRequire } = await import("node:module");
                const path = await import("node:path");
                const { fileURLToPath } = await import("node:url");
                const __d = path.default.dirname(fileURLToPath(import.meta.url));
                const req = createRequire(import.meta.url);
                const nm = req(path.default.resolve(__d, "../../../native/index.js")) as Record<string, unknown>;
                if (typeof nm.humanMouseParams === "function") {
                    const fn = nm.humanMouseParams as (
                        sx: number,
                        sy: number,
                        ex: number,
                        ey: number,
                        seed: number,
                    ) => number[];
                    const params = fn(640, 400, effectiveX, effectiveY, Date.now() % 65536);
                    moveSteps = Math.max(steps, params[0] ?? steps);
                    prePause = params[1] ?? 0;
                }
            } catch {
                /* use input steps */
            }
            await agentCursor(page, { x: effectiveX, y: effectiveY }, "hover");
            if (prePause > 0) await page.waitForTimeout(Math.min(prePause, 200));
            await page.mouse.move(effectiveX, effectiveY, { steps: moveSteps });
            await page.waitForTimeout(duration);

            // Wait for a specific element to appear if requested
            let waitForResult = "";
            if (waitFor) {
                try {
                    await page.waitForFunction(
                        /* javascript-obfuscator:disable */ (sel: string) => {
                            const el = document.querySelector(sel);
                            if (!el) return false;
                            const style = window.getComputedStyle(el);
                            return (
                                style.display !== "none" &&
                                style.visibility !== "hidden" &&
                                parseFloat(style.opacity) > 0.1
                            );
                        },
                        /* javascript-obfuscator:enable */ waitFor,
                        { timeout: 3000, polling: 100 },
                    );
                    waitForResult = `"${waitFor}" is now visible`;
                } catch {
                    waitForResult = `"${waitFor}" did not appear within 3s`;
                }
            }

            // Collect what appeared after hover (using obfuscated variable names)
            const addedNodes = await page
                .evaluate(
                    /* javascript-obfuscator:disable */ ([nNodes, nObs]: string[]) => {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const w = window as any;
                        const nodes = (w[nNodes] || []) as Array<Record<string, string>>;
                        w[nObs]?.disconnect();
                        delete w[nNodes];
                        delete w[nObs];
                        return nodes;
                    },
                    /* javascript-obfuscator:enable */ [varNodes, varObserver],
                )
                .catch(() => []);

            // Record hover outcome for native cache
            if (waitFor) {
                const revealed = addedNodes.length > 0 || (waitFor && /* check visibility */ true);
                if (revealed) {
                    recordHoverSuccess(url, waitFor, effectiveX, effectiveY);
                } else {
                    recordHoverFailure(url, waitFor);
                }
            }
            recordBrowserAction("hover", url, waitFor ?? "", addedNodes.length > 0);

            // Rescan interactive elements to capture newly revealed controls
            let newElementsText = "";
            if (rescan) {
                const newElementMap = await getInteractiveElements(page, true); // force refresh
                setLastElementMap(newElementMap);
                newElementsText = buildElementsText();
            }

            return JSON.stringify({
                success: true,
                hovered_at: { x, y },
                duration_ms: duration,
                steps_used: steps,
                ...(waitFor ? { wait_for_result: waitForResult } : {}),
                dom_additions: addedNodes.length > 0 ? addedNodes.slice(0, 10) : "none",
                tip:
                    addedNodes.length > 0 || waitFor
                        ? "Elements revealed — use updated interactive_elements_text to click them."
                        : "No new elements detected. If controls are still hidden, try a longer duration or different coordinates.",
                ...(rescan ? { interactive_elements_text: newElementsText } : {}),
            });
        } catch (err) {
            return JSON.stringify({ error: `Hover failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Keyboard shortcuts / key combos
// ═══════════════════════════════════════════════

export const browserKeyboard: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_keyboard",
            description:
                "Press keyboard shortcuts and key combinations. Essential for complex UIs and video player control. YouTube shortcuts (player must be focused first by clicking it): 'k'=play/pause, 'm'=mute, 'c'=captions toggle, 'f'=fullscreen, 'j'=back 10s, 'l'=forward 10s, 'ArrowLeft'=back 5s, 'ArrowRight'=forward 5s, '0'-'9'=jump to 0-90%. Also: Ctrl+Z undo, Ctrl+C copy, Ctrl+V paste, Space+drag in Figma, Delete, Escape, arrow keys. Can also type raw text.",
            parameters: {
                type: "object",
                properties: {
                    combo: {
                        type: "string",
                        description:
                            "Key combination using '+' separator, e.g. 'Control+z', 'Control+Shift+z', 'Meta+c', 'Delete', 'Escape', 'Space', 'ArrowUp', 'Tab', 'F5'",
                    },
                    text: { type: "string", description: "Raw text to type (alternative to combo)" },
                    hold: {
                        type: "string",
                        description:
                            "Key to hold down (e.g. 'Space' for Figma hand tool). Call again with release to let go.",
                    },
                    release: { type: "string", description: "Key to release (previously held with 'hold')" },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();

            // A saved secret (vault.ts): text only, typed after its origin check.
            if (vaultCall()) {
                if (!input.text) return JSON.stringify({ error: "Type a saved secret as `text`, one field per call." });
                const refused = await typeVaultText(page, input.text as string);
                if (refused) return JSON.stringify({ error: refused });
                return JSON.stringify({ success: true, typed_chars: (input.text as string).length });
            }

            // Hold a key down
            if (input.hold) {
                await page.keyboard.down(input.hold as string);
                return JSON.stringify({ success: true, holding: input.hold });
            }

            // Release a held key
            if (input.release) {
                await page.keyboard.up(input.release as string);
                return JSON.stringify({ success: true, released: input.release });
            }

            // Type raw text
            if (input.text) {
                await page.keyboard.type(input.text as string, { delay: 30 });
                invalidateCache();
                return JSON.stringify({ success: true, typed_chars: (input.text as string).length });
            }

            // Key combo - e.g. "Control+Shift+z"
            // ControlOrMeta is resolved to Meta on macOS and Control on Windows/Linux
            // for cross-platform clipboard/undo operations.
            if (input.combo) {
                let combo = input.combo as string;
                // Normalize common shortcuts to cross-platform ControlOrMeta
                combo = combo.replace(/^Meta\+/i, "ControlOrMeta+").replace(/\+Meta\+/i, "+ControlOrMeta+");

                const keys = combo.split("+").map((k: string) => k.trim());
                const modifiers = keys.slice(0, -1);
                const key = keys[keys.length - 1];

                for (const mod of modifiers) await page.keyboard.down(mod);
                await page.keyboard.press(key);
                for (const mod of modifiers.reverse()) await page.keyboard.up(mod);

                // Enter submits forms / sends messages: let the page settle before reporting.
                if (key === "Enter") await waitForPageReady(page, 1500);
                else await page.waitForTimeout(150);
                invalidateCache();
                return JSON.stringify({ success: true, combo, url: page.url(), ...takePageEvents() });
            }

            return JSON.stringify({ error: "Provide 'combo', 'text', 'hold', or 'release'" });
        } catch (err) {
            return JSON.stringify({ error: `Keyboard failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Scroll element into view
// ═══════════════════════════════════════════════

export const browserScrollElement: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_scroll_element",
            description:
                "Scroll a specific element into view by its label number (from browser_scan). Use when elements are off-screen inside scrollable panels or nested containers. After scrolling, re-scan to get updated positions.",
            parameters: {
                type: "object",
                properties: {
                    label: { type: "number", description: "Element label number from browser_scan" },
                    block: {
                        type: "string",
                        description: "Vertical alignment: 'center' (default), 'start', 'end', 'nearest'",
                    },
                },
                required: ["label"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const lastElementMap = getLastElementMap();
            const el = lastElementMap.find((e) => e.label === (input.label as number));
            if (!el) {
                return JSON.stringify({ error: `Label ${input.label} not found. Run browser_scan first.` });
            }
            if (!el.handle) {
                return JSON.stringify({
                    error: `No DOM handle for label ${input.label}. Run browser_scan to refresh.`,
                });
            }

            const block = (input.block as string) || "center";
            await el.handle.evaluate(
                /* javascript-obfuscator:disable */ (node: HTMLElement, b: string) => {
                    node.scrollIntoView({ behavior: "smooth", block: b as ScrollLogicalPosition });
                },
                /* javascript-obfuscator:enable */ block,
                { timeout: 2000 }, // Locator handles wait for a gone element instead of failing
            );

            await settleAfterAction(page, undefined);

            const newElementMap = await getInteractiveElements(page);
            setLastElementMap(newElementMap);
            return JSON.stringify({
                success: true,
                scrolled_to_label: input.label,
                interactive_elements_text: buildElementsText(),
            });
        } catch (err) {
            return JSON.stringify({ error: `Scroll element failed: ${(err as Error).message}` });
        }
    },
};
