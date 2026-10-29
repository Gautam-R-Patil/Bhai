// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach } from "vitest";
import {
    isPlanMode,
    isSpecMode,
    isAwaitingApproval,
    getPlanModeState,
    enterPlanMode,
    exitPlanMode,
    enterSpecMode,
    specToPlan,
    enterAwaitingApproval,
    approveAndExit,
    onPlanModeChange,
    PLAN_MODE_ALLOWED_TOOLS,
    SPEC_MODE_ALLOWED_TOOLS,
    AWAITING_APPROVAL_ALLOWED_TOOLS,
    filterToolsForPlanMode,
    filterToolsForSpecMode,
    filterToolsForAwaitingApproval,
    isToolAllowedInCurrentMode,
    checkWritePathInApprovalMode,
    planModeReminderBody,
} from "./plan-mode.js";

// Plan-mode state is module-level — reset to "act" before every test.
beforeEach(() => {
    exitPlanMode();
});

// Helpers
function tool(name: string) {
    return { function: { name }, type: "function" as const };
}

// ── State machine ────────────────────────────────────────

describe("plan-mode — initial state", () => {
    it("starts in act mode", () => {
        expect(getPlanModeState().mode).toEqual("act");
        expect(isPlanMode()).toBe(false);
        expect(isSpecMode()).toBe(false);
        expect(isAwaitingApproval()).toBe(false);
    });
});

describe("plan-mode — enterPlanMode", () => {
    it("transitions to plan mode with reason and source", () => {
        enterPlanMode("test reason", "user");
        const s = getPlanModeState();
        expect(s.mode).toEqual("plan");
        if (s.mode === "plan") {
            expect(s.reason).toEqual("test reason");
            expect(s.source).toEqual("user");
            expect(s.enteredAt).toBeGreaterThan(0);
        }
        expect(isPlanMode()).toBe(true);
    });

    it("defaults source to 'user' when omitted", () => {
        enterPlanMode("reason");
        const s = getPlanModeState();
        if (s.mode === "plan") {
            expect(s.source).toEqual("user");
        }
    });

    it("accepts 'auto' source for agent-initiated plan mode", () => {
        enterPlanMode("triggered by uncertainty", "auto");
        const s = getPlanModeState();
        if (s.mode === "plan") {
            expect(s.source).toEqual("auto");
        }
    });

    it("overwriting plan mode with a new reason works (no crash, updates state)", () => {
        enterPlanMode("first");
        enterPlanMode("second");
        const s = getPlanModeState();
        if (s.mode === "plan") {
            expect(s.reason).toEqual("second");
        }
    });
});

describe("plan-mode — exitPlanMode", () => {
    it("from plan → act", () => {
        enterPlanMode("test");
        exitPlanMode();
        expect(getPlanModeState().mode).toEqual("act");
    });

    it("from spec → act", () => {
        enterSpecMode("task", "/tmp/spec.md");
        exitPlanMode();
        expect(getPlanModeState().mode).toEqual("act");
    });

    it("from awaiting_approval → act", () => {
        enterAwaitingApproval("task", "/tmp/docs");
        exitPlanMode();
        expect(getPlanModeState().mode).toEqual("act");
    });

    it("from act → act (no-op, no crash)", () => {
        exitPlanMode();
        exitPlanMode();
        expect(getPlanModeState().mode).toEqual("act");
    });
});

describe("plan-mode — enterSpecMode", () => {
    it("transitions to spec mode with task + specPath", () => {
        enterSpecMode("build X", "/tmp/spec.md", "user");
        const s = getPlanModeState();
        expect(s.mode).toEqual("spec");
        if (s.mode === "spec") {
            expect(s.task).toEqual("build X");
            expect(s.specPath).toEqual("/tmp/spec.md");
        }
        expect(isSpecMode()).toBe(true);
    });

    it("defaults source to 'user'", () => {
        enterSpecMode("task", "/tmp/spec.md");
        const s = getPlanModeState();
        if (s.mode === "spec") expect(s.source).toEqual("user");
    });
});

describe("plan-mode — specToPlan", () => {
    it("transitions spec → plan with a new reason", () => {
        enterSpecMode("task", "/tmp/spec.md");
        specToPlan("finalized spec");
        const s = getPlanModeState();
        expect(s.mode).toEqual("plan");
        if (s.mode === "plan") expect(s.reason).toEqual("finalized spec");
    });

    it("defaults source to 'auto' (agent-driven transition)", () => {
        enterSpecMode("task", "/tmp/spec.md");
        specToPlan("reason");
        const s = getPlanModeState();
        if (s.mode === "plan") expect(s.source).toEqual("auto");
    });

    it("can explicitly mark as user-driven", () => {
        enterSpecMode("task", "/tmp/spec.md");
        specToPlan("reason", "user");
        const s = getPlanModeState();
        if (s.mode === "plan") expect(s.source).toEqual("user");
    });
});

describe("plan-mode — enterAwaitingApproval + approveAndExit", () => {
    it("transitions to awaiting_approval with task + designDocsDir", () => {
        enterAwaitingApproval("new auth flow", "/workspace/design-docs/auth");
        const s = getPlanModeState();
        expect(s.mode).toEqual("awaiting_approval");
        if (s.mode === "awaiting_approval") {
            expect(s.task).toEqual("new auth flow");
            expect(s.designDocsDir).toEqual("/workspace/design-docs/auth");
        }
        expect(isAwaitingApproval()).toBe(true);
    });

    it("approveAndExit transitions awaiting_approval → act", () => {
        enterAwaitingApproval("task", "/tmp/docs");
        approveAndExit();
        expect(getPlanModeState().mode).toEqual("act");
    });

    it("defaults source to 'auto'", () => {
        enterAwaitingApproval("task", "/tmp/docs");
        const s = getPlanModeState();
        if (s.mode === "awaiting_approval") expect(s.source).toEqual("auto");
    });
});

// ── Listeners ────────────────────────────────────────────

describe("plan-mode — onPlanModeChange listeners", () => {
    it("fires the listener when mode changes", () => {
        let received = "";
        const off = onPlanModeChange((s) => {
            received = s.mode;
        });
        enterPlanMode("r");
        expect(received).toEqual("plan");
        off();
    });

    it("returns an unsubscribe function", () => {
        let count = 0;
        const off = onPlanModeChange(() => count++);
        enterPlanMode("r");
        expect(count).toEqual(1);
        off();
        enterSpecMode("task", "/tmp/spec");
        // After unsubscribe, the listener shouldn't fire.
        expect(count).toEqual(1);
    });

    it("swallows listener errors (agent flow must not break)", () => {
        const off = onPlanModeChange(() => {
            throw new Error("listener crashed");
        });
        // This should NOT throw.
        expect(() => enterPlanMode("r")).not.toThrow();
        off();
    });

    it("supports multiple listeners", () => {
        const received: string[] = [];
        const off1 = onPlanModeChange((s) => received.push(`A:${s.mode}`));
        const off2 = onPlanModeChange((s) => received.push(`B:${s.mode}`));
        enterPlanMode("r");
        expect(received).toEqual(["A:plan", "B:plan"]);
        off1();
        off2();
    });
});

// ── Tool allowlists ──────────────────────────────────────

describe("plan-mode — allowlist sets", () => {
    it("PLAN_MODE_ALLOWED_TOOLS includes core reads and NOT writes", () => {
        expect(PLAN_MODE_ALLOWED_TOOLS.has("read")).toBe(true);
        expect(PLAN_MODE_ALLOWED_TOOLS.has("grep")).toBe(true);
        expect(PLAN_MODE_ALLOWED_TOOLS.has("web_search")).toBe(true);
        expect(PLAN_MODE_ALLOWED_TOOLS.has("exit_plan_mode")).toBe(true);
        // Writes are NOT allowed
        expect(PLAN_MODE_ALLOWED_TOOLS.has("write")).toBe(false);
        expect(PLAN_MODE_ALLOWED_TOOLS.has("edit")).toBe(false);
        expect(PLAN_MODE_ALLOWED_TOOLS.has("shell_exec")).toBe(false);
    });

    it("SPEC_MODE_ALLOWED_TOOLS extends plan with write + finalize_spec", () => {
        // Superset of plan
        for (const t of PLAN_MODE_ALLOWED_TOOLS) {
            expect(SPEC_MODE_ALLOWED_TOOLS.has(t)).toBe(true);
        }
        expect(SPEC_MODE_ALLOWED_TOOLS.has("write")).toBe(true);
        expect(SPEC_MODE_ALLOWED_TOOLS.has("append_file")).toBe(true);
        expect(SPEC_MODE_ALLOWED_TOOLS.has("finalize_spec")).toBe(true);
        // But not shell_exec or edit
        expect(SPEC_MODE_ALLOWED_TOOLS.has("shell_exec")).toBe(false);
        expect(SPEC_MODE_ALLOWED_TOOLS.has("edit")).toBe(false);
    });

    it("AWAITING_APPROVAL_ALLOWED_TOOLS extends plan with write/edit/send/approve", () => {
        for (const t of PLAN_MODE_ALLOWED_TOOLS) {
            expect(AWAITING_APPROVAL_ALLOWED_TOOLS.has(t)).toBe(true);
        }
        expect(AWAITING_APPROVAL_ALLOWED_TOOLS.has("edit")).toBe(true);
        expect(AWAITING_APPROVAL_ALLOWED_TOOLS.has("write")).toBe(true);
        expect(AWAITING_APPROVAL_ALLOWED_TOOLS.has("approve_design_docs")).toBe(true);
        expect(AWAITING_APPROVAL_ALLOWED_TOOLS.has("generate_design_docs")).toBe(true);
        expect(AWAITING_APPROVAL_ALLOWED_TOOLS.has("render_md_to_pdf")).toBe(true);
        // But not implementation tools
        expect(AWAITING_APPROVAL_ALLOWED_TOOLS.has("shell_exec")).toBe(false);
        expect(AWAITING_APPROVAL_ALLOWED_TOOLS.has("test_run")).toBe(false);
    });
});

describe("plan-mode — filterToolsForPlanMode", () => {
    const tools = [tool("read"), tool("write"), tool("grep"), tool("shell_exec"), tool("web_search")];

    it("filters out tools not on the plan allowlist", () => {
        const result = filterToolsForPlanMode(tools);
        expect(result.map((t) => t.function.name)).toEqual(["read", "grep", "web_search"]);
    });

    it("preserves input order", () => {
        const reordered = [tool("web_search"), tool("write"), tool("read")];
        expect(filterToolsForPlanMode(reordered).map((t) => t.function.name)).toEqual([
            "web_search",
            "read",
        ]);
    });

    it("returns an empty array if no tools match", () => {
        expect(filterToolsForPlanMode([tool("write"), tool("shell_exec")])).toEqual([]);
    });

    it("does not mutate the input", () => {
        const input = [tool("read"), tool("write")];
        filterToolsForPlanMode(input);
        expect(input.length).toEqual(2);
    });
});

describe("plan-mode — filterToolsForSpecMode", () => {
    it("allows write and finalize_spec in addition to reads", () => {
        const tools = [tool("read"), tool("write"), tool("finalize_spec"), tool("shell_exec")];
        const result = filterToolsForSpecMode(tools).map((t) => t.function.name);
        expect(result).toContain("read");
        expect(result).toContain("write");
        expect(result).toContain("finalize_spec");
        expect(result).not.toContain("shell_exec");
    });
});

describe("plan-mode — filterToolsForAwaitingApproval", () => {
    it("allows write/edit plus approval tools", () => {
        const tools = [
            tool("read"),
            tool("write"),
            tool("edit"),
            tool("approve_design_docs"),
            tool("test_run"),
        ];
        const result = filterToolsForAwaitingApproval(tools).map((t) => t.function.name);
        expect(result).toContain("read");
        expect(result).toContain("write");
        expect(result).toContain("edit");
        expect(result).toContain("approve_design_docs");
        expect(result).not.toContain("test_run");
    });
});

// ── Runtime tool gate ────────────────────────────────────

describe("plan-mode — isToolAllowedInCurrentMode", () => {
    it("in act mode: every tool is allowed", () => {
        expect(isToolAllowedInCurrentMode("shell_exec")).toBe(true);
        expect(isToolAllowedInCurrentMode("anything")).toBe(true);
    });

    it("in plan mode: only plan-allowed tools pass", () => {
        enterPlanMode("test");
        expect(isToolAllowedInCurrentMode("read")).toBe(true);
        expect(isToolAllowedInCurrentMode("shell_exec")).toBe(false);
        expect(isToolAllowedInCurrentMode("write")).toBe(false);
    });

    it("in spec mode: plan tools + write + finalize_spec pass", () => {
        enterSpecMode("task", "/tmp/spec.md");
        expect(isToolAllowedInCurrentMode("read")).toBe(true);
        expect(isToolAllowedInCurrentMode("write")).toBe(true);
        expect(isToolAllowedInCurrentMode("finalize_spec")).toBe(true);
        expect(isToolAllowedInCurrentMode("shell_exec")).toBe(false);
    });

    it("in awaiting_approval mode: plan tools + edit + approve pass", () => {
        enterAwaitingApproval("task", "/tmp/docs");
        expect(isToolAllowedInCurrentMode("edit")).toBe(true);
        expect(isToolAllowedInCurrentMode("approve_design_docs")).toBe(true);
        expect(isToolAllowedInCurrentMode("test_run")).toBe(false);
    });
});

// ── Path gate in awaiting_approval ───────────────────────

describe("plan-mode — checkWritePathInApprovalMode", () => {
    it("returns allowed:true when NOT in awaiting_approval (state is irrelevant)", () => {
        // act mode
        expect(checkWritePathInApprovalMode("/any/path").allowed).toBe(true);
        // plan mode — same story
        enterPlanMode("x");
        expect(checkWritePathInApprovalMode("/any/path").allowed).toBe(true);
    });

    it("returns allowed:true for paths inside designDocsDir", () => {
        enterAwaitingApproval("task", "/workspace/design-docs/auth");
        const r = checkWritePathInApprovalMode("/workspace/design-docs/auth/PRD.md");
        expect(r.allowed).toBe(true);
    });

    it("returns allowed:true when absPath is exactly designDocsDir", () => {
        enterAwaitingApproval("task", "/workspace/design-docs/auth");
        const r = checkWritePathInApprovalMode("/workspace/design-docs/auth");
        expect(r.allowed).toBe(true);
    });

    it("returns allowed:false for paths outside designDocsDir", () => {
        enterAwaitingApproval("task", "/workspace/design-docs/auth");
        const r = checkWritePathInApprovalMode("/workspace/src/index.ts");
        expect(r.allowed).toBe(false);
        expect(r.reason).toContain("/workspace/design-docs/auth");
    });

    it("blocks sibling directories with a similar prefix", () => {
        // /auth vs /auth-v2 should NOT be allowed just because of substring prefix.
        enterAwaitingApproval("task", "/workspace/design-docs/auth");
        const r = checkWritePathInApprovalMode("/workspace/design-docs/auth-v2/PRD.md");
        expect(r.allowed).toBe(false);
    });

    it("normalizes Windows-style backslash paths", () => {
        // Windows-only: with realpath-based resolution, backslash semantics
        // only hold under win32. On posix the path "C:\workspace\..." is a
        // bogus relative segment and resolves through CWD — the new gate
        // correctly refuses it, which is desired behaviour.
        if (process.platform !== "win32") return;
        enterAwaitingApproval("task", "C:\\workspace\\design-docs\\auth");
        const r = checkWritePathInApprovalMode("C:\\workspace\\design-docs\\auth\\PRD.md");
        expect(r.allowed).toBe(true);
    });

    it("blocks forward-slash path trying to escape a backslash designDocsDir", () => {
        enterAwaitingApproval("task", "C:\\workspace\\design-docs\\auth");
        const r = checkWritePathInApprovalMode("C:/some/other/place/code.ts");
        expect(r.allowed).toBe(false);
    });
});

// ── Reminder body ────────────────────────────────────────

describe("plan-mode — planModeReminderBody", () => {
    it("returns empty string when in act mode", () => {
        expect(planModeReminderBody()).toEqual("");
    });

    it("plan-mode body mentions plan mode and exit tool", () => {
        enterPlanMode("build X");
        const body = planModeReminderBody();
        expect(body).toContain("Plan mode is active");
        expect(body).toContain("exit_plan_mode");
        // Does NOT leak the internal reason text (prompt economy — reminder
        // is a fixed sentence, not a parameterized user-quote)
        expect(body).not.toContain("build X");
    });

    it("spec-mode body includes task and spec path", () => {
        enterSpecMode("build auth", "/workspace/.atlas/specs/build-auth.md");
        const body = planModeReminderBody();
        expect(body).toContain("Spec mode is active");
        expect(body).toContain("build auth");
        expect(body).toContain("/workspace/.atlas/specs/build-auth.md");
        expect(body).toContain("finalize_spec");
    });

    it("awaiting-approval body includes task and docs dir", () => {
        enterAwaitingApproval("new auth flow", "/workspace/design-docs/auth");
        const body = planModeReminderBody();
        expect(body).toContain("Awaiting approval");
        expect(body).toContain("new auth flow");
        expect(body).toContain("/workspace/design-docs/auth");
        expect(body).toContain("approve_design_docs");
        expect(body).toContain("generate_design_docs");
    });
});
