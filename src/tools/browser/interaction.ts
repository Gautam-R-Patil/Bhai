// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Interaction Tools ─────────────────
// Click, type, scroll, hover, drag, keyboard

import type { ToolDefinition } from "../get-current-time.js";
import {
    getBrowser,
    getActivePage,
    getInteractiveElements,
    waitForPageReady,
    setLastElementMap,
    getLastElementMap,
    buildElementsText,
    CLICK_INDICATOR_JS,
    setActivePageIndex,
    getActivePageIndex
} from "./core.js";
import {
    getHoverHint,
    recordHoverSuccess,
    recordHoverFailure,
    detectActionLoop,
    recordBrowserAction,
    obfuscateInjectedVariable,
} from "./native-browser.js";

// ═══════════════════════════════════════════════
// TOOL: Click at coordinates or label
// ═══════════════════════════════════════════════

export const browserClickAt: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_click_at",
            description: "Click an element by its label number (from browser_scan) or x,y coordinates. PREFER using 'label' for accurate clicks.",
            parameters: {
                type: "object",
                properties: {
                    label: { type: "number", description: "Element label number from the browser_scan text list (PREFERRED — most accurate)" },
                    x: { type: "number", description: "X coordinate (fallback if no label)" },
                    y: { type: "number", description: "Y coordinate (fallback if no label)" },
                    double_click: { type: "boolean", description: "Double click" },
                    ctrl: { type: "boolean", description: "Hold Ctrl/Cmd" },
                    shift: { type: "boolean", description: "Hold Shift" },
                    alt: { type: "boolean", description: "Hold Alt" },
                    meta: { type: "boolean", description: "Hold Meta/Cmd" },
                    wait_after_ms: { type: "number", description: "How long to wait after clicking (default: 1000)" },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const context = await getBrowser();
            const page = await getActivePage();
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
                const el = lastElementMap.find(e => e.label === labelNum);
                if (!el) {
                    return JSON.stringify({ error: `Label ${input.label} not found. Run browser_scan to refresh element labels.` });
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

            const modifiers: string[] = [];
            if (input.ctrl) { await page.keyboard.down("Control"); modifiers.push("Ctrl"); }
            if (input.shift) { await page.keyboard.down("Shift"); modifiers.push("Shift"); }
            if (input.alt) { await page.keyboard.down("Alt"); modifiers.push("Alt"); }
            if (input.meta) { await page.keyboard.down("Meta"); modifiers.push("Meta"); }

            let executionMethod = "coordinates";
            const initialUrl = page.url();

            // Try to auto-recover from unexpected overlays blocking the click
            const attemptRecovery = async () => {
                console.log("Attempting error recovery: Dismissing active modal/overlay");
                await page.keyboard.press('Escape');
                await page.waitForTimeout(300);
            };

            if (handle) {
                try {
                    // Hybrid Action: Try to use the native DOM handle first for maximum stability
                    await handle.scrollIntoViewIfNeeded();

                    if (input.double_click) {
                        await handle.dblclick({ timeout: 2000 });
                    } else {
                        await handle.click({ timeout: 2000 });
                    }
                    executionMethod = "element_handle";
                    await page.evaluate(CLICK_INDICATOR_JS, { x, y, type: "click" });
                } catch (handleErr) {
                    const errMsg = (handleErr as Error).message;
                    if (errMsg.includes('intercepts pointer events') || errMsg.includes('overlay')) {
                        await attemptRecovery();
                        try {
                            // Retry once after recovery
                            if (input.double_click) {
                                await handle.dblclick({ timeout: 2000 });
                            } else {
                                await handle.click({ timeout: 2000 });
                            }
                            executionMethod = "element_handle_recovered";
                            await page.evaluate(CLICK_INDICATOR_JS, { x, y, type: "click" });
                        } catch {
                            executionMethod = "coordinates_fallback";
                            await page.evaluate(CLICK_INDICATOR_JS, { x, y, type: "click" });
                            await page.waitForTimeout(150);
                            await (input.double_click ? page.mouse.dblclick(x, y) : page.mouse.click(x, y));
                        }
                    } else if (errMsg.includes('detached') || errMsg.includes('not visible')) {
                        return JSON.stringify({
                            error: `Target option vanished or detached. The dropdown or modal may have closed unexpectedly before the click triggered. Re-click the dropdown to open it before trying again.`,
                            raw_error: errMsg
                        });
                    } else {
                        executionMethod = "coordinates_fallback";
                        await page.evaluate(CLICK_INDICATOR_JS, { x, y, type: "click" });
                        await page.waitForTimeout(150);
                        await (input.double_click ? page.mouse.dblclick(x, y) : page.mouse.click(x, y));
                    }
                }
            } else {
                // Pure coordinate fallback
                await page.evaluate(CLICK_INDICATOR_JS, { x, y, type: "click" });
                await page.waitForTimeout(150);
                if (input.double_click) {
                    await page.mouse.dblclick(x, y);
                } else {
                    await page.mouse.click(x, y);
                }
            }

            if (input.meta) await page.keyboard.up("Meta");
            if (input.alt) await page.keyboard.up("Alt");
            if (input.shift) await page.keyboard.up("Shift");
            if (input.ctrl) await page.keyboard.up("Control");

            const waitTime = input.wait_after_ms !== undefined ? (input.wait_after_ms as number) : 300;
            if (waitTime > 0) await page.waitForTimeout(waitTime);

            // ── Unexpected new-tab guard ──
            const allPages = context.pages();
            const tabCountAfter = allPages.length;
            if (tabCountAfter > tabCountBefore) {
                console.log(`  ⚠️ Unexpected new tab detected (${tabCountBefore} → ${tabCountAfter}). Auto-closing and returning to original tab.`);
                for (let i = tabCountAfter - 1; i >= tabCountBefore; i--) {
                    try { await allPages[i].close(); } catch { /* already closed */ }
                }
                const intendedPages = context.pages();
                const activePageIndex = getActivePageIndex();
                const safeIdx = Math.min(activePageIndex, intendedPages.length - 1);
                await intendedPages[safeIdx].bringToFront();

                const newElementMap = await getInteractiveElements(intendedPages[safeIdx]);
                setLastElementMap(newElementMap);
                const serializedRecovery = newElementMap.map(e => ({
                    label: e.label, x: e.x, y: e.y, tag: e.tag, text: e.text
                }));
                const recoveryElements = serializedRecovery.length > 0
                    ? serializedRecovery.map(e => `[${e.label}] ${e.tag} '${e.text}'`).join('\n')
                    : "No interactive elements detected.";

                return JSON.stringify({
                    warning: "UNEXPECTED_NEW_TAB_AUTO_CLOSED",
                    action_taken: `A new tab was opened by the click (likely a link instead of a button). The new tab has been automatically closed. You are back on the original form page.`,
                    instruction: "DO NOT restart the task or navigate back to the beginning. Simply re-scan the current page and click the CORRECT primary action button (look for a <button> tag labeled 'Next', 'Continue', or similar, NOT an <a> link).",
                    title: await intendedPages[safeIdx].title(),
                    url: intendedPages[safeIdx].url(),
                    open_tabs: context.pages().length,
                    interactive_elements_text: recoveryElements,
                });
            }

            // State Verifier
            const finalUrl = page.url();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const stateTransitions: any = {};
            if (initialUrl !== finalUrl) {
                stateTransitions.navigation = `Navigated from ${initialUrl} to ${finalUrl}`;
                await waitForPageReady(page);
            }

            // Generate condensed DOM text of updated elements
            const newElementMap = await getInteractiveElements(page);
            setLastElementMap(newElementMap);
            const serializedElements = newElementMap.map(e => ({
                label: e.label, x: e.x, y: e.y, tag: e.tag, text: e.text
            }));

            let interactive_elements_text = "No interactive elements detected.";
            if (serializedElements.length > 0) {
                interactive_elements_text = serializedElements.map(e => `[${e.label}] ${e.tag} '${e.text}'`).join('\n');
            }

            // Record success for native loop/rate tracker
            recordBrowserAction("click", page.url(), String(input.label ?? `${x},${y}`), true);

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
                interactive_elements_text
            });
        } catch (err) {
            // Record failure for loop detection
            try {
                const pg = await getActivePage();
                const clickTarget = String(input.label ?? `${input.x},${input.y}`);
                recordBrowserAction("click", pg.url(), clickTarget, false);
            } catch { /* non-fatal */ }
            return JSON.stringify({ error: `Click failed: ${(err as Error).message}` });
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
            description: "Click an element by CSS selector or visible text. If this fails, use browser_click_at with coordinates instead.",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "CSS selector" },
                    text: { type: "string", description: "Visible text to click" },
                    wait_after_ms: { type: "number", description: "How long to wait after clicking (default: 1500)" },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();

            if (input.text) {
                const el = page.getByText(input.text as string, { exact: false }).first();
                const box = await el.boundingBox().catch(() => null);
                if (box) {
                    const cx = box.x + box.width / 2;
                    const cy = box.y + box.height / 2;
                    await page.evaluate(CLICK_INDICATOR_JS, { x: cx, y: cy, type: "click" });
                    await page.mouse.click(cx, cy);
                } else {
                    return JSON.stringify({ error: `Text "${input.text}" not found on visible page. Use browser_scan to see elements, then browser_click_at with label.` });
                }
            } else if (input.selector) {
                const el = page.locator(input.selector as string).first();
                const box = await el.boundingBox().catch(() => null);
                if (box) {
                    const cx = box.x + box.width / 2;
                    const cy = box.y + box.height / 2;
                    await page.evaluate(CLICK_INDICATOR_JS, { x: cx, y: cy, type: "click" });
                    await page.mouse.click(cx, cy);
                } else {
                    return JSON.stringify({ error: `Selector "${input.selector}" not found. Use browser_scan to see elements, then browser_click_at with label.` });
                }
            } else {
                return JSON.stringify({ error: "Provide 'selector' or 'text'" });
            }

            const waitTime = input.wait_after_ms !== undefined ? (input.wait_after_ms as number) : 500;
            if (waitTime > 0) await page.waitForTimeout(waitTime);
            const newElementMap = await getInteractiveElements(page);
            setLastElementMap(newElementMap);
            return JSON.stringify({ success: true, clicked: input.selector || input.text, title: await page.title(), url: page.url(), interactive_elements_text: buildElementsText() });
        } catch (err) {
            return JSON.stringify({ error: `Click failed: ${(err as Error).message}. Use browser_scan + browser_click_at with label instead.` });
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

            await page.evaluate(CLICK_INDICATOR_JS, { x, y, type: "right" });
            await page.waitForTimeout(200);
            await page.mouse.click(x, y, { button: "right" });
            await page.waitForTimeout(200);

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

            await page.evaluate(CLICK_INDICATOR_JS, { x, y, type: "hold" });
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.waitForTimeout(duration);
            await page.mouse.up();

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
                    steps: { type: "number", description: "Number of intermediate steps (default: 10, higher is smoother)" },
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
            if (input.ctrl) { await page.keyboard.down("Control"); modifiers.push("Ctrl"); }
            if (input.shift) { await page.keyboard.down("Shift"); modifiers.push("Shift"); }
            if (input.alt) { await page.keyboard.down("Alt"); modifiers.push("Alt"); }
            if (input.meta) { await page.keyboard.down("Meta"); modifiers.push("Meta"); }

            await page.evaluate(CLICK_INDICATOR_JS, { x: fx, y: fy, type: "hold" });
            await page.mouse.move(fx, fy);
            await page.mouse.down();
            await page.mouse.move(tx, ty, { steps });
            await page.evaluate(CLICK_INDICATOR_JS, { x: tx, y: ty, type: "click" });
            await page.mouse.up();

            if (input.meta) await page.keyboard.up("Meta");
            if (input.alt) await page.keyboard.up("Alt");
            if (input.shift) await page.keyboard.up("Shift");
            if (input.ctrl) await page.keyboard.up("Control");

            await page.waitForTimeout(200);

            return JSON.stringify({ success: true, dragged: { from: { x: fx, y: fy }, to: { x: tx, y: ty } }, modifiers });
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
            description: "Scroll the page. Supports vertical, horizontal scrolling, and Ctrl+scroll for zooming (useful for Figma, maps, etc).",
            parameters: {
                type: "object",
                properties: {
                    direction: { type: "string", description: "'up', 'down', 'left', or 'right'" },
                    amount: { type: "number", description: "Pixels to scroll (default: 500)" },
                    x: { type: "number", description: "X position to scroll at (default: center)" },
                    y: { type: "number", description: "Y position to scroll at (default: center)" },
                    zoom: { type: "boolean", description: "Hold Ctrl while scrolling (zoom in/out for Figma, maps, etc)" },
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
                case "up": deltaY = -amount; break;
                case "down": deltaY = amount; break;
                case "left": deltaX = -amount; break;
                case "right": deltaX = amount; break;
            }

            if (input.zoom) {
                await page.mouse.move(x, y);
                await page.keyboard.down("Control");
                await page.mouse.wheel(deltaX, deltaY);
                await page.keyboard.up("Control");
            } else {
                // Smart scroll: find the scrollable container at the cursor position
                await page.evaluate(({ dx, dy, cx, cy }: { dx: number, dy: number, cx: number, cy: number }) => {
                    let el = document.elementFromPoint(cx, cy) as HTMLElement | null;
                    while (el && el !== document.documentElement) {
                        const style = window.getComputedStyle(el);
                        const overflowY = style.overflowY;
                        const overflowX = style.overflowX;
                        const isScrollableY = (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
                        const isScrollableX = (overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth;
                        if ((dy !== 0 && isScrollableY) || (dx !== 0 && isScrollableX)) {
                            el.scrollBy({ left: dx, top: dy, behavior: "smooth" });
                            return;
                        }
                        el = el.parentElement;
                    }
                    window.scrollBy({ left: dx, top: dy, behavior: "smooth" });
                }, { dx: deltaX, dy: deltaY, cx: x, cy: y });
            }

            await page.waitForTimeout(300);

            return JSON.stringify({ success: true, scrolled: input.direction, pixels: amount, zoom: !!input.zoom });
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
            description: "Type text. Either click a label/coordinate first, or just type at the currently focused element. Can also press special keys.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Text to type" },
                    label: { type: "number", description: "Label number of the input field from the last browser_scan (optional, but PREFERRED over x/y)" },
                    x: { type: "number", description: "X coordinate to click first (optional)" },
                    y: { type: "number", description: "Y coordinate to click first (optional)" },
                    press_enter: { type: "boolean", description: "Press Enter after typing" },
                    key: { type: "string", description: "Press a special key instead of typing text (e.g. 'Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown')" },
                    clear_first: { type: "boolean", description: "Clear the field before typing (default: true)" },
                    wait_after_ms: { type: "number", description: "How long to wait after typing/pressing (default: 500)" },
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
                const el = lastElementMap.find(e => e.label === (input.label as number));
                if (el) {
                    if (el.handle) {
                        try {
                            await el.handle.focus();
                            await el.handle.click();
                        } catch {
                            await page.mouse.click(el.x, el.y);
                        }
                    } else {
                        await page.mouse.click(el.x, el.y);
                    }
                    await page.evaluate(CLICK_INDICATOR_JS, { x: el.x, y: el.y, type: "click" });
                    await page.waitForTimeout(300);
                } else {
                    return JSON.stringify({ error: `Label ${input.label} not found. Run browser_scan to refresh elements.` });
                }
            } else if (input.x !== undefined && input.y !== undefined) {
                await page.evaluate(CLICK_INDICATOR_JS, { x: input.x as number, y: input.y as number, type: "click" });
                await page.mouse.click(input.x as number, input.y as number);
                await page.waitForTimeout(300);
            }

            // Press special key
            if (input.key) {
                await page.keyboard.press(input.key as string);
                await page.waitForTimeout(500);
                return JSON.stringify({ success: true, pressed: input.key });
            }

            // Type text
            if (input.text) {
                if (input.clear_first !== false) {
                    await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
                    await page.waitForTimeout(50);
                }
                await page.keyboard.type(input.text as string, { delay: 30 });
            }

            if (input.press_enter) {
                const urlBefore = page.url();
                await page.keyboard.press("Enter");
                await page.waitForTimeout(1500);
                if (page.url() !== urlBefore) {
                    await waitForPageReady(page);
                }
            }

            const waitTime = input.wait_after_ms !== undefined ? (input.wait_after_ms as number) : 200;
            if (waitTime > 0) await page.waitForTimeout(waitTime);
            const newElementMap = await getInteractiveElements(page);
            setLastElementMap(newElementMap);
            return JSON.stringify({ success: true, typed: input.text || input.key, url: page.url(), interactive_elements_text: buildElementsText() });
        } catch (err) {
            return JSON.stringify({ error: `Type failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Hover (move mouse without clicking)
// ═══════════════════════════════════════════════

export const browserHover: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_hover",
            description: "Move the mouse to x,y WITHOUT clicking to reveal hover menus, tooltips, dropdown panels, video player controls (e.g. YouTube — hover center of player to reveal mute/captions/seek bar), or highlight elements in Figma/design tools. Uses interpolated mouse movement (steps) to properly trigger CSS :hover transitions — essential for opacity-animated controls. After hover, optionally rescans page to return newly visible elements.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number", description: "X coordinate (0-1280)" },
                    y: { type: "number", description: "Y coordinate (0-800)" },
                    duration: { type: "number", description: "How long to dwell after hover in ms (default: 600 — enough for CSS transitions)" },
                    steps: { type: "number", description: "Interpolated mouse movement steps (default: 8). Higher = more intermediate mousemove events, better for CSS :hover transitions on video players and menus." },
                    wait_for: { type: "string", description: "Optional CSS selector to wait for after hover (e.g. '.ytp-chrome-bottom', '.dropdown-menu'). Waits up to 3s for element to become visible." },
                    rescan: { type: "boolean", description: "If true, rescans interactive elements after hover and returns newly visible ones (default: true). Use to see what the hover revealed." },
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
            const effectiveX = (hint && hint.confidence > 0.7) ? hint.x : x;
            const effectiveY = (hint && hint.confidence > 0.7) ? hint.y : y;

            // Inject MutationObserver using obfuscated variable names (IP protection)
            await page.evaluate(([nNodes, nObs]: string[]) => {
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
                                    id: el.id
                                });
                            }
                        });
                    }
                });
                w[nObs].observe(document.body, { childList: true, subtree: true });
            }, [varNodes, varObserver]).catch(() => {}); // non-fatal

            // Interpolated mouse movement — critical for CSS :hover transitions
            await page.mouse.move(effectiveX, effectiveY, { steps });
            await page.waitForTimeout(duration);

            // Wait for a specific element to appear if requested
            let waitForResult = '';
            if (waitFor) {
                try {
                    await page.waitForFunction(
                        (sel: string) => {
                            const el = document.querySelector(sel);
                            if (!el) return false;
                            const style = window.getComputedStyle(el);
                            return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0.1;
                        },
                        waitFor,
                        { timeout: 3000, polling: 100 }
                    );
                    waitForResult = `"${waitFor}" is now visible`;
                } catch {
                    waitForResult = `"${waitFor}" did not appear within 3s`;
                }
            }

            // Collect what appeared after hover (using obfuscated variable names)
            const addedNodes = await page.evaluate(([nNodes, nObs]: string[]) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const w = window as any;
                const nodes = (w[nNodes] || []) as Array<Record<string, string>>;
                w[nObs]?.disconnect();
                delete w[nNodes];
                delete w[nObs];
                return nodes;
            }, [varNodes, varObserver]).catch(() => []);

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
            let newElementsText = '';
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
                dom_additions: addedNodes.length > 0 ? addedNodes.slice(0, 10) : 'none',
                ...(rescan ? { interactive_elements_text: newElementsText } : {}),
                tip: addedNodes.length > 0 || waitFor ? "Elements revealed — use updated interactive_elements_text to click them." : "No new elements detected. If controls are still hidden, try a longer duration or different coordinates."
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
            description: "Press keyboard shortcuts and key combinations. Essential for complex UIs and video player control. YouTube shortcuts (player must be focused first by clicking it): 'k'=play/pause, 'm'=mute, 'c'=captions toggle, 'f'=fullscreen, 'j'=back 10s, 'l'=forward 10s, 'ArrowLeft'=back 5s, 'ArrowRight'=forward 5s, '0'-'9'=jump to 0-90%. Also: Ctrl+Z undo, Ctrl+C copy, Ctrl+V paste, Space+drag in Figma, Delete, Escape, arrow keys. Can also type raw text.",
            parameters: {
                type: "object",
                properties: {
                    combo: { type: "string", description: "Key combination using '+' separator, e.g. 'Control+z', 'Control+Shift+z', 'Meta+c', 'Delete', 'Escape', 'Space', 'ArrowUp', 'Tab', 'F5'" },
                    text: { type: "string", description: "Raw text to type (alternative to combo)" },
                    hold: { type: "string", description: "Key to hold down (e.g. 'Space' for Figma hand tool). Call again with release to let go." },
                    release: { type: "string", description: "Key to release (previously held with 'hold')" },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();

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
                return JSON.stringify({ success: true, typed: (input.text as string).substring(0, 50) });
            }

            // Key combo - e.g. "Control+Shift+z"
            if (input.combo) {
                const keys = (input.combo as string).split("+").map((k: string) => k.trim());
                const modifiers = keys.slice(0, -1);
                const key = keys[keys.length - 1];

                for (const mod of modifiers) await page.keyboard.down(mod);
                await page.keyboard.press(key);
                for (const mod of modifiers.reverse()) await page.keyboard.up(mod);

                await page.waitForTimeout(150);
                return JSON.stringify({ success: true, combo: input.combo });
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
            description: "Scroll a specific element into view by its label number (from browser_scan). Use when elements are off-screen inside scrollable panels or nested containers. After scrolling, re-scan to get updated positions.",
            parameters: {
                type: "object",
                properties: {
                    label: { type: "number", description: "Element label number from browser_scan" },
                    block: { type: "string", description: "Vertical alignment: 'center' (default), 'start', 'end', 'nearest'" },
                },
                required: ["label"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const lastElementMap = getLastElementMap();
            const el = lastElementMap.find(e => e.label === (input.label as number));
            if (!el) {
                return JSON.stringify({ error: `Label ${input.label} not found. Run browser_scan first.` });
            }
            if (!el.handle) {
                return JSON.stringify({ error: `No DOM handle for label ${input.label}. Run browser_scan to refresh.` });
            }

            const block = (input.block as string) || 'center';
            await el.handle.evaluate((node: HTMLElement, b: string) => {
                node.scrollIntoView({ behavior: 'smooth', block: b as ScrollLogicalPosition });
            }, block);

            await page.waitForTimeout(300);

            const newElementMap = await getInteractiveElements(page);
            setLastElementMap(newElementMap);
            return JSON.stringify({
                success: true,
                scrolled_to_label: input.label,
                interactive_elements_text: buildElementsText()
            });
        } catch (err) {
            return JSON.stringify({ error: `Scroll element failed: ${(err as Error).message}` });
        }
    },
};
