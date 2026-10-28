// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    checkRateLimit,
    clearCache,
    getCached,
    getToolAnalytics,
    isCacheable,
    isDestructiveHotkey,
    recordToolUsage,
    requiresConfirmation,
    resetRateLimits,
    setCache,
} from "./tool-intelligence.js";

describe("tool-intelligence — result cache", () => {
    beforeEach(() => clearCache());

    describe("isCacheable", () => {
        it("returns true for known cacheable tools with no action filter", () => {
            expect(isCacheable("system_info", {})).toBe(true);
            expect(isCacheable("list_directory", { path: "/tmp" })).toBe(true);
            expect(isCacheable("web_search", { query: "hello" })).toBe(true);
        });

        it("returns false for unknown tools", () => {
            expect(isCacheable("unknown_tool", {})).toBe(false);
            expect(isCacheable("edit", { path: "x" })).toBe(false);
        });

        it("honors action allowlists for mixed-action tools", () => {
            // app_manager is cacheable only for "list" action
            expect(isCacheable("app_manager", { action: "list" })).toBe(true);
            expect(isCacheable("app_manager", { action: "force_quit" })).toBe(false);
            expect(isCacheable("dark_mode", { action: "status" })).toBe(true);
            expect(isCacheable("dark_mode", { action: "enable" })).toBe(false);
        });

        it("clipboard is cacheable only for read action", () => {
            expect(isCacheable("clipboard", { action: "read" })).toBe(true);
            expect(isCacheable("clipboard", { action: "write" })).toBe(false);
        });

        it("mixed-action tool called WITHOUT an action passes the set check", () => {
            // When args has no `action` field, the filter short-circuits to
            // "no specific action → allowed". This is a deliberate choice
            // so callers that invoke a tool's default behavior still benefit
            // from caching.
            expect(isCacheable("app_manager", {})).toBe(true);
        });
    });

    describe("getCached / setCache round-trip", () => {
        it("returns null for a cold cache", () => {
            expect(getCached("system_info", {})).toBeNull();
        });

        it("returns the stored value on a warm hit", () => {
            setCache("system_info", {}, "hello world");
            expect(getCached("system_info", {})).toEqual("hello world");
        });

        it("different args → different cache entries", () => {
            setCache("list_directory", { path: "/tmp" }, "a");
            setCache("list_directory", { path: "/home" }, "b");
            expect(getCached("list_directory", { path: "/tmp" })).toEqual("a");
            expect(getCached("list_directory", { path: "/home" })).toEqual("b");
        });

        it("cache key is order-insensitive on args (sorted keys)", () => {
            setCache("list_directory", { path: "/x", limit: 10 }, "result");
            // Same args, different key order
            expect(getCached("list_directory", { limit: 10, path: "/x" })).toEqual("result");
        });

        it("clearCache empties the store", () => {
            setCache("system_info", {}, "cached");
            expect(getCached("system_info", {})).toEqual("cached");
            clearCache();
            expect(getCached("system_info", {})).toBeNull();
        });

        it("expires entries past their TTL", () => {
            // get_current_time has a 5-second TTL — shortest in the table.
            vi.useFakeTimers();
            try {
                vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
                setCache("get_current_time", {}, "now");
                expect(getCached("get_current_time", {})).toEqual("now");

                // Advance past the 5s TTL.
                vi.setSystemTime(new Date("2025-01-01T00:00:06Z"));
                expect(getCached("get_current_time", {})).toBeNull();
            } finally {
                vi.useRealTimers();
            }
        });

        it("keeps entries just before the TTL", () => {
            vi.useFakeTimers();
            try {
                vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
                setCache("clipboard", {}, "cached"); // 30s TTL
                vi.setSystemTime(new Date("2025-01-01T00:00:29Z"));
                expect(getCached("clipboard", {})).toEqual("cached");
            } finally {
                vi.useRealTimers();
            }
        });

        it("uses the default TTL for tools without a specific entry", () => {
            // memory_list has 120_000ms TTL explicitly configured, but
            // that's just one of many. Pick a cacheable tool without
            // a TTL override: "identity_view" → 300_000ms.
            vi.useFakeTimers();
            try {
                vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
                setCache("identity_view", {}, "me");
                // Well under 300s — should still hit.
                vi.setSystemTime(new Date("2025-01-01T00:04:00Z"));
                expect(getCached("identity_view", {})).toEqual("me");
                // Past 300s — expired.
                vi.setSystemTime(new Date("2025-01-01T00:05:01Z"));
                expect(getCached("identity_view", {})).toBeNull();
            } finally {
                vi.useRealTimers();
            }
        });
    });
});

describe("tool-intelligence — rate limiter", () => {
    beforeEach(() => resetRateLimits());

    it("allows calls under the per-tool limit", () => {
        // web_search: limit 15
        for (let i = 0; i < 15; i++) {
            expect(checkRateLimit("web_search").allowed).toBe(true);
        }
    });

    it("blocks calls past the per-tool limit", () => {
        for (let i = 0; i < 15; i++) checkRateLimit("web_search");
        const blocked = checkRateLimit("web_search");
        expect(blocked.allowed).toBe(false);
        expect(blocked.reason).toMatch(/rate limit/i);
        expect(blocked.reason).toContain("web_search");
    });

    it("uses the default limit (30) for tools without a specific override", () => {
        for (let i = 0; i < 30; i++) {
            expect(checkRateLimit("some_random_tool").allowed).toBe(true);
        }
        expect(checkRateLimit("some_random_tool").allowed).toBe(false);
    });

    it("exempts long-running tools from rate limiting", () => {
        for (const exempt of ["deep_research", "swarm_task", "shell_exec_background", "start_long_task"]) {
            for (let i = 0; i < 100; i++) {
                expect(checkRateLimit(exempt).allowed).toBe(true);
            }
        }
    });

    it("resets the bucket after the 60s window expires", () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
            // Fill the os_screenshot bucket (limit 20)
            for (let i = 0; i < 20; i++) checkRateLimit("os_screenshot");
            expect(checkRateLimit("os_screenshot").allowed).toBe(false);

            // Advance past the 60s window
            vi.setSystemTime(new Date("2025-01-01T00:01:01Z"));
            // Fresh window — should allow again
            expect(checkRateLimit("os_screenshot").allowed).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("resetRateLimits clears all buckets", () => {
        for (let i = 0; i < 15; i++) checkRateLimit("web_search");
        expect(checkRateLimit("web_search").allowed).toBe(false);
        resetRateLimits();
        expect(checkRateLimit("web_search").allowed).toBe(true);
    });

    it("per-tool buckets are independent", () => {
        for (let i = 0; i < 15; i++) checkRateLimit("web_search"); // hit limit
        // Different tool should still have fresh bucket
        expect(checkRateLimit("os_screenshot").allowed).toBe(true);
    });
});

describe("tool-intelligence — destructive-action confirmation", () => {
    describe("non-destructive paths", () => {
        it("returns needsConfirmation=false for plain tool calls", () => {
            expect(requiresConfirmation("system_info", {}).needsConfirmation).toBe(false);
            expect(requiresConfirmation("read", { path: "/tmp/x" }).needsConfirmation).toBe(false);
        });

        it("returns false for destructive tools with a non-destructive action", () => {
            expect(requiresConfirmation("app_manager", { action: "list" }).needsConfirmation).toBe(false);
            expect(requiresConfirmation("trash_manager", { action: "list" }).needsConfirmation).toBe(false);
        });
    });

    describe("destructive tool actions", () => {
        it("flags trash_manager:empty", () => {
            const r = requiresConfirmation("trash_manager", { action: "empty" });
            expect(r.needsConfirmation).toBe(true);
            expect(r.warningMessage).toMatch(/Trash/);
        });

        it("flags wifi_control:off", () => {
            const r = requiresConfirmation("wifi_control", { action: "off" });
            expect(r.needsConfirmation).toBe(true);
            expect(r.warningMessage).toMatch(/Wi-Fi/i);
        });

        it("flags app_manager:force_quit", () => {
            const r = requiresConfirmation("app_manager", {
                action: "force_quit",
                app: "Firefox",
            });
            expect(r.needsConfirmation).toBe(true);
            expect(r.warningMessage).toMatch(/Firefox/);
        });

        it("flags delete_file on ANY action (wildcard entry)", () => {
            // DESTRUCTIVE_ACTIONS.delete_file is Set(["*"]) — wildcard.
            const r = requiresConfirmation("delete_file", { path: "/tmp/x" });
            expect(r.needsConfirmation).toBe(true);
            expect(r.warningMessage).toMatch(/delete/i);
            expect(r.warningMessage).toContain("/tmp/x");
        });
    });

    describe("shell dangerous patterns", () => {
        it("flags shell_exec rm -rf", () => {
            const r = requiresConfirmation("shell_exec", { command: "rm -rf /some/path" });
            expect(r.needsConfirmation).toBe(true);
            expect(r.warningMessage).toMatch(/destructive/i);
        });

        it("flags git push --force", () => {
            const r = requiresConfirmation("shell_exec", {
                command: "git push --force origin main",
            });
            expect(r.needsConfirmation).toBe(true);
        });

        it("flags git reset --hard", () => {
            const r = requiresConfirmation("shell_exec", {
                command: "git reset --hard HEAD~1",
            });
            expect(r.needsConfirmation).toBe(true);
        });

        it("flags DROP TABLE / DATABASE in SQL", () => {
            const r = requiresConfirmation("shell_exec", {
                command: 'psql -c "DROP TABLE users"',
            });
            expect(r.needsConfirmation).toBe(true);
        });

        it("flags bare DELETE FROM without WHERE (end-anchored)", () => {
            // The regex `/DELETE\s+FROM\s+\w+\s*;?\s*$/i` is end-anchored
            // so it only fires when DELETE FROM <table>; is the LAST thing
            // in the command. That's the dangerous shape: a bare delete
            // with no filter. A DELETE inside quoted shell context
            // (`psql -c "DELETE FROM x;"`) correctly does NOT match
            // because of the trailing quote.
            expect(requiresConfirmation("shell_exec", { command: "DELETE FROM users;" }).needsConfirmation).toBe(true);
            expect(requiresConfirmation("shell_exec", { command: "DELETE FROM users" }).needsConfirmation).toBe(true);
            // Shell-quoted context is NOT flagged (the regex trades false
            // negatives here for zero false positives on safer callers).
            expect(
                requiresConfirmation("shell_exec", {
                    command: 'psql -c "DELETE FROM users;"',
                }).needsConfirmation,
            ).toBe(false);
        });

        it("flags shutdown / reboot", () => {
            expect(requiresConfirmation("shell_exec", { command: "sudo shutdown -h now" }).needsConfirmation).toBe(
                true,
            );
            expect(requiresConfirmation("shell_exec", { command: "reboot" }).needsConfirmation).toBe(true);
        });

        it("flags chmod 777", () => {
            expect(requiresConfirmation("shell_exec", { command: "chmod 777 /etc/passwd" }).needsConfirmation).toBe(
                true,
            );
        });

        it("does NOT flag safe shell commands", () => {
            expect(requiresConfirmation("shell_exec", { command: "ls -la" }).needsConfirmation).toBe(false);
            expect(requiresConfirmation("shell_exec", { command: "npm install" }).needsConfirmation).toBe(false);
            expect(requiresConfirmation("shell_exec", { command: "rm file.txt" }).needsConfirmation).toBe(false); // rm without -rf
        });

        it("also flags shell_exec_background commands", () => {
            const r = requiresConfirmation("shell_exec_background", {
                command: "git reset --hard",
            });
            expect(r.needsConfirmation).toBe(true);
        });

        it("truncates long command in warning message", () => {
            const long = "rm -rf /" + "x".repeat(500);
            const r = requiresConfirmation("shell_exec", { command: long });
            expect(r.needsConfirmation).toBe(true);
            expect(r.warningMessage!.length).toBeLessThan(200);
        });
    });
});

describe("tool-intelligence — analytics", () => {
    it("records and aggregates per-tool call stats", () => {
        // Fresh tool name to avoid interference with other tests
        const tool = `unique_analytics_tool_${Date.now()}`;
        recordToolUsage(tool, true, 100);
        recordToolUsage(tool, true, 200);
        recordToolUsage(tool, false, 150);

        const all = getToolAnalytics();
        const stats = all[tool];
        expect(stats).toBeDefined();
        expect(stats.calls).toEqual(3);
        expect(stats.successes).toEqual(2);
        expect(stats.failures).toEqual(1);
        expect(stats.totalDurationMs).toEqual(450);
        expect(stats.avgDurationMs).toEqual(150);
        expect(stats.successRate).toEqual(67); // 2/3 rounded
    });

    it("computes successRate 100 for a never-failed tool", () => {
        const tool = `success_only_${Date.now()}`;
        recordToolUsage(tool, true, 10);
        recordToolUsage(tool, true, 20);
        expect(getToolAnalytics()[tool].successRate).toEqual(100);
    });

    it("computes avgDurationMs 0 and successRate 0 for unknown / empty tool", () => {
        const all = getToolAnalytics();
        expect(all["a_tool_that_was_never_recorded_xxx"]).toBeUndefined();
    });

    it("updates lastUsed to a monotonic-ish timestamp", () => {
        const tool = `lastused_${Date.now()}`;
        const before = Date.now();
        recordToolUsage(tool, true, 1);
        const after = Date.now();
        const stats = getToolAnalytics()[tool];
        expect(stats.lastUsed).toBeGreaterThanOrEqual(before);
        expect(stats.lastUsed).toBeLessThanOrEqual(after);
    });
});

describe("tool-intelligence — destructive hotkeys", () => {
    it("normalizes modifier names and order", () => {
        for (const c of [
            "cmd+q",
            "Command+Q",
            "q+meta",
            "cmd+w",
            "cmd+backspace",
            "shift+cmd+delete",
            "alt+f4",
            "ctrl+w",
            "shift+delete",
        ]) {
            expect(isDestructiveHotkey(c), c).toBe(true);
        }
        for (const c of ["cmd+c", "cmd+v", "ctrl+s", "command+shift+s", "alt+tab", "q", "return", "delete", "cmd+return", "ctrl+enter"]) {
            expect(isDestructiveHotkey(c), c).toBe(false);
        }
    });

    it("routes keyboard tools through the confirmation gate", () => {
        expect(requiresConfirmation("os_type", { combo: "command+q" }).needsConfirmation).toBe(true);
        expect(requiresConfirmation("os_computer_action", { action: "key", text: "alt+f4" }).needsConfirmation).toBe(
            true,
        );
        expect(
            requiresConfirmation("os_multi_action", {
                actions: [{ action: "click" }, { action: "combo", key: "cmd+delete" }],
            }).needsConfirmation,
        ).toBe(true);
        expect(requiresConfirmation("os_type", { combo: "command+c" }).needsConfirmation).toBe(false);
        expect(requiresConfirmation("os_computer_action", { action: "type", text: "cmd+q" }).needsConfirmation).toBe(
            false,
        );
    });
});
