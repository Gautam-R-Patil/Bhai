// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Mode Tools ───────────────────────
// Tools for switching between Chrome extension and Playwright backends,
// and checking Chrome extension connection status.

import type { ToolDefinition } from "../get-current-time.js";
import {
    setPreferredMode,
    getCurrentMode,
    resolveBackend,
} from "./browser-backend.js";
import {
    isExtensionConnected,
    getExtensionTabs,
    getBridgeStats,
    getBridgeToken,
} from "./chrome-bridge.js";

// ═══════════════════════════════════════════════
// TOOL: Set Browser Mode
// ═══════════════════════════════════════════════

export const browserSetMode: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_set_mode",
            description: `Switch between the user's real Chrome browser and headless Playwright.

Use "chrome" when:
- The user asks about their current tab, what they're viewing, or their Chrome
- The user says "use my Chrome", "look at my tab", "what's on this page"
- The user is on a logged-in site and asks you to interact with it
- You need the user's session state (cookies, logins)

Use "playwright" when:
- You need to do independent research, scraping, or background tasks
- The user asks you to "research", "search", "look up", "find" something
- You need multiple tabs open simultaneously for comparison
- You're running parallel browser tasks

Use "auto" to let the system decide based on context.`,
            parameters: {
                type: "object",
                properties: {
                    mode: {
                        type: "string",
                        enum: ["chrome", "playwright", "auto"],
                        description: "'chrome' = user's real Chrome via extension, 'playwright' = headless Playwright browser, 'auto' = system decides based on context",
                    },
                },
                required: ["mode"],
            },
        },
    },
    async handler(input) {
        const mode = input.mode as "chrome" | "playwright" | "auto";

        // Validate chrome mode is possible
        if (mode === "chrome" && !isExtensionConnected()) {
            return JSON.stringify({
                error: "Chrome extension is not connected. The user needs to install and connect the ATLAS Browser Bridge extension in Chrome.",
                current_mode: getCurrentMode(),
                extension_connected: false,
                suggestion: "Use 'playwright' mode instead, or ask the user to connect the Chrome extension.",
            });
        }

        setPreferredMode(mode);
        resolveBackend();

        const actualMode = getCurrentMode();

        const result: Record<string, unknown> = {
            success: true,
            requested_mode: mode,
            active_mode: actualMode,
            extension_connected: isExtensionConnected(),
        };

        // If chrome mode, include active tab info
        if (actualMode === "chrome") {
            try {
                const tabs = await getExtensionTabs();
                const activeTab = tabs.find(t => t.active);
                result.active_tab = activeTab
                    ? { title: activeTab.title, url: activeTab.url }
                    : null;
                result.total_tabs = tabs.length;
            } catch { /* extension error — non-fatal */ }
        }

        return JSON.stringify(result);
    },
};

// ═══════════════════════════════════════════════
// TOOL: Chrome Extension Status
// ═══════════════════════════════════════════════

export const browserChromeStatus: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_chrome_status",
            description: "Check if the Chrome extension is connected, and list the user's open Chrome tabs. Use this to see what the user is currently browsing before deciding whether to use chrome or playwright mode.",
            parameters: {
                type: "object",
                properties: {
                    show_token: {
                        type: "boolean",
                        description: "If true, include the bridge token in the response (for the user to configure the extension)",
                    },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        const connected = isExtensionConnected();
        const mode = getCurrentMode();
        const stats = getBridgeStats();

        const result: Record<string, unknown> = {
            extension_connected: connected,
            current_mode: mode,
            stats,
        };

        if (connected) {
            try {
                const tabs = await getExtensionTabs();
                result.tabs = tabs.map(t => ({
                    title: t.title,
                    url: t.url,
                    active: t.active,
                }));
                result.total_tabs = tabs.length;
                const activeTab = tabs.find(t => t.active);
                if (activeTab) {
                    result.active_tab = { title: activeTab.title, url: activeTab.url };
                }
            } catch (err) {
                result.tabs_error = (err as Error).message;
            }
        } else {
            result.help = "The Chrome extension is not connected. The user needs to: 1) Install the ATLAS Browser Bridge extension from chrome-extension/ folder, 2) Enter the auth token from the ATLAS console into the extension popup, 3) Click Connect.";
        }

        if (input.show_token) {
            result.bridge_token = getBridgeToken();
        }

        return JSON.stringify(result);
    },
};
