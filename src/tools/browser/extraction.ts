// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Extraction & Utility Tools ────────
// Analyze, extract, runJS, wait, select, upload, strategies

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPathBlockedReason, isPathAllowed } from "../../security/allowlist.js";
import { auditLog } from "../../security/audit-log.js";
import { isSensitivePath } from "../../security/sensitive-paths.js";
import { getWorkspaceDir } from "../../config/paths.js";
import { addDomainTip, findStrategy, getDomainTips, recordStrategy } from "../browser-memory.js";
import type { ToolDefinition } from "../get-current-time.js";
import { agentCursor } from "./agent-cursor.js";
import {
    buildElementsText,
    getActivePage,
    getInteractiveElements,
    getLastElementMap,
    invalidateCache,
    setLastElementMap,
    waitForPageReady,
} from "./core.js";
import { signBrowserAction, validateJsCode } from "./native-browser.js";
import { vaultTaintError } from "./vault-typing.js";

// ═══════════════════════════════════════════════
// TOOL: Analyze page (smart element detection)
// ═══════════════════════════════════════════════

export const browserAnalyze: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_analyze",
            description:
                "Analyze the current page: lists all interactive elements with their positions, text, and bounding boxes so you know where to click.",
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
            const analysis = await page.evaluate(
                /* javascript-obfuscator:disable */ (includeText: boolean) => {
                    const r: Record<string, unknown[]> = { buttons: [], links: [], inputs: [], selects: [] };

                    document.querySelectorAll("button, [role='button'], input[type='submit']").forEach((el, i) => {
                        if (i < 25) {
                            const rect = el.getBoundingClientRect();
                            const t = (el as HTMLElement).innerText?.trim() || el.getAttribute("aria-label") || "";
                            if (t && rect.width > 0)
                                r.buttons.push({
                                    text: t.substring(0, 60),
                                    x: Math.round(rect.x + rect.width / 2),
                                    y: Math.round(rect.y + rect.height / 2),
                                });
                        }
                    });

                    document.querySelectorAll("a[href]").forEach((el, i) => {
                        if (i < 30) {
                            const rect = el.getBoundingClientRect();
                            const t = (el as HTMLElement).innerText?.trim() || "";
                            if (t && t.length > 1 && rect.width > 0)
                                r.links.push({
                                    text: t.substring(0, 60),
                                    href: (el.getAttribute("href") || "").substring(0, 80),
                                    x: Math.round(rect.x + rect.width / 2),
                                    y: Math.round(rect.y + rect.height / 2),
                                });
                        }
                    });

                    document.querySelectorAll("input:not([type='hidden']), textarea").forEach((el, i) => {
                        if (i < 15) {
                            const inp = el as HTMLInputElement;
                            const rect = inp.getBoundingClientRect();
                            if (rect.width > 0)
                                r.inputs.push({
                                    label: inp.placeholder || inp.getAttribute("aria-label") || inp.name || inp.type,
                                    type: inp.type || "text",
                                    x: Math.round(rect.x + rect.width / 2),
                                    y: Math.round(rect.y + rect.height / 2),
                                    // Passwords, card fields, one-time codes: filled or not, never the value.
                                    value:
                                        inp.type === "password" ||
                                        /\b(cc-[a-z-]+|one-time-code|current-password|new-password)\b/.test(
                                            inp.getAttribute("autocomplete") || "",
                                        )
                                            ? inp.value
                                                ? "[filled, hidden]"
                                                : ""
                                            : inp.value?.substring(0, 50) || "",
                                });
                        }
                    });

                    document.querySelectorAll("select").forEach((el, i) => {
                        if (i < 10) {
                            const sel = el as HTMLSelectElement;
                            const rect = sel.getBoundingClientRect();
                            if (rect.width > 0)
                                r.selects.push({
                                    label: sel.getAttribute("aria-label") || sel.name || "",
                                    x: Math.round(rect.x + rect.width / 2),
                                    y: Math.round(rect.y + rect.height / 2),
                                    options: Array.from(sel.options)
                                        .slice(0, 8)
                                        .map((o) => o.text.trim()),
                                });
                        }
                    });

                    const info: Record<string, unknown> = { title: document.title, url: window.location.href, ...r };
                    if (includeText) info.pageText = document.body.innerText.substring(0, 3000);
                    return info;
                },
                /* javascript-obfuscator:enable */ (input.include_text as boolean) !== false,
            );

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
            description:
                "Execute JavaScript in the browser. Use for complex data extraction or direct API control: YouTube Player API (return document.getElementById('movie_player')?.seekTo(300, true)), HTML5 video control (return document.querySelector('video')?.currentTime), reading DOM state, or any interaction that requires JS. Always prefer browser_video_control for video playback tasks — it has automatic fallbacks.",
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
            const tainted = await vaultTaintError(page);
            if (tainted) return JSON.stringify({ error: tainted });
            // IP guard: validate code before execution (blocks exfiltration & Bhai internals access)
            let safeCode: string;
            try {
                safeCode = validateJsCode(input.code as string);
            } catch (guardErr) {
                return JSON.stringify({ error: `ip_guard: ${(guardErr as Error).message}` });
            }
            signBrowserAction("browser_run_js", (safeCode as string).substring(0, 200));
            // Wrap in async IIFE so top-level 'return' statements work
            const wrappedCode = `(async () => { ${safeCode} })()`;
            const result = await page.evaluate(wrappedCode);
            const output = typeof result === "object" ? JSON.stringify(result, null, 2) : String(result ?? "undefined");
            return JSON.stringify({
                success: true,
                result: output.substring(0, 15000),
                truncated: output.length > 15000,
            });
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
            description:
                "Wait for page to load or a specific duration. 'timeout' = simple delay. 'load' = DOM ready. 'selector' = element appears. 'opacity' = element reaches visible opacity (e.g. wait for YouTube controls to fade in). Never fails — if timeout is reached, continues anyway.",
            parameters: {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        description:
                            "'timeout' (wait ms), 'load' (DOM ready), 'selector' (wait for element to appear), 'opacity' (wait for element opacity > threshold — for fade-in animations like video player controls)",
                    },
                    value: {
                        type: "string",
                        description: "Milliseconds for timeout, CSS selector for selector/opacity types",
                    },
                    threshold: {
                        type: "number",
                        description: "For 'opacity' type: minimum opacity to consider visible (default: 0.5)",
                    },
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
                        return JSON.stringify({
                            success: false,
                            error: `Selector "${input.value}" not found within ${timeout}ms timeout`,
                        });
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
                case "opacity": {
                    const sel = input.value as string;
                    const thresh = (input.threshold as number) ?? 0.5;
                    if (sel) {
                        await page
                            .waitForFunction(
                                /* javascript-obfuscator:disable */ ({ s, t }: { s: string; t: number }) => {
                                    const el = document.querySelector(s);
                                    return el ? parseFloat(window.getComputedStyle(el).opacity) >= t : false;
                                },
                                /* javascript-obfuscator:enable */ { s: sel, t: thresh },
                                { timeout, polling: 100 },
                            )
                            .catch(() => {}); // non-fatal — continue if timed out
                    }
                    break;
                }
                default:
                    await waitForPageReady(page, 2000);
            }
            invalidateCache(); // waited for the page to change
            const newElementMap = await getInteractiveElements(page);
            setLastElementMap(newElementMap);
            return JSON.stringify({
                success: true,
                waited_for: input.type,
                url: page.url(),
                title: await page.title(),
                interactive_elements_text: buildElementsText(),
            });
        } catch {
            return JSON.stringify({
                success: true,
                waited_for: input.type,
                note: "Wait timed out but page should be usable",
            });
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
            await agentCursor(page, page.locator(input.selector as string).first(), "click");
            if (input.label) await page.selectOption(input.selector as string, { label: input.label as string });
            else if (input.value) await page.selectOption(input.selector as string, input.value as string);
            if (input.wait_after_ms !== undefined) {
                if ((input.wait_after_ms as number) > 0) await page.waitForTimeout(input.wait_after_ms as number);
            } else {
                await waitForPageReady(page, 1500);
            }
            invalidateCache();
            const newElementMap = await getInteractiveElements(page);
            setLastElementMap(newElementMap);
            return JSON.stringify({
                success: true,
                selected: input.value || input.label,
                interactive_elements_text: buildElementsText(),
            });
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
            const selector = input.selector as string;
            // "innerText"/"text" are text, not HTML attributes (getAttribute gave nano 200 nulls).
            const rawAttr = (input.attribute as string) || "textContent";
            const attr = /^(textcontent|innertext|text|innerhtml|outerhtml|html)$/i.test(rawAttr) ? "textContent" : rawAttr;
            // jQuery's :contains() isn't CSS, and models write it ("th:contains('Born') + td"):
            // every try failed. Match by visible text instead, returning the whole table row.
            const terms = [...String(selector).matchAll(/:contains\(\s*(['"]?)(.*?)\1\s*\)/g)].map((m) => m[2]).filter(Boolean);
            if (terms.length) {
                const rows = await page.evaluate(
                    /* javascript-obfuscator:disable */ ({ words }: { words: string[] }) => {
                        // No named helpers in here: the bundler's __name() wrapper doesn't exist in the page.
                        const out: string[] = [];
                        const lower = words.map((w) => w.toLowerCase());
                        for (const el of Array.from(document.querySelectorAll("th, td, li, p, dt, dd, h1, h2, h3, h4, caption, b, strong"))) {
                            const t = (el as HTMLElement).innerText?.trim();
                            if (!t || t.length > 400 || !lower.every((w) => t.toLowerCase().includes(w))) continue;
                            const row = ((el.closest("tr") ?? el) as HTMLElement).innerText.trim().replace(/\s+/g, " ").slice(0, 500);
                            if (!out.includes(row)) out.push(row);
                            if (out.length >= 10) break;
                        }
                        return out;
                    },
                    /* javascript-obfuscator:enable */ { words: terms },
                );
                return JSON.stringify({
                    success: true,
                    elements: rows,
                    count: (rows as string[]).length,
                    note: `:contains() isn't CSS: matched elements whose text has ${terms.map((t) => `"${t}"`).join(" and ")}.`,
                });
            }
            // Pass selector and attr as parameters — never interpolate user input into eval strings
            const elements = await page.evaluate(
                /* javascript-obfuscator:disable */ ({ sel, at }: { sel: string; at: string }) =>
                    Array.from(document.querySelectorAll(sel))
                        .slice(0, 50)
                        // innerText is what is rendered: textContent also carried <script>/<style>
                        // source and hidden text (instructions planted for the model). Each value
                        // is capped: 50 × a whole <body> was megabytes.
                        .map((el) => {
                            // A password, card or one-time-code field's value (a pre-filled
                            // value attribute) is never handed to the model.
                            const secret =
                                (el as HTMLInputElement).type === "password" ||
                                /\b(cc-[a-z-]+|one-time-code|current-password|new-password)\b/.test(
                                    el.getAttribute("autocomplete") || "",
                                );
                            if (secret && at === "value") return el.getAttribute("value") ? "[filled, hidden]" : "";
                            return (
                                at === "textContent"
                                    ? ((el as HTMLElement).innerText ?? el.textContent)?.trim()
                                    : el.getAttribute(at)
                            )?.slice(0, 2000);
                        }),
                /* javascript-obfuscator:enable */ { sel: selector, at: attr },
            );
            return JSON.stringify({ success: true, elements, count: (elements as unknown[]).length });
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
            description:
                "Upload a file to a website (Gmail attachments, form uploads, etc). Triggers the hidden file input on the page. Use this instead of trying to click file dialogs.",
            parameters: {
                type: "object",
                properties: {
                    file_path: { type: "string", description: "Absolute path to the file to upload" },
                    selector: {
                        type: "string",
                        description: "CSS selector for the file input (optional — auto-detects if not provided)",
                    },
                },
                required: ["file_path"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const rawPath = input.file_path as string;
            if (!rawPath) {
                return JSON.stringify({ error: "file_path is required" });
            }
            const filePath = path.resolve(rawPath);

            auditLog("browser_upload_file", { path: filePath });

            if (!isPathAllowed(filePath)) {
                const reason = getPathBlockedReason(filePath) ?? `Path "${filePath}" is not allowed.`;
                return JSON.stringify({ error: reason });
            }
            const sensitive = isSensitivePath(filePath);
            if (sensitive.denied) {
                return JSON.stringify({
                    error: `Refusing to upload sensitive path. ${sensitive.reason ?? ""}`,
                });
            }
            // Confine uploads to the workspace dir + ~/Downloads (override-friendly).
            const allowedRoots = [
                path.resolve(getWorkspaceDir()),
                path.join(os.homedir(), "Downloads"),
            ];
            const extra = process.env.BHAI_BROWSER_UPLOAD_ROOTS;
            if (extra) {
                for (const p of extra.split(path.delimiter)) {
                    if (p.trim()) allowedRoots.push(path.resolve(p.trim()));
                }
            }
            const inAllowedRoot = allowedRoots.some(
                (root) => filePath === root || filePath.startsWith(root + path.sep),
            );
            if (!inAllowedRoot) {
                return JSON.stringify({
                    error:
                        `browser_upload_file: ${filePath} is outside the allowed upload roots ` +
                        `(${allowedRoots.join(", ")}). Move the file into the workspace or ~/Downloads first.`,
                });
            }

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
                    return JSON.stringify({
                        error: "No file input found on this page. Try clicking the attach/upload button first, then retry.",
                    });
                }
                await fileInputs.first().setInputFiles(filePath);
            }

            await waitForPageReady(page, 1500);
            const fileName = path.basename(filePath);
            return JSON.stringify({
                success: true,
                uploaded: fileName,
                tip: "File should now be attached. Run browser_scan to verify.",
            });
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
            let steps: Array<{ tool: string; args: Record<string, unknown>; success: boolean; durationMs: number }> =
                [];
            if (input.steps_json) {
                try {
                    steps = JSON.parse(input.steps_json as string);
                } catch {
                    /* ignore */
                }
            }
            const id = recordStrategy(
                input.task_pattern as string,
                input.domain as string,
                steps,
                input.tips as string,
            );
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
        if (strategy)
            result.strategy = { taskPattern: strategy.taskPattern, steps: strategy.steps, tips: strategy.notes };
        if (tips.length > 0) result.domainTips = tips;
        return JSON.stringify(result);
    },
};

