// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Extraction & Utility Tools ────────
// Analyze, extract, runJS, wait, select, upload, strategies

import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../get-current-time.js";
import { recordStrategy, addDomainTip, findStrategy, getDomainTips } from "../browser-memory.js";
import {
    getActivePage,
    getInteractiveElements,
    getAccessibilityTree,
    setLastElementMap,
    getLastElementMap,
    buildElementsText,
    waitForPageReady
} from "./core.js";
import {
    getCachedActions,
    shouldReplayActions,
    cacheActions as cacheActionsFn,
    replayActions,
    markActionFailed,
    getActionCacheStats
} from "./action-cache.js";
import type { CachedActionStep } from "./action-cache.js";

// ═══════════════════════════════════════════════
// TOOL: Analyze page (smart element detection)
// ═══════════════════════════════════════════════

export const browserAnalyze: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_analyze",
            description: "Analyze the current page: lists all interactive elements with their positions, text, and bounding boxes so you know where to click.",
            parameters: {
                type: "object",
                properties: {
                    include_text: { type: "boolean", description: "Include page text summary (default: true)" },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const analysis = await page.evaluate((includeText: boolean) => {
                const r: Record<string, unknown[]> = { buttons: [], links: [], inputs: [], selects: [] };

                document.querySelectorAll("button, [role='button'], input[type='submit']").forEach((el, i) => {
                    if (i < 25) {
                        const rect = el.getBoundingClientRect();
                        const t = (el as HTMLElement).innerText?.trim() || el.getAttribute("aria-label") || "";
                        if (t && rect.width > 0) r.buttons.push({ text: t.substring(0, 60), x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
                    }
                });

                document.querySelectorAll("a[href]").forEach((el, i) => {
                    if (i < 30) {
                        const rect = el.getBoundingClientRect();
                        const t = (el as HTMLElement).innerText?.trim() || "";
                        if (t && t.length > 1 && rect.width > 0) r.links.push({ text: t.substring(0, 60), href: (el.getAttribute("href") || "").substring(0, 80), x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
                    }
                });

                document.querySelectorAll("input:not([type='hidden']), textarea").forEach((el, i) => {
                    if (i < 15) {
                        const inp = el as HTMLInputElement;
                        const rect = inp.getBoundingClientRect();
                        if (rect.width > 0) r.inputs.push({ label: inp.placeholder || inp.getAttribute("aria-label") || inp.name || inp.type, type: inp.type || "text", x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), value: inp.value?.substring(0, 50) || "" });
                    }
                });

                document.querySelectorAll("select").forEach((el, i) => {
                    if (i < 10) {
                        const sel = el as HTMLSelectElement;
                        const rect = sel.getBoundingClientRect();
                        if (rect.width > 0) r.selects.push({ label: sel.getAttribute("aria-label") || sel.name || "", x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), options: Array.from(sel.options).slice(0, 8).map((o) => o.text.trim()) });
                    }
                });

                const info: Record<string, unknown> = { title: document.title, url: window.location.href, ...r };
                if (includeText) info.pageText = document.body.innerText.substring(0, 3000);
                return info;
            }, (input.include_text as boolean) !== false);

            return JSON.stringify(analysis);
        } catch (err) {
            return JSON.stringify({ error: `Analysis failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Run JavaScript
// ═══════════════════════════════════════════════

export const browserRunJs: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_run_js",
            description: "Execute JavaScript in the browser. Use for complex data extraction or interactions that other tools can't handle.",
            parameters: {
                type: "object",
                properties: {
                    code: { type: "string", description: "JavaScript code to run. Use 'return' to send data back." },
                },
                required: ["code"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            // Wrap in async IIFE so top-level 'return' statements work
            const wrappedCode = `(async () => { ${input.code} })()`;
            const result = await page.evaluate(wrappedCode);
            const output = typeof result === "object" ? JSON.stringify(result, null, 2) : String(result ?? "undefined");
            return JSON.stringify({ success: true, result: output.substring(0, 15000), truncated: output.length > 15000 });
        } catch (err) {
            return JSON.stringify({ error: `JS failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Wait
// ═══════════════════════════════════════════════

export const browserWait: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_wait",
            description: "Wait for page to load or a specific duration. Use 'timeout' with a value in ms for simple delays. Use 'load' to wait for DOM ready. Use 'selector' to wait for a specific element. Never fails — if timeout is reached, continues anyway.",
            parameters: {
                type: "object",
                properties: {
                    type: { type: "string", description: "'timeout' (wait ms), 'load' (DOM ready), 'selector' (wait for element)" },
                    value: { type: "string", description: "Milliseconds for timeout, or CSS selector for selector type" },
                    timeout_ms: { type: "number", description: "Max wait time in ms (default: 15000)" },
                },
                required: ["type"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const timeout = (input.timeout_ms as number) || 15000;

            switch (input.type) {
                case "selector": {
                    const found = await page.waitForSelector(input.value as string, { timeout }).catch(() => null);
                    if (!found) {
                        return JSON.stringify({ success: false, error: `Selector "${input.value}" not found within ${timeout}ms timeout` });
                    }
                    break;
                }
                case "navigation":
                case "load":
                case "idle":
                    await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => null);
                    break;
                case "timeout":
                    await page.waitForTimeout(parseInt(input.value as string) || 2000);
                    break;
                default:
                    await page.waitForTimeout(2000);
            }
            const newElementMap = await getInteractiveElements(page);
            setLastElementMap(newElementMap);
            return JSON.stringify({ success: true, waited_for: input.type, url: page.url(), title: await page.title(), interactive_elements_text: buildElementsText() });
        } catch {
            return JSON.stringify({ success: true, waited_for: input.type, note: "Wait timed out but page should be usable" });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Select dropdown
// ═══════════════════════════════════════════════

export const browserSelect: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_select",
            description: "Select an option from a dropdown.",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "CSS selector of the <select>" },
                    value: { type: "string", description: "Option value" },
                    label: { type: "string", description: "Option text label" },
                    wait_after_ms: { type: "number", description: "Wait after selecting (default: 500)" },
                },
                required: ["selector"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            if (input.label) await page.selectOption(input.selector as string, { label: input.label as string });
            else if (input.value) await page.selectOption(input.selector as string, input.value as string);
            const waitTime = input.wait_after_ms !== undefined ? (input.wait_after_ms as number) : 500;
            if (waitTime > 0) await page.waitForTimeout(waitTime);
            const newElementMap = await getInteractiveElements(page);
            setLastElementMap(newElementMap);
            return JSON.stringify({ success: true, selected: input.value || input.label, interactive_elements_text: buildElementsText() });
        } catch (err) {
            return JSON.stringify({ error: `Select failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Extract content
// ═══════════════════════════════════════════════

export const browserExtract: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_extract",
            description: "Extract elements from the page using CSS selectors.",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "CSS selector" },
                    attribute: { type: "string", description: "Attribute to extract (default: textContent)" },
                },
                required: ["selector"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const attr = (input.attribute as string) || "textContent";
            const elements = await page.$$eval(
                input.selector as string,
                (els: Element[], a: string) => els.map((el: Element) => a === "textContent" ? el.textContent?.trim() : el.getAttribute(a)).slice(0, 50),
                attr
            );
            return JSON.stringify({ success: true, elements, count: elements.length });
        } catch (err) {
            return JSON.stringify({ error: `Extract failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Upload file (for Gmail, web forms, etc)
// ═══════════════════════════════════════════════

export const browserUploadFile: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_upload_file",
            description: "Upload a file to a website (Gmail attachments, form uploads, etc). Triggers the hidden file input on the page. Use this instead of trying to click file dialogs.",
            parameters: {
                type: "object",
                properties: {
                    file_path: { type: "string", description: "Absolute path to the file to upload" },
                    selector: { type: "string", description: "CSS selector for the file input (optional — auto-detects if not provided)" },
                },
                required: ["file_path"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const filePath = input.file_path as string;

            if (!fs.existsSync(filePath)) {
                return JSON.stringify({ error: `File not found: ${filePath}` });
            }

            if (input.selector) {
                const fileInput = page.locator(input.selector as string).first();
                await fileInput.setInputFiles(filePath);
            } else {
                const fileInputs = page.locator('input[type="file"]');
                const count = await fileInputs.count();
                if (count === 0) {
                    return JSON.stringify({ error: "No file input found on this page. Try clicking the attach/upload button first, then retry." });
                }
                await fileInputs.first().setInputFiles(filePath);
            }

            await page.waitForTimeout(1500);
            const fileName = path.basename(filePath);
            return JSON.stringify({ success: true, uploaded: fileName, tip: "File should now be attached. Run browser_scan to verify." });
        } catch (err) {
            return JSON.stringify({ error: `Upload failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Save strategy
// ═══════════════════════════════════════════════

export const browserSaveStrategy: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_save_strategy",
            description: "Save the browsing approach for future reuse.",
            parameters: {
                type: "object",
                properties: {
                    task_pattern: { type: "string", description: "Task description" },
                    domain: { type: "string", description: "Domain" },
                    steps_json: { type: "string", description: "JSON steps array" },
                    tips: { type: "string", description: "Tips learned" },
                },
                required: ["task_pattern", "domain", "tips"],
            },
        },
    },
    async handler(input) {
        try {
            let steps: Array<{ tool: string; args: Record<string, unknown>; success: boolean; durationMs: number }> = [];
            if (input.steps_json) { try { steps = JSON.parse(input.steps_json as string); } catch { /* ignore */ } }
            const id = recordStrategy(input.task_pattern as string, input.domain as string, steps, input.tips as string);
            if (input.tips) addDomainTip(input.domain as string, input.tips as string);
            return JSON.stringify({ success: true, strategy_id: id });
        } catch (err) {
            return JSON.stringify({ error: `Save failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Recall strategy
// ═══════════════════════════════════════════════

export const browserRecallStrategy: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_recall_strategy",
            description: "Check for a previously saved strategy before starting a browsing task.",
            parameters: {
                type: "object",
                properties: {
                    task: { type: "string", description: "Task description" },
                    domain: { type: "string", description: "Target domain" },
                },
                required: ["task"],
            },
        },
    },
    async handler(input) {
        const strategy = findStrategy(input.task as string, input.domain as string | undefined);
        const tips = input.domain ? getDomainTips(input.domain as string) : [];
        if (!strategy && tips.length === 0) return JSON.stringify({ found: false });
        const result: Record<string, unknown> = { found: !!strategy };
        if (strategy) result.strategy = { taskPattern: strategy.taskPattern, steps: strategy.steps, tips: strategy.notes };
        if (tips.length > 0) result.domainTips = tips;
        return JSON.stringify(result);
    },
};

// ═══════════════════════════════════════════════
// TOOL: Replay cached actions (self-healing cache)
// ═══════════════════════════════════════════════

export const browserReplayActions: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_replay_actions",
            description: "Replay a previously cached action sequence on the current page. If cached actions exist for this URL and have a high success rate, this replays them instantly — skipping LLM page analysis for major cost savings. If replay fails, the cache self-heals (degrades the entry) and you should fall back to normal browser_scan + browser_click_at flow.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL to check cache for (optional — defaults to current page URL)" },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const url = (input.url as string) || (typeof page.url === "function" ? page.url() : "");

            if (!url) {
                return JSON.stringify({ success: false, error: "No URL available to look up cached actions" });
            }

            const cached = getCachedActions(url);
            if (!cached) {
                return JSON.stringify({ success: false, reason: "no_cache", message: "No cached actions for this URL. Use normal browser_scan + click flow." });
            }

            if (!shouldReplayActions(cached)) {
                const total = cached.successCount + cached.failCount;
                const rate = total > 0 ? Math.round((cached.successCount / total) * 100) : 0;
                return JSON.stringify({
                    success: false,
                    reason: "low_success_rate",
                    message: `Cached actions exist but success rate is too low (${rate}%). Using normal flow instead.`,
                    successRate: rate,
                });
            }

            // Attempt the replay
            const replayOk = await replayActions(page, cached);

            if (replayOk) {
                // Wait for page to stabilize after replayed actions
                await waitForPageReady(page);

                // Get fresh state after replay
                const [accessibilityTree, elementMap] = await Promise.all([
                    getAccessibilityTree(page),
                    getInteractiveElements(page, true),
                ]);
                setLastElementMap(elementMap);

                const result: Record<string, unknown> = {
                    success: true,
                    replayed_actions: cached.actions.length,
                    title: await page.title(),
                    url: page.url(),
                    interactive_elements_text: buildElementsText(),
                    message: "Cached actions replayed successfully! Page is ready.",
                };
                if (accessibilityTree) {
                    result.accessibility_tree = accessibilityTree;
                }
                return JSON.stringify(result);
            } else {
                // Replay failed — self-healing already incremented failCount
                return JSON.stringify({
                    success: false,
                    reason: "replay_failed",
                    message: "Cached action replay failed (page may have changed). Cache entry degraded. Fall back to normal browser_scan + click flow.",
                    tip: "Use browser_scan to re-analyze the page and proceed manually.",
                });
            }
        } catch (err) {
            return JSON.stringify({ error: `Replay failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Cache browser actions
// ═══════════════════════════════════════════════

export const browserCacheActions: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_cache_actions",
            description: "Cache a successful browser action sequence for future replay. Call this after completing a browser task successfully so the same steps can be replayed instantly next time (skipping LLM analysis). The actions will be associated with the current page's URL pattern.",
            parameters: {
                type: "object",
                properties: {
                    actions_json: {
                        type: "string",
                        description: 'JSON array of action steps. Each step: {"selector": "CSS selector", "action": "click|type|select|scroll|hover|press_key", "value": "optional text/key"}',
                    },
                    url: { type: "string", description: "URL to cache for (optional — defaults to current page URL)" },
                },
                required: ["actions_json"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const url = (input.url as string) || (typeof page.url === "function" ? page.url() : "");

            if (!url) {
                return JSON.stringify({ success: false, error: "No URL available to cache actions for" });
            }

            let actions: CachedActionStep[];
            try {
                actions = JSON.parse(input.actions_json as string);
            } catch {
                return JSON.stringify({ success: false, error: "Invalid JSON in actions_json" });
            }

            if (!Array.isArray(actions) || actions.length === 0) {
                return JSON.stringify({ success: false, error: "actions_json must be a non-empty array" });
            }

            // Validate each action step
            for (const step of actions) {
                if (!step.selector || !step.action) {
                    return JSON.stringify({ success: false, error: "Each action must have 'selector' and 'action' fields" });
                }
                const validActions = ["click", "type", "select", "scroll", "hover", "press_key"];
                if (!validActions.includes(step.action)) {
                    return JSON.stringify({ success: false, error: `Invalid action "${step.action}". Valid: ${validActions.join(", ")}` });
                }
            }

            cacheActionsFn(url, actions);

            const stats = getActionCacheStats();
            return JSON.stringify({
                success: true,
                cached_for: url,
                action_count: actions.length,
                total_cached_urls: stats.total,
                message: "Actions cached! Next time you visit this URL, browser_replay_actions will replay them instantly.",
            });
        } catch (err) {
            return JSON.stringify({ error: `Cache failed: ${(err as Error).message}` });
        }
    },
};
