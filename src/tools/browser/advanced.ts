// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Advanced Tools ───────────────────────
// Parallel tabs, parallel actions, multi-action batch operations

import { getResourceLimits } from "../../utils/system-resources.js";
import type { ToolDefinition } from "../get-current-time.js";
import { agentCursor, withAgentUIHidden } from "./agent-cursor.js";
import {
    buildElementsText,
    getActivePage,
    getBrowser,
    getInteractiveElements,
    getLastElementMap,
    invalidateCache,
    setActivePageIndex,
    setLastElementMap,
    waitForPageReady,
} from "./core.js";
import { signBrowserAction, validateJsCode } from "./native-browser.js";
import { vaultTaintError } from "./vault-typing.js";

// ═══════════════════════════════════════════════
// TOOL: Parallel Tab Execution
// ═══════════════════════════════════════════════

export const browserParallelTabs: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_parallel_tabs",
            description:
                "Execute actions across MULTIPLE tabs simultaneously for faster task completion. Each tab runs its own action in parallel, then waits for all to complete. Perfect for: opening multiple URLs at once, filling out similar forms, comparing pages side-by-side, or scraping multiple sources.",
            parameters: {
                type: "object",
                properties: {
                    tab_actions: {
                        type: "array",
                        description:
                            "Array of actions to run in parallel across tabs. Each action runs in its own tab.",
                        items: {
                            type: "object",
                            properties: {
                                tab_index: {
                                    type: "number",
                                    description:
                                        "Existing tab index to use (optional — creates new tab if not specified)",
                                },
                                url: { type: "string", description: "Navigate to this URL" },
                                actions: {
                                    type: "array",
                                    description: "Sequential actions to perform in this tab after navigation",
                                    items: {
                                        type: "object",
                                        properties: {
                                            action: {
                                                type: "string",
                                                description: "'click', 'type', 'wait', 'scroll', 'extract'",
                                            },
                                            selector: { type: "string" },
                                            text: { type: "string" },
                                            label: { type: "number" },
                                            x: { type: "number" },
                                            y: { type: "number" },
                                            wait_ms: { type: "number" },
                                            extract_selector: {
                                                type: "string",
                                                description: "CSS selector to extract text from",
                                            },
                                        },
                                        required: ["action"],
                                    },
                                },
                                extract_text: {
                                    type: "boolean",
                                    description: "Return page text content from this tab",
                                },
                                extract_selector: {
                                    type: "string",
                                    description: "CSS selector to extract specific content",
                                },
                            },
                            required: [],
                        },
                    },
                    close_new_tabs: {
                        type: "boolean",
                        description: "Close newly opened tabs after extraction (default: false)",
                    },
                    timeout_ms: { type: "number", description: "Timeout per tab in milliseconds (default: 30000)" },
                },
                required: ["tab_actions"],
            },
        },
    },
    async handler(input) {
        try {
            const context = await getBrowser();
            const tabActions = input.tab_actions as Array<Record<string, unknown>>;
            const timeout = (input.timeout_ms as number) || 30000;
            const closeNewTabs = (input.close_new_tabs as boolean) || false;

            // ── Resource-aware concurrency ────────────
            const { maxParallelTabs, reason: resourceInfo } = getResourceLimits();
            const existingTabCount = context.pages().length;

            console.log(
                `  🔀 Parallel tabs: ${tabActions.length} requested, system limit: ${maxParallelTabs} (${resourceInfo})`,
            );

            const allResults: Array<{
                tab_index: number;
                url: string;
                title: string;
                success: boolean;
                extracted?: string;
                error?: string;
            }> = [];

            // Process in batches of maxParallelTabs
            const totalBatches = Math.ceil(tabActions.length / maxParallelTabs);
            for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
                const batch = tabActions.slice(batchIdx * maxParallelTabs, (batchIdx + 1) * maxParallelTabs);
                if (totalBatches > 1) {
                    console.log(`  🔀 Batch ${batchIdx + 1}/${totalBatches}: processing ${batch.length} tabs`);
                }

                const batchPromises = batch.map(async (tabAction) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    let page: any;
                    let isNewTab = false;

                    // Get or create tab
                    if (tabAction.tab_index !== undefined) {
                        const pages = context.pages();
                        const idx = tabAction.tab_index as number;
                        if (idx >= 0 && idx < pages.length) {
                            page = pages[idx];
                        } else {
                            page = await context.newPage();
                            isNewTab = true;
                        }
                    } else {
                        page = await context.newPage();
                        isNewTab = true;
                    }

                    try {
                        // Navigate if URL provided
                        if (tabAction.url) {
                            await page
                                .goto(tabAction.url as string, {
                                    waitUntil: "domcontentloaded",
                                    timeout,
                                })
                                .catch(() => null);
                            await waitForPageReady(page, 2000);
                        }

                        // Execute sequential actions within this tab
                        if (tabAction.actions) {
                            const actions = tabAction.actions as Array<Record<string, unknown>>;
                            for (const act of actions) {
                                switch (act.action) {
                                    case "click": {
                                        let cx, cy;
                                        if (act.selector) {
                                            const el = page.locator(act.selector as string).first();
                                            const box = await el.boundingBox().catch(() => null);
                                            if (box) {
                                                cx = box.x + box.width / 2;
                                                cy = box.y + box.height / 2;
                                            }
                                        } else if (act.x !== undefined && act.y !== undefined) {
                                            cx = act.x as number;
                                            cy = act.y as number;
                                        }
                                        if (cx !== undefined && cy !== undefined) {
                                            await page.mouse.click(cx, cy);
                                            await page.waitForTimeout(500);
                                        }
                                        break;
                                    }
                                    case "type": {
                                        if (act.selector) {
                                            const el = page.locator(act.selector as string).first();
                                            try {
                                                await el.click();
                                            } catch {
                                                /* ignore */
                                            }
                                        }
                                        if (act.text) {
                                            await page.keyboard.type(act.text as string, { delay: 30 });
                                        }
                                        break;
                                    }
                                    case "wait": {
                                        const ms = (act.wait_ms as number) || 1000;
                                        await page.waitForTimeout(ms);
                                        break;
                                    }
                                    case "scroll": {
                                        await page.mouse.wheel(0, 500);
                                        await page.waitForTimeout(300);
                                        break;
                                    }
                                    case "extract": {
                                        // Handled below
                                        break;
                                    }
                                }
                            }
                        }

                        // Extract content
                        let extracted: string | undefined;
                        if (tabAction.extract_text) {
                            extracted = await page.evaluate(
                                /* javascript-obfuscator:disable */ () => document.body.innerText.substring(0, 5000),
                                /* javascript-obfuscator:enable */ undefined,
                            );
                        } else if (tabAction.extract_selector) {
                            const _sel = (tabAction.extract_selector as string).replace(/`/g, "\\`");
                            const els = (await page
                                .evaluate(
                                    `Array.from(document.querySelectorAll(\`${_sel}\`)).slice(0,50).map(e=>e.textContent?.trim())`,
                                )
                                .catch(() => [])) as string[];
                            extracted = els.join("\n");
                        }

                        const tabIndex = context.pages().indexOf(page);
                        return {
                            tab_index: tabIndex,
                            url: page.url(),
                            title: await page.title(),
                            success: true,
                            extracted,
                            isNewTab,
                        };
                    } catch (err) {
                        const tabIndex = context.pages().indexOf(page);
                        return {
                            tab_index: tabIndex,
                            url: page.url(),
                            title: "",
                            success: false,
                            error: (err as Error).message,
                            isNewTab,
                        };
                    }
                });

                // Wait for this batch to complete before starting next
                const batchResults = await Promise.all(batchPromises);
                for (const result of batchResults) {
                    allResults.push({
                        tab_index: result.tab_index,
                        url: result.url,
                        title: result.title,
                        success: result.success,
                        extracted: result.extracted,
                        error: result.error,
                    });
                }
            }

            // Close new tabs if requested
            if (closeNewTabs) {
                const allPages = context.pages();
                for (let i = allPages.length - 1; i >= existingTabCount; i--) {
                    try {
                        await allPages[i].close();
                    } catch {
                        /* ignore */
                    }
                }
            }

            // Reset browser state so next browser_scan gets fresh data
            const pages = context.pages();
            if (pages.length > 0) {
                setActivePageIndex(0);
                invalidateCache();
            }

            const successCount = allResults.filter((r) => r.success).length;
            const totalTabs = context.pages().length;

            return JSON.stringify({
                success: true,
                resource_info: resourceInfo,
                batched: totalBatches > 1,
                total_batches: totalBatches,
                total_tabs_processed: tabActions.length,
                successful: successCount,
                failed: tabActions.length - successCount,
                current_tab_count: totalTabs,
                results: allResults,
                tip: "Use browser_switch_tab to navigate between tabs, or close_new_tabs:true to auto-cleanup.",
            });
        } catch (err) {
            return JSON.stringify({ error: `Parallel tabs failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Parallel Actions (concurrent operations on same page)
// ═══════════════════════════════════════════════

export const browserParallelActions: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_parallel_actions",
            description:
                "Execute INDEPENDENT actions concurrently on the same page for speed. Unlike browser_multi_action (sequential), this runs multiple operations at once. Best for: extracting multiple pieces of data, prefetching resources, or running independent JS evaluations.",
            parameters: {
                type: "object",
                properties: {
                    actions: {
                        type: "array",
                        description: "Array of independent actions to run concurrently",
                        items: {
                            type: "object",
                            properties: {
                                id: { type: "string", description: "Identifier for this action's result" },
                                type: {
                                    type: "string",
                                    description: "'extract', 'evaluate', 'screenshot_region', 'wait_selector'",
                                },
                                selector: { type: "string", description: "CSS selector for extract/wait_selector" },
                                code: { type: "string", description: "JavaScript code for evaluate" },
                                region: {
                                    type: "object",
                                    description: "Clip region for screenshot_region",
                                    properties: {
                                        x: { type: "number" },
                                        y: { type: "number" },
                                        width: { type: "number" },
                                        height: { type: "number" },
                                    },
                                },
                                timeout_ms: { type: "number", description: "Timeout for this specific action" },
                            },
                            required: ["id", "type"],
                        },
                    },
                },
                required: ["actions"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            // Handle both JSON string and array inputs (LLMs sometimes pass a JSON string)
            let parsedParallelActions = input.actions;
            if (typeof parsedParallelActions === "string") {
                try {
                    parsedParallelActions = JSON.parse(parsedParallelActions);
                } catch {
                    return JSON.stringify({ success: false, error: "Invalid actions JSON string" });
                }
            }
            const actions = parsedParallelActions as Array<Record<string, unknown>>;

            // Run all actions in parallel
            const parallelPromises = actions.map(async (action) => {
                const id = action.id as string;
                const timeout = (action.timeout_ms as number) || 10000;

                try {
                    switch (action.type) {
                        case "extract": {
                            const sel = action.selector as string;
                            const elements = await page
                                .evaluate(
                                    /* javascript-obfuscator:disable */ ({ s }: { s: string }) =>
                                        Array.from(document.querySelectorAll(s))
                                            .slice(0, 30)
                                            .map((e) => ({
                                                text: (e as HTMLElement).textContent?.trim().substring(0, 200),
                                                href: e.getAttribute("href"),
                                            })),
                                    /* javascript-obfuscator:enable */ { s: sel },
                                )
                                .catch(() => []);
                            return { id, success: true, data: elements };
                        }

                        case "evaluate": {
                            const code = action.code as string;
                            const tainted = await vaultTaintError(page);
                            if (tainted) return { id, success: false, error: tainted };
                            let safeCode: string;
                            try {
                                safeCode = validateJsCode(code);
                            } catch (e) {
                                return { id, success: false, error: `ip_guard: ${(e as Error).message}` };
                            }
                            const wrappedCode = `(async () => { ${safeCode} })()`;
                            const result = await page.evaluate(wrappedCode);
                            return { id, success: true, data: result };
                        }

                        case "screenshot_region": {
                            const region = action.region as { x: number; y: number; width: number; height: number };
                            if (region) {
                                const buffer = await withAgentUIHidden(page, () =>
                                    page.screenshot({ type: "jpeg", quality: 60, clip: region }),
                                );
                                return {
                                    id,
                                    success: true,
                                    data: buffer.toString("base64").substring(0, 1000) + "...",
                                };
                            }
                            return { id, success: false, error: "No region specified" };
                        }

                        case "wait_selector": {
                            const selector = action.selector as string;
                            await page.waitForSelector(selector, { timeout });
                            return { id, success: true, data: `Selector ${selector} found` };
                        }

                        default:
                            return { id, success: false, error: `Unknown action type: ${action.type}` };
                    }
                } catch (err) {
                    return { id, success: false, error: (err as Error).message };
                }
            });

            const results = await Promise.all(parallelPromises);
            const successCount = results.filter((r) => r.success).length;

            return JSON.stringify({
                success: true,
                total_actions: actions.length,
                successful: successCount,
                failed: actions.length - successCount,
                results,
                url: page.url(),
            });
        } catch (err) {
            return JSON.stringify({ error: `Parallel actions failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Multi-Action (Batch operations)
// ═══════════════════════════════════════════════

export const browserMultiAction: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_multi_action",
            description:
                "Execute multiple browser actions in a single step (e.g. navigate, then wait, then click, then type). Reduces API calls and speeds up execution. Supports: navigate, click, type, wait, scroll, keyboard, select, hover, extract, screenshot, assert, and conditional logic.",
            parameters: {
                type: "object",
                properties: {
                    actions: {
                        type: "array",
                        description: "Array of actions to perform sequentially.",
                        items: {
                            type: "object",
                            properties: {
                                action: {
                                    type: "string",
                                    description:
                                        "Type of action: 'navigate', 'click', 'type', 'wait', 'scroll', 'keyboard', 'select', 'hover', 'hover_reveal', 'js_eval', 'wait_for_opacity', 'extract', 'screenshot', 'assert', 'if_visible'. Use 'hover_reveal' to hover and wait for hidden controls (e.g. YouTube video player controls). Use 'js_eval' to run arbitrary JS (e.g. YouTube player API). Use 'wait_for_opacity' to wait until an element becomes fully visible.",
                                },
                                url: { type: "string" },
                                selector: { type: "string" },
                                text: { type: "string" },
                                label: { type: "number" },
                                x: { type: "number" },
                                y: { type: "number" },
                                key: { type: "string" },
                                combo: { type: "string" },
                                direction: { type: "string" },
                                amount: { type: "number" },
                                value: { type: "string" },
                                wait_ms: { type: "number" },
                                attribute: {
                                    type: "string",
                                    description: "For extract: attribute to get (default: textContent)",
                                },
                                expected: { type: "string", description: "For assert: expected text to contain" },
                                then_actions: {
                                    type: "array",
                                    description: "For if_visible: actions to run if selector is visible",
                                },
                                else_actions: {
                                    type: "array",
                                    description: "For if_visible: actions to run if selector is NOT visible",
                                },
                                continue_on_error: {
                                    type: "boolean",
                                    description: "If true, continue executing even if this action fails",
                                },
                                fullPage: { type: "boolean", description: "For screenshot: capture full page" },
                                steps: {
                                    type: "number",
                                    description:
                                        "For hover/hover_reveal: mouse interpolation steps (default: 8). Higher = smoother, better for CSS :hover transitions.",
                                },
                                wait_for: {
                                    type: "string",
                                    description:
                                        "For hover_reveal: CSS selector to wait for after hover (e.g. '.ytp-chrome-bottom'). Waits up to 3s.",
                                },
                                opacity_threshold: {
                                    type: "number",
                                    description:
                                        "For wait_for_opacity: minimum opacity to consider visible (default: 0.5)",
                                },
                                code: {
                                    type: "string",
                                    description:
                                        "For js_eval: JavaScript code to execute via page.evaluate(). Use 'return' to get data back. Example: 'return document.getElementById(\"movie_player\")?.getCurrentTime()'",
                                },
                                timeout_ms: {
                                    type: "number",
                                    description:
                                        "For wait_for_opacity/wait actions: max wait time in ms (default: 5000)",
                                },
                            },
                            required: ["action"],
                        },
                    },
                    stop_on_error: { type: "boolean", description: "Stop execution on first error (default: true)" },
                    final_scan: { type: "boolean", description: "Run element scan after all actions (default: true)" },
                },
                required: ["actions"],
            },
        },
    },
    async handler(input) {
        try {
            const context = await getBrowser();
            // Always use the active page — not pages[last] which ignores setActivePageIndex()
            const page = await getActivePage();

            // Handle both JSON string and array inputs (LLMs sometimes pass a JSON string)
            let parsedMultiActions = input.actions;
            if (typeof parsedMultiActions === "string") {
                try {
                    parsedMultiActions = JSON.parse(parsedMultiActions);
                } catch {
                    return JSON.stringify({ success: false, error: "Invalid actions JSON string" });
                }
            }
            const actions = parsedMultiActions as Array<Record<string, unknown>>;
            const stopOnError = (input.stop_on_error as boolean) !== false; // Default true
            const finalScan = (input.final_scan as boolean) !== false; // Default true
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const results: any[] = [];
            let hadError = false;
            const lastElementMap = getLastElementMap();

            // Helper to execute an action array (used for conditional logic)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const executeAction = async (
                act: Record<string, unknown>,
            ): Promise<{ success: boolean; result?: any; error?: string }> => {
                switch (act.action) {
                    case "navigate": {
                        if (act.url) {
                            await page
                                .goto(act.url as string, { waitUntil: "domcontentloaded", timeout: 30000 })
                                .catch(() => null);
                            await waitForPageReady(page, 2000);
                            invalidateCache(); // URL changed
                            return { success: true, result: { url: act.url } };
                        }
                        return { success: false, error: "No URL provided" };
                    }
                    case "click": {
                        let cx, cy;
                        if (act.label !== undefined) {
                            const el = lastElementMap.find((e) => e.label === (act.label as number));
                            if (el) {
                                cx = el.x;
                                cy = el.y;
                            }
                        } else if (act.x !== undefined && act.y !== undefined) {
                            cx = act.x as number;
                            cy = act.y as number;
                        } else if (act.selector) {
                            const el = page.locator(act.selector as string).first();
                            const box = await el.boundingBox().catch(() => null);
                            if (box) {
                                cx = box.x + box.width / 2;
                                cy = box.y + box.height / 2;
                            }
                        } else if (act.text) {
                            const el = page.getByText(act.text as string, { exact: false }).first();
                            const box = await el.boundingBox().catch(() => null);
                            if (box) {
                                cx = box.x + box.width / 2;
                                cy = box.y + box.height / 2;
                            }
                        }

                        if (cx !== undefined && cy !== undefined) {
                            await agentCursor(page, { x: cx, y: cy }, "click");
                            await page.mouse.click(cx, cy);
                            invalidateCache(); // Potential DOM change
                            return { success: true };
                        }
                        return { success: false, error: "Target not found" };
                    }
                    case "type": {
                        if (act.selector) {
                            const el = page.locator(act.selector as string).first();
                            await agentCursor(page, el, "click");
                            try {
                                await el.focus();
                                await el.click();
                            } catch {
                                /* ignore */
                            }
                            const box = await el.boundingBox().catch(() => null);
                            if (box) {
                                const cx = box.x + box.width / 2;
                                const cy = box.y + box.height / 2;
                                await page.mouse.click(cx, cy);
                                await page.waitForTimeout(200);
                            }
                        } else if (act.label !== undefined) {
                            const el = lastElementMap.find((e) => e.label === (act.label as number));
                            if (el) {
                                await agentCursor(page, el, "click");
                                await page.mouse.click(el.x, el.y);
                                await page.waitForTimeout(200);
                            }
                        }
                        if (act.text) {
                            await agentCursor(page, null, "type");
                            await page.keyboard.press("ControlOrMeta+a"); // cross-platform (Ctrl on Win/Linux, Cmd on Mac)
                            await page.waitForTimeout(80);
                            await page.keyboard.type(act.text as string, { delay: 25 });
                            return { success: true };
                        } else if (act.key) {
                            await page.keyboard.press(act.key as string);
                            return { success: true };
                        }
                        return { success: false, error: "No text or key provided" };
                    }
                    case "wait": {
                        const delay = (act.wait_ms as number) || 2000;
                        await page.waitForTimeout(delay);
                        return { success: true, result: { ms: delay } };
                    }
                    case "scroll": {
                        const amount = (act.amount as number) || 500;
                        let deltaX = 0;
                        let deltaY = 0;
                        switch (act.direction) {
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
                        // mouse.wheel uses native CDP — no eval/compiled-lambda issues
                        await agentCursor(page, null, "scroll");
                        await page.mouse.wheel(deltaX, deltaY);
                        invalidateCache();
                        setLastElementMap([]); // clear stale positions after scroll
                        // Allow DOM to settle before final_scan ariaSnapshot runs
                        await new Promise((r) => setTimeout(r, 500));
                        return { success: true };
                    }
                    case "keyboard": {
                        if (act.combo) {
                            const keys = (act.combo as string).split("+").map((k: string) => k.trim());
                            const modifiers = keys.slice(0, -1);
                            const key = keys[keys.length - 1];
                            for (const mod of modifiers) await page.keyboard.down(mod);
                            await page.keyboard.press(key);
                            for (const mod of modifiers.reverse()) await page.keyboard.up(mod);
                            // Let DOM settle after keyboard action (e.g. form submit, dialog dismiss)
                            await new Promise((r) => setTimeout(r, 150));
                            return { success: true };
                        }
                        return { success: false, error: "No combo provided" };
                    }
                    case "select": {
                        if (act.selector && (act.label || act.value)) {
                            await agentCursor(page, page.locator(act.selector as string).first(), "click");
                            if (act.label)
                                await page.selectOption(act.selector as string, { label: act.label as string });
                            else if (act.value) await page.selectOption(act.selector as string, act.value as string);
                            return { success: true };
                        }
                        return { success: false, error: "Selector and value/label required" };
                    }
                    case "hover": {
                        const hoverSteps = (act.steps as number) || 8;
                        if (act.x !== undefined && act.y !== undefined) {
                            await agentCursor(page, { x: act.x as number, y: act.y as number }, "hover");
                            await page.mouse.move(act.x as number, act.y as number, { steps: hoverSteps });
                            return { success: true };
                        } else if (act.label !== undefined) {
                            const el = lastElementMap.find((e) => e.label === (act.label as number));
                            if (el) {
                                await agentCursor(page, el, "hover");
                                await page.mouse.move(el.x, el.y, { steps: hoverSteps });
                                return { success: true };
                            }
                        } else if (act.selector) {
                            const loc = page.locator(act.selector as string).first();
                            await agentCursor(page, loc, "hover");
                            await loc.hover({ force: true }).catch(() => {});
                            return { success: true };
                        }
                        return { success: false, error: "No coordinates, label, or selector provided" };
                    }

                    // hover_reveal: hover + wait for hidden controls to appear + rescan elements
                    // Perfect for YouTube player controls, nav dropdowns, tooltip menus
                    case "hover_reveal": {
                        const hrSteps = (act.steps as number) || 8;
                        const hrWaitFor = act.wait_for as string | undefined;
                        let hx: number, hy: number;

                        if (act.x !== undefined && act.y !== undefined) {
                            hx = act.x as number;
                            hy = act.y as number;
                        } else if (act.selector) {
                            const bbox = await page
                                .locator(act.selector as string)
                                .first()
                                .boundingBox()
                                .catch(() => null);
                            if (!bbox)
                                return { success: false, error: `hover_reveal: selector "${act.selector}" not found` };
                            hx = bbox.x + bbox.width / 2;
                            hy = bbox.y + bbox.height / 2;
                        } else if (act.label !== undefined) {
                            const el = lastElementMap.find((e) => e.label === (act.label as number));
                            if (!el) return { success: false, error: `hover_reveal: label ${act.label} not found` };
                            hx = el.x;
                            hy = el.y;
                        } else {
                            return { success: false, error: "hover_reveal: provide x+y, selector, or label" };
                        }

                        await page.mouse.move(hx, hy, { steps: hrSteps });
                        await page.waitForTimeout((act.wait_ms as number) || 500);

                        if (hrWaitFor) {
                            await page
                                .waitForFunction(
                                    /* javascript-obfuscator:disable */ (sel: string) => {
                                        const el = document.querySelector(sel);
                                        if (!el) return false;
                                        const s = window.getComputedStyle(el);
                                        return (
                                            s.display !== "none" &&
                                            s.visibility !== "hidden" &&
                                            parseFloat(s.opacity) > 0.1
                                        );
                                    },
                                    /* javascript-obfuscator:enable */ hrWaitFor,
                                    { timeout: 3000, polling: 100 },
                                )
                                .catch(() => {});
                        }

                        // Force-rescan to capture newly revealed elements
                        const revealedMap = await getInteractiveElements(page, true);
                        setLastElementMap(revealedMap);
                        return {
                            success: true,
                            result: { revealed_elements: buildElementsText(), hovered_at: { x: hx, y: hy } },
                        };
                    }

                    // js_eval: run arbitrary JavaScript in the page context
                    // IP protection: code is validated by Rust ip_guard before execution
                    case "js_eval": {
                        if (!act.code) return { success: false, error: 'js_eval requires "code"' };
                        const tainted = await vaultTaintError(page);
                        if (tainted) return { success: false, error: tainted };
                        // Validate through native IP guard (blocks exfiltration, Bhai var access, eval)
                        let safeCode: string;
                        try {
                            safeCode = validateJsCode(act.code as string);
                        } catch (guardErr) {
                            return { success: false, error: `ip_guard: ${(guardErr as Error).message}` };
                        }
                        signBrowserAction("js_eval", safeCode.substring(0, 200));
                        const wrappedCode = `(async () => { ${safeCode} })()`;
                        const jsResult = await page.evaluate(wrappedCode);
                        const output =
                            typeof jsResult === "object" ? JSON.stringify(jsResult) : String(jsResult ?? "undefined");
                        return { success: true, result: { output: output.substring(0, 2000) } };
                    }

                    // wait_for_opacity: wait until a CSS element reaches a minimum opacity (e.g. controls fade in)
                    case "wait_for_opacity": {
                        if (!act.selector) return { success: false, error: 'wait_for_opacity requires "selector"' };
                        const threshold = (act.opacity_threshold as number) ?? 0.5;
                        const timeout = (act.timeout_ms as number) || 5000;
                        await page.waitForFunction(
                            /* javascript-obfuscator:disable */ ({ sel, thresh }: { sel: string; thresh: number }) => {
                                const el = document.querySelector(sel);
                                if (!el) return false;
                                return parseFloat(window.getComputedStyle(el).opacity) >= thresh;
                            },
                            /* javascript-obfuscator:enable */ { sel: act.selector as string, thresh: threshold },
                            { timeout, polling: 100 },
                        );
                        return { success: true, result: { selector: act.selector, opacity_reached: threshold } };
                    }
                    case "extract": {
                        const _sel2 = (act.selector as string).replace(/`/g, "\\`");
                        const attr = (act.attribute as string) || "textContent";
                        const _attrExpr =
                            attr === "textContent"
                                ? `el.textContent?.trim()`
                                : `el.getAttribute("${attr.replace(/"/g, '\\"')}")`;
                        const elements = (await page
                            .evaluate(
                                `Array.from(document.querySelectorAll(\`${_sel2}\`)).slice(0,30).map(el=>${_attrExpr})`,
                            )
                            .catch(() => [])) as unknown[];
                        return { success: true, result: { elements, count: elements.length } };
                    }
                    case "screenshot": {
                        const screenshotBuffer = await withAgentUIHidden(page, () =>
                            page.screenshot({ type: "jpeg", quality: 50, fullPage: !!act.fullPage }),
                        );
                        return { success: true, result: { size_kb: Math.round(screenshotBuffer.length / 1024) } };
                    }
                    case "assert": {
                        const expected = act.expected as string;
                        const selector = act.selector as string;
                        if (selector && expected) {
                            const text = await page
                                .locator(selector)
                                .first()
                                .textContent()
                                .catch(() => "");
                            if (text && text.includes(expected)) {
                                return { success: true, result: { found: expected } };
                            }
                            return {
                                success: false,
                                error: `Expected "${expected}" not found in "${text?.substring(0, 100)}"`,
                            };
                        }
                        return { success: false, error: "Selector and expected text required" };
                    }
                    case "if_visible": {
                        const selector = act.selector as string;
                        const isVisible = await page
                            .locator(selector)
                            .first()
                            .isVisible()
                            .catch(() => false);
                        const actionsToRun = isVisible
                            ? (act.then_actions as Array<Record<string, unknown>>) || []
                            : (act.else_actions as Array<Record<string, unknown>>) || [];

                        for (const subAct of actionsToRun) {
                            const subResult = await executeAction(subAct);
                            results.push({ action: subAct.action, ...subResult });
                            if (!subResult.success && stopOnError && !subAct.continue_on_error) {
                                return { success: false, error: `Conditional action failed: ${subResult.error}` };
                            }
                        }
                        return {
                            success: true,
                            result: { branch: isVisible ? "then" : "else", actions_run: actionsToRun.length },
                        };
                    }
                    default:
                        return { success: false, error: `Unknown action: ${act.action}` };
                }
            };

            for (let i = 0; i < actions.length; i++) {
                const act = actions[i];
                try {
                    const result = await executeAction(act);
                    results.push({ action: act.action, ...result });

                    if (!result.success) {
                        hadError = true;
                        if (stopOnError && !act.continue_on_error) {
                            break;
                        }
                    }

                    // Smart wait between actions (reduced from 800ms to 150ms for speed)
                    if (i < actions.length - 1 && actions[i + 1].action !== "wait") {
                        await page.waitForTimeout(150);
                    }
                } catch (e) {
                    hadError = true;
                    results.push({ action: act.action, success: false, error: (e as Error).message });
                    if (stopOnError && !act.continue_on_error) {
                        break;
                    }
                }
            }

            // Only scan if requested and useful
            let newElementMap = lastElementMap;
            if (finalScan) {
                await page.waitForTimeout(500);
                newElementMap = await getInteractiveElements(page);
                setLastElementMap(newElementMap);
            }

            return JSON.stringify({
                success: !hadError || !stopOnError,
                url: page.url(),
                title: await page.title(),
                actions_executed: results.length,
                results,
                elements: finalScan ? buildElementsText() : "(scan skipped)",
            });
        } catch (err) {
            return JSON.stringify({ error: `Multi-action failed: ${(err as Error).message}` });
        }
    },
};
