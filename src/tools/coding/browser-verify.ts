// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── browser_verify ───────────────────────────
// Post-coding UI verification. Navigates to a URL with a console
// listener attached before the page loads, waits for stabilization,
// then runs optional assertions:
//   • expect_no_console_errors (default true)
//   • expect_selectors — CSS selectors that must exist
//   • expect_text — strings that must appear in visible body text
// Returns a structured { success, console_errors, missing_selectors,
// missing_text, page_errors, failed_requests, title, load_ms } so the
// agent can decide whether the change rendered correctly.
//
// Designed to close the verify-before-done loop for UI/frontend edits:
// test_run covers unit tests, browser_verify covers "does the page
// actually render without errors."

import { getActivePage } from "../browser/core.js";
import type { ToolDefinition } from "../get-current-time.js";

const DEFAULT_WAIT_MS = 1500;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_COLLECTED_ERRORS = 12;
const MAX_CONSOLE_LEN = 400;

export const browserVerify: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_verify",
            description:
                "Verify a web page after frontend changes. Navigates to `url`, attaches a console/error listener BEFORE load, waits for stabilization, then checks: no console errors, no page exceptions, no failed network requests, optional selectors present, optional text visible. Use after editing UI files (.tsx/.jsx/.vue/.svelte/.html/.css) and before claiming done. For complex flows (login, multi-step forms), delegate to the browser sub-agent via swarm_task instead.",
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description:
                            "URL to verify, e.g. http://localhost:3000/dashboard. Starts the dev server yourself via shell_exec_background first if needed.",
                    },
                    expect_text: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Strings that must appear in the page's visible text. Use short, distinctive phrases.",
                    },
                    expect_selectors: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "CSS selectors that must exist in the DOM after load, e.g. ['main[data-testid=\"dashboard\"]', 'nav a[href=\"/settings\"]'].",
                    },
                    expect_no_console_errors: {
                        type: "boolean",
                        description: "Default true. Set false for pages where warnings are expected.",
                    },
                    expect_no_failed_requests: {
                        type: "boolean",
                        description: "Default true. Set false if 404s on optional resources are acceptable.",
                    },
                    wait_ms: {
                        type: "number",
                        description: `Milliseconds to wait after domcontentloaded before checking (default ${DEFAULT_WAIT_MS}). Increase for slow-hydrating apps.`,
                    },
                    timeout_ms: {
                        type: "number",
                        description: `Navigation timeout in ms (default ${DEFAULT_TIMEOUT_MS}).`,
                    },
                },
                required: ["url"],
            },
        },
    },

    async handler(input) {
        const url = (input.url as string) || "";
        if (!url.trim()) return JSON.stringify({ error: "url is required" });

        const expectNoConsoleErrors = input.expect_no_console_errors !== false;
        const expectNoFailedRequests = input.expect_no_failed_requests !== false;
        const expectText = Array.isArray(input.expect_text) ? (input.expect_text as string[]) : [];
        const expectSelectors = Array.isArray(input.expect_selectors) ? (input.expect_selectors as string[]) : [];
        const waitMs = Math.max(0, Number(input.wait_ms) || DEFAULT_WAIT_MS);
        const timeoutMs = Math.max(1000, Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS);

        let page: Awaited<ReturnType<typeof getActivePage>>;
        try {
            page = await getActivePage();
        } catch (err) {
            return JSON.stringify({
                success: false,
                error: `Browser not available: ${(err as Error).message}. Ensure the browser backend is running or switch modes via browser_set_mode.`,
            });
        }

        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const failedRequests: string[] = [];

        // Listeners are best-effort: the Chrome-extension backend's page
        // proxy may not implement all event types. We wrap each hookup in
        // its own try so one unsupported event doesn't break the others.
        const listenerCleanups: Array<() => void> = [];
        try {
            const onConsole = (msg: unknown) => {
                try {
                    const m = msg as { type?: () => string; text?: () => string };
                    if (m.type?.() === "error") {
                        const t = m.text?.() ?? "";
                        if (t) consoleErrors.push(t.slice(0, MAX_CONSOLE_LEN));
                    }
                } catch {
                    /* swallow */
                }
            };
            const p = page as unknown as {
                on?: (ev: string, fn: unknown) => void;
                off?: (ev: string, fn: unknown) => void;
            };
            if (typeof p.on === "function") {
                p.on("console", onConsole);
                listenerCleanups.push(() => {
                    try {
                        p.off?.("console", onConsole);
                    } catch {
                        /* */
                    }
                });
            }
        } catch {
            /* listener unsupported */
        }

        try {
            const onPageError = (err: unknown) => {
                try {
                    const e = err as Error;
                    pageErrors.push((e.message || String(e)).slice(0, MAX_CONSOLE_LEN));
                } catch {
                    /* */
                }
            };
            const p = page as unknown as {
                on?: (ev: string, fn: unknown) => void;
                off?: (ev: string, fn: unknown) => void;
            };
            if (typeof p.on === "function") {
                p.on("pageerror", onPageError);
                listenerCleanups.push(() => {
                    try {
                        p.off?.("pageerror", onPageError);
                    } catch {
                        /* */
                    }
                });
            }
        } catch {
            /* */
        }

        try {
            const onRequestFailed = (req: unknown) => {
                try {
                    const r = req as {
                        method?: () => string;
                        url?: () => string;
                        failure?: () => { errorText?: string } | null;
                    };
                    const line = `${r.method?.() ?? "?"} ${r.url?.() ?? "?"} — ${r.failure?.()?.errorText ?? "request failed"}`;
                    failedRequests.push(line.slice(0, MAX_CONSOLE_LEN));
                } catch {
                    /* */
                }
            };
            const p = page as unknown as {
                on?: (ev: string, fn: unknown) => void;
                off?: (ev: string, fn: unknown) => void;
            };
            if (typeof p.on === "function") {
                p.on("requestfailed", onRequestFailed);
                listenerCleanups.push(() => {
                    try {
                        p.off?.("requestfailed", onRequestFailed);
                    } catch {
                        /* */
                    }
                });
            }
        } catch {
            /* */
        }

        // Declare all output vars here so the finally-block cleanup below
        // doesn't strand them inside a try scope.
        let navError: string | undefined;
        let loadMs = 0;
        const missingSelectors: string[] = [];
        const missingText: string[] = [];
        let bodyText = "";
        let title = "";
        let finalUrl = url;

        // Wrap everything that uses the listeners in try/finally so cleanup
        // runs even if a selector / evaluate / title call throws. Before
        // this the listeners leaked on any unhandled throw between goto
        // and the old explicit cleanup call.
        try {
            const start = Date.now();
            try {
                await (page as unknown as { goto: (u: string, opts?: unknown) => Promise<unknown> }).goto(url, {
                    waitUntil: "domcontentloaded",
                    timeout: timeoutMs,
                });
            } catch (err) {
                navError = (err as Error).message;
            }
            loadMs = Date.now() - start;

            // Stabilization wait
            try {
                await (page as unknown as { waitForTimeout: (ms: number) => Promise<void> }).waitForTimeout(waitMs);
            } catch {
                /* */
            }

            // Selector checks
            for (const sel of expectSelectors.slice(0, 20)) {
                try {
                    const handle = await (page as unknown as { $: (s: string) => Promise<unknown> }).$(sel);
                    if (!handle) missingSelectors.push(sel);
                } catch {
                    missingSelectors.push(sel);
                }
            }

            // Text checks
            if (expectText.length > 0) {
                try {
                    bodyText = await (page as unknown as { evaluate: (fn: unknown) => Promise<string> }).evaluate(
                        "() => document.body?.innerText ?? ''",
                    );
                } catch {
                    bodyText = "";
                }
                for (const txt of expectText.slice(0, 20)) {
                    if (!bodyText.includes(txt)) missingText.push(txt);
                }
            }

            // Page state
            try {
                title = await (page as unknown as { title: () => Promise<string> }).title();
            } catch {
                /* */
            }
            try {
                finalUrl = (page as unknown as { url: () => string }).url() ?? url;
            } catch {
                /* */
            }
        } finally {
            // Listeners must always come off — leaking them accumulates zombie
            // handlers on the shared page proxy across repeated browser_verify calls.
            for (const off of listenerCleanups) {
                try {
                    off();
                } catch {
                    /* */
                }
            }
        }

        const passed =
            !navError &&
            missingSelectors.length === 0 &&
            missingText.length === 0 &&
            (!expectNoConsoleErrors || consoleErrors.length === 0) &&
            pageErrors.length === 0 &&
            (!expectNoFailedRequests || failedRequests.length === 0);

        return JSON.stringify({
            success: passed,
            url: finalUrl,
            title,
            load_ms: loadMs,
            navigation_error: navError,
            console_errors: consoleErrors.slice(0, MAX_COLLECTED_ERRORS),
            page_errors: pageErrors.slice(0, MAX_COLLECTED_ERRORS),
            failed_requests: failedRequests.slice(0, MAX_COLLECTED_ERRORS),
            missing_selectors: missingSelectors,
            missing_text: missingText,
            checks: {
                no_console_errors: consoleErrors.length === 0,
                no_page_errors: pageErrors.length === 0,
                no_failed_requests: failedRequests.length === 0,
                all_selectors_present: missingSelectors.length === 0,
                all_text_present: missingText.length === 0,
            },
            hint: passed
                ? undefined
                : navError
                  ? "Navigation itself failed — is the dev server running at this URL? Start it via shell_exec_background and re-verify."
                  : consoleErrors.length > 0 || pageErrors.length > 0
                    ? "Runtime errors detected. Read the error messages above, localize via fix_issue on the first one, then edit and re-verify."
                    : "Page loaded but expected content/selectors missing. Verify your edit actually rendered the expected UI — check data flow and component wiring.",
        });
    },
};
