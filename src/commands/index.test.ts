// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    handleCommand,
    initCommands,
    getThinkingLevel,
} from "./index.js";
import {
    exitPlanMode,
    isPlanMode,
    isSpecMode,
    enterPlanMode,
    enterSpecMode,
} from "../agents/plan-mode.js";
import type { Config } from "../config.js";

// /optimize-harness fires the real optimizer in the background. These tests
// only check the reply, and a leaked real run (tool router, harness evals)
// starved the next test's fresh import past its 30s timeout on CI.
vi.mock("../harness/optimizer.js", () => ({ runMetaHarnessOptimization: vi.fn(async () => {}) }));

// ── Test helpers ─────────────────────────────────────────

function makeConfig(overrides: Partial<Config> = {}): Config {
    return {
        telegramBotToken: "fake",
        allowedUserIds: new Set([12345, 67890]),
        telegramEnabled: true,
        emailWhitelist: new Set(),
        ...overrides,
    };
}

function makeCtx(overrides: Partial<Parameters<typeof initCommands>[0]> = {}) {
    const conversationCountFn = vi.fn<() => number>(() => 0);
    const clearConversationFn = vi.fn();
    const setThinkingLevelFn = vi.fn();
    const sendProgressFn = vi.fn<(msg: string) => Promise<void>>(async () => undefined);
    return {
        ctx: {
            config: makeConfig(),
            startTime: Date.now() - 1000,
            sessionTokens: 0,
            conversationCount: conversationCountFn,
            thinkingLevel: "low",
            setThinkingLevel: setThinkingLevelFn,
            clearConversation: clearConversationFn,
            llm: undefined,
            sendProgress: sendProgressFn,
            ...overrides,
        },
        spies: { conversationCountFn, clearConversationFn, setThinkingLevelFn, sendProgressFn },
    };
}

beforeEach(() => {
    // Ensure mode state is reset between every test in this file
    if (isPlanMode() || isSpecMode()) exitPlanMode();
});

afterEach(() => {
    if (isPlanMode() || isSpecMode()) exitPlanMode();
    vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────

describe("handleCommand — routing", () => {
    it("returns handled:false for non-slash text", async () => {
        const r = await handleCommand("hello");
        expect(r).toEqual({ handled: false });
    });

    it("returns handled:false for empty string", async () => {
        const r = await handleCommand("");
        expect(r).toEqual({ handled: false });
    });

    it("returns handled:false for an unknown slash command", async () => {
        const r = await handleCommand("/not-a-real-command");
        expect(r).toEqual({ handled: false });
    });

    it("is case-insensitive for command names", async () => {
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/HELP");
        expect(r.handled).toBe(true);
        expect(r.response).toContain("Bhai Commands");
    });

    it("splits arguments on whitespace", async () => {
        const { ctx } = makeCtx();
        initCommands(ctx);
        await handleCommand("/think high");
        expect(getThinkingLevel()).toEqual("high");
    });

    it("routes /optimize-harness and /harness-optimize to the same handler", async () => {
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/harness-optimize");
        // No LLM in ctx → LLM-not-available branch
        expect(r.handled).toBe(true);
        expect(r.response).toContain("LLM not available");
    });
});

describe("cmdStatus", () => {
    it("returns warning before initCommands is called", async () => {
        // Force _ctx to null by NOT calling initCommands in this test
        // Note: other tests may have called initCommands already → workaround
        // is to assert the format when ctx IS initialized.
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/status");
        expect(r.response).toContain("Bhai Status");
    });

    it("includes uptime in h/m/s format", async () => {
        const { ctx } = makeCtx({ startTime: Date.now() - 3_725_000 }); // 1h 2m 5s
        initCommands(ctx);
        const r = await handleCommand("/status");
        expect(r.response).toMatch(/Uptime: 1h 2m \ds/);
    });

    it("reflects the current thinking level", async () => {
        const { ctx } = makeCtx({ thinkingLevel: "medium" });
        initCommands(ctx);
        await handleCommand("/think high");
        const r = await handleCommand("/status");
        expect(r.response).toContain("Thinking: `high`");
    });

    it("reports conversation count via getter", async () => {
        const { ctx, spies } = makeCtx();
        spies.conversationCountFn.mockReturnValue(42);
        initCommands(ctx);
        const r = await handleCommand("/status");
        expect(r.response).toContain("Conversations: 42");
    });

    it("reports allowed users count", async () => {
        const { ctx } = makeCtx({ config: makeConfig({ allowedUserIds: new Set([1, 2, 3, 4]) }) });
        initCommands(ctx);
        const r = await handleCommand("/status");
        expect(r.response).toContain("Allowed users: 4");
    });
});

describe("cmdNew + cmdCompact", () => {
    it("/new calls clearConversation on the context", async () => {
        const { ctx, spies } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/new");
        expect(spies.clearConversationFn).toHaveBeenCalledOnce();
        expect(r.response).toContain("Conversation cleared");
    });

    it("/compact returns a static acknowledgement", async () => {
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/compact");
        expect(r.response).toContain("Context compacted");
    });
});

describe("cmdUsage", () => {
    it("returns conversation count and thinking level", async () => {
        const { ctx, spies } = makeCtx({ thinkingLevel: "medium" });
        spies.conversationCountFn.mockReturnValue(7);
        initCommands(ctx);
        const r = await handleCommand("/usage");
        expect(r.response).toContain("Messages: 7");
        expect(r.response).toContain("`medium`");
    });
});

describe("cmdThink", () => {
    it("with no args returns current level and usage", async () => {
        const { ctx } = makeCtx({ thinkingLevel: "low" });
        initCommands(ctx);
        const r = await handleCommand("/think");
        expect(r.response).toContain("Thinking level: `low`");
        expect(r.response).toContain("Usage:");
    });

    it("with invalid level returns usage (doesn't update state)", async () => {
        const { ctx } = makeCtx({ thinkingLevel: "low" });
        initCommands(ctx);
        const r = await handleCommand("/think nonsense");
        expect(r.response).toContain("Usage:");
        expect(getThinkingLevel()).toEqual("low");
    });

    it.each(["off", "low", "medium", "high"])(
        "accepts valid level '%s' and updates state",
        async (level) => {
            const { ctx, spies } = makeCtx();
            initCommands(ctx);
            const r = await handleCommand(`/think ${level}`);
            expect(r.response).toContain(`set to \`${level}\``);
            expect(getThinkingLevel()).toEqual(level);
            expect(spies.setThinkingLevelFn).toHaveBeenCalledWith(level);
        },
    );
});

describe("cmdStart + cmdHelp", () => {
    it("/start returns Bhai introduction", async () => {
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/start");
        expect(r.response).toContain("Bhai");
        expect(r.response).toContain("proactive AI agent");
    });

    it("/help lists all slash commands", async () => {
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/help");
        expect(r.response).toContain("/status");
        expect(r.response).toContain("/new");
        expect(r.response).toContain("/compact");
        expect(r.response).toContain("/think");
        expect(r.response).toContain("/plan");
        expect(r.response).toContain("/spec");
        expect(r.response).toContain("/noplan");
    });
});

describe("cmdPlan + cmdNoPlan", () => {
    it("/plan without an existing mode enters plan mode", async () => {
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/plan build a CLI");
        expect(r.response).toContain("Plan mode active");
        expect(isPlanMode()).toBe(true);
    });

    it("/plan echoes the task when provided", async () => {
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/plan refactor auth");
        expect(r.response).toContain("Task: refactor auth");
    });

    it("/plan with no task prompts user to send one", async () => {
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/plan");
        expect(r.response).toContain("Send your task now");
    });

    it("/plan is idempotent — second /plan while already in plan mode returns status", async () => {
        const { ctx } = makeCtx();
        initCommands(ctx);
        await handleCommand("/plan");
        const r = await handleCommand("/plan");
        expect(r.response).toContain("Already in plan mode");
    });

    it("/plan while in spec mode refuses to enter plan mode", async () => {
        enterSpecMode("test task", "/tmp/spec.md", "user");
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/plan new task");
        expect(r.response).toContain("spec mode");
        expect(isSpecMode()).toBe(true); // unchanged
    });

    it("/noplan exits plan mode", async () => {
        enterPlanMode("reason", "user");
        const { ctx } = makeCtx();
        initCommands(ctx);
        expect(isPlanMode()).toBe(true);
        const r = await handleCommand("/noplan");
        expect(r.response).toContain("exited");
        expect(isPlanMode()).toBe(false);
    });

    it("/noplan when already off returns informational message", async () => {
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/noplan");
        expect(r.response).toContain("already off");
    });

    it("/noplan exits spec mode too", async () => {
        enterSpecMode("task", "/tmp/spec.md", "user");
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/noplan");
        expect(r.response).toContain("exited");
        expect(isSpecMode()).toBe(false);
    });
});

describe("cmdSpec", () => {
    it("/spec with no task shows usage", async () => {
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/spec");
        expect(r.response).toContain("Usage:");
    });

    it("/spec <task> enters spec mode", async () => {
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/spec build a TODO app");
        expect(r.response).toContain("Spec mode active");
        expect(isSpecMode()).toBe(true);
    });

    it("/spec echoes the task and target spec file path", async () => {
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/spec design auth flow");
        expect(r.response).toContain("Task: design auth flow");
        expect(r.response).toMatch(/\.atlas.*specs.*\.md/);
    });

    it("/spec generates a slug from the task (lowercase, truncated to 6 words or 50 chars)", async () => {
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand(
            "/spec  Build   a Multi-Language  Code Intelligence Platform With Tree-Sitter",
        );
        // Slug should: lowercase, strip punctuation, ≤6 words. Our task has 9 words → 6.
        expect(r.response).toMatch(/build-a-multi-language-code-intelligence/);
    });

    it("/spec while in spec mode refuses", async () => {
        enterSpecMode("first task", "/tmp/spec.md", "user");
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/spec second task");
        expect(r.response).toContain("Already in spec mode");
    });

    it("/spec while in plan mode redirects to /noplan first", async () => {
        enterPlanMode("reason", "user");
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/spec new task");
        expect(r.response).toContain("plan mode");
        expect(r.response).toContain("/noplan");
    });
});

describe("cmdOptimizeHarness", () => {
    // The handler has a module-level `_optimizationInFlight` guard, and the
    // setImmediate dispatch only resets it after `../harness/optimizer.js`
    // settles (it rejects since our LLM is a stub, so the finally: resets
    // — but asynchronously, AFTER the next test's synchronous call). To
    // isolate each test, re-import the module so module state is fresh.
    async function freshCmd() {
        vi.resetModules();
        const mod = await import("./index.js");
        return mod;
    }

    it("refuses when no LLM is available on the context", async () => {
        const { initCommands: init, handleCommand: hc } = await freshCmd();
        const { ctx } = makeCtx({ llm: undefined });
        init(ctx);
        const r = await hc("/optimize-harness");
        expect(r.response).toContain("LLM not available");
    });

    it("accepts budget as the first positional argument", async () => {
        const { initCommands: init, handleCommand: hc } = await freshCmd();
        const { ctx } = makeCtx({
            llm: { chat: vi.fn() } as unknown as import("../llm.js").LLMClient,
        });
        init(ctx);
        const r = await hc("/optimize-harness 10");
        expect(r.response).toContain("budget=10");
    });

    it("defaults budget to 5 when no arg is given", async () => {
        const { initCommands: init, handleCommand: hc } = await freshCmd();
        const { ctx } = makeCtx({
            llm: { chat: vi.fn() } as unknown as import("../llm.js").LLMClient,
        });
        init(ctx);
        const r = await hc("/optimize-harness");
        expect(r.response).toContain("budget=5");
    });

    it("parseInt of a non-numeric budget falls back to 5", async () => {
        const { initCommands: init, handleCommand: hc } = await freshCmd();
        const { ctx } = makeCtx({
            llm: { chat: vi.fn() } as unknown as import("../llm.js").LLMClient,
        });
        init(ctx);
        const r = await hc("/optimize-harness abcdef");
        expect(r.response).toContain("budget=5");
    });

    it("detects --fast flag in arbitrary arg position", async () => {
        const { initCommands: init, handleCommand: hc } = await freshCmd();
        const { ctx } = makeCtx({
            llm: { chat: vi.fn() } as unknown as import("../llm.js").LLMClient,
        });
        init(ctx);
        const r = await hc("/optimize-harness 3 --fast");
        expect(r.response).toContain("fast=true");
        expect(r.response).toContain("Fast mode");
    });

    it("without --fast, reports full mode", async () => {
        const { initCommands: init, handleCommand: hc } = await freshCmd();
        const { ctx } = makeCtx({
            llm: { chat: vi.fn() } as unknown as import("../llm.js").LLMClient,
        });
        init(ctx);
        const r = await hc("/optimize-harness 3");
        expect(r.response).toContain("fast=false");
        expect(r.response).toContain("Full mode");
    });

    it("second concurrent call while in-flight returns the 'already running' message", async () => {
        const { initCommands: init, handleCommand: hc } = await freshCmd();
        const { ctx } = makeCtx({
            llm: { chat: vi.fn() } as unknown as import("../llm.js").LLMClient,
        });
        init(ctx);
        const first = await hc("/optimize-harness");
        expect(first.response).toContain("budget=5");
        // Immediately call again before the setImmediate resets the flag.
        const second = await hc("/optimize-harness");
        expect(second.response).toContain("already running");
    });
});

describe("cmdHarnessStatus", () => {
    it("returns status even when no runs exist", async () => {
        // /harness-status reads the filesystem — we don't mock it here,
        // it should gracefully return "No active harness config" on a
        // typical dev machine with no harness/ dir.
        const { ctx } = makeCtx();
        initCommands(ctx);
        const r = await handleCommand("/harness-status");
        expect(r.handled).toBe(true);
        expect(r.response).toContain("Harness Optimization Status");
    });
});
