// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { buildHandoff, serializeHandoff, buildDependencyContext } from "./handoff.js";
import type { SubAgentResult, AgentRole } from "./sub-agent.js";
import type { MeshStep } from "./mesh.js";

// ── Test helpers ──────────────────────────────────

function makeResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
    return {
        id: "step-1",
        role: "coder" as AgentRole,
        success: true,
        output: "",
        toolCalls: 0,
        durationMs: 100,
        estimatedCost: 0,
        ...overrides,
    };
}

function makeStep(overrides: Partial<MeshStep> = {}): MeshStep {
    return {
        id: "step-1",
        role: "coder" as AgentRole,
        description: "do the thing",
        depends_on: [],
        ...overrides,
    };
}

// ── buildHandoff ──────────────────────────────────

describe("buildHandoff — status mapping", () => {
    it("success:true → status='success'", () => {
        const h = buildHandoff(makeResult({ success: true, output: "ok" }), makeStep());
        expect(h.status).toEqual("success");
    });

    it("success:false with output → status='partial'", () => {
        const h = buildHandoff(
            makeResult({ success: false, output: "partial progress", error: "timeout" }),
            makeStep(),
        );
        expect(h.status).toEqual("partial");
    });

    it("success:false with empty output → status='failed'", () => {
        const h = buildHandoff(
            makeResult({ success: false, output: "", error: "crashed" }),
            makeStep(),
        );
        expect(h.status).toEqual("failed");
    });
});

describe("buildHandoff — summary extraction", () => {
    it("summary is the first paragraph (before the first \\n\\n)", () => {
        const output =
            "First paragraph here describing what happened.\n\nSecond paragraph with more details that should NOT appear.";
        const h = buildHandoff(makeResult({ output }), makeStep());
        expect(h.summary).toContain("First paragraph");
        expect(h.summary).not.toContain("Second paragraph");
    });

    it("summary is truncated at 300 chars", () => {
        const long = "a".repeat(500);
        const h = buildHandoff(makeResult({ output: long }), makeStep());
        expect(h.summary.length).toBeLessThanOrEqual(300);
    });

    it("summary is trimmed (no leading/trailing whitespace)", () => {
        const h = buildHandoff(
            makeResult({ output: "   hello world   \n\nother" }),
            makeStep(),
        );
        expect(h.summary).toEqual("hello world");
    });

    it("empty output yields empty summary", () => {
        const h = buildHandoff(makeResult({ output: "" }), makeStep());
        expect(h.summary).toEqual("");
    });
});

describe("buildHandoff — bullet findings extraction", () => {
    it("extracts '-' bullet points as keyFindings", () => {
        const output =
            "Some preamble.\n- First finding with enough chars here\n- Second finding also long enough\n- Third finding";
        const h = buildHandoff(makeResult({ output }), makeStep());
        expect(h.keyFindings.length).toBeGreaterThanOrEqual(2);
        expect(h.keyFindings[0]).toMatch(/First finding/);
    });

    it("extracts '*' bullet points", () => {
        const output = "* Alpha finding that is substantial\n* Beta finding in the list";
        const h = buildHandoff(makeResult({ output }), makeStep());
        expect(h.keyFindings.length).toBeGreaterThanOrEqual(2);
    });

    it("caps findings at MAX_FINDINGS (5)", () => {
        const bullets = Array.from({ length: 10 }, (_, i) => `- finding number ${i} with some text`).join(
            "\n",
        );
        const h = buildHandoff(makeResult({ output: bullets }), makeStep());
        expect(h.keyFindings.length).toBeLessThanOrEqual(5);
    });

    it("skips bullets shorter than 10 chars (filtered out)", () => {
        const output = "- short\n- also short item that is not super long but passes";
        const h = buildHandoff(makeResult({ output }), makeStep());
        // "short" is only 5 chars → filtered out
        const contains = h.keyFindings.some((f) => f === "short");
        expect(contains).toBe(false);
    });

    it("truncates individual findings to MAX_FINDING_CHARS (150)", () => {
        const big = "x".repeat(500);
        const output = `- ${big}`;
        const h = buildHandoff(makeResult({ output }), makeStep());
        if (h.keyFindings.length > 0) {
            expect(h.keyFindings[0].length).toBeLessThanOrEqual(150);
        }
    });
});

describe("buildHandoff — artifact extraction", () => {
    it("extracts file paths", () => {
        const output = "Wrote /tmp/foo.txt and /home/user/bar.log";
        const h = buildHandoff(makeResult({ output }), makeStep());
        const filePaths = h.artifacts.filter((a) => a.type === "file").map((a) => a.path);
        expect(filePaths).toContain("/tmp/foo.txt");
        expect(filePaths).toContain("/home/user/bar.log");
    });

    it("extracts URLs", () => {
        const output = "See https://example.com/foo and http://test.org/bar for details";
        const h = buildHandoff(makeResult({ output }), makeStep());
        const urls = h.artifacts.filter((a) => a.type === "url").map((a) => a.path);
        expect(urls).toContain("https://example.com/foo");
        expect(urls).toContain("http://test.org/bar");
    });

    it("dedupes artifacts (same path not added twice)", () => {
        const output = "/tmp/foo.txt was saved. Then /tmp/foo.txt was read again.";
        const h = buildHandoff(makeResult({ output }), makeStep());
        const count = h.artifacts.filter((a) => a.path === "/tmp/foo.txt").length;
        expect(count).toEqual(1);
    });

    it("caps artifacts at 10 total", () => {
        const files = Array.from({ length: 20 }, (_, i) => `/tmp/file${i}.txt`).join(" ");
        const h = buildHandoff(makeResult({ output: files }), makeStep());
        expect(h.artifacts.length).toBeLessThanOrEqual(10);
    });
});

describe("buildHandoff — error extraction", () => {
    it("includes result.error as the first error entry", () => {
        const h = buildHandoff(
            makeResult({ output: "some progress", error: "something went wrong" }),
            makeStep(),
        );
        expect(h.errors[0]).toContain("something went wrong");
    });

    it("extracts error lines from output", () => {
        const output =
            "Starting task...\nWARNING: memory low, may need to retry\nERROR: connection failed after 3 attempts\nDone.";
        const h = buildHandoff(makeResult({ success: false, output }), makeStep());
        // Should include at least one error-style line
        expect(h.errors.length).toBeGreaterThan(0);
    });

    it("caps errors at MAX_ERRORS (3)", () => {
        const errorLines = Array.from(
            { length: 10 },
            (_, i) => `ERROR: thing ${i} went wrong with more text here`,
        ).join("\n");
        const h = buildHandoff(makeResult({ output: errorLines }), makeStep());
        expect(h.errors.length).toBeLessThanOrEqual(3);
    });
});

describe("buildHandoff — raw tail", () => {
    it("short output: rawOutputTail === output", () => {
        const h = buildHandoff(makeResult({ output: "short" }), makeStep());
        expect(h.rawOutputTail).toEqual("short");
    });

    it("long output: rawOutputTail is last 500 chars", () => {
        const long = "a".repeat(1000) + "END_MARKER";
        const h = buildHandoff(makeResult({ output: long }), makeStep());
        expect(h.rawOutputTail.length).toBeLessThanOrEqual(500);
        expect(h.rawOutputTail.endsWith("END_MARKER")).toBe(true);
    });
});

describe("buildHandoff — fromStep + fromRole propagation", () => {
    it("echoes step.id and step.role in the handoff", () => {
        const step = makeStep({ id: "my-step-id", role: "browser" });
        const h = buildHandoff(makeResult({ role: "browser" }), step);
        expect(h.fromStep).toEqual("my-step-id");
        expect(h.fromRole).toEqual("browser");
    });
});

// ── serializeHandoff ──────────────────────────────

describe("serializeHandoff", () => {
    it("opens with a [HANDOFF from <id> (<role>) - <STATUS>] marker", () => {
        const h = buildHandoff(
            makeResult({ role: "coder", output: "ok" }),
            makeStep({ id: "s-42", role: "coder" }),
        );
        const s = serializeHandoff(h);
        expect(s).toContain("[HANDOFF from s-42 (coder) - SUCCESS]");
    });

    it("closes with [END HANDOFF]", () => {
        const h = buildHandoff(makeResult({ output: "ok" }), makeStep());
        const s = serializeHandoff(h);
        expect(s.endsWith("[END HANDOFF]")).toBe(true);
    });

    it("summary appears on a 'Summary:' line", () => {
        const h = buildHandoff(makeResult({ output: "This is the summary paragraph." }), makeStep());
        const s = serializeHandoff(h);
        expect(s).toContain("Summary: This is the summary paragraph.");
    });

    it("findings appear under a 'Findings:' header when present", () => {
        const h = buildHandoff(
            makeResult({ output: "intro\n- alpha finding one\n- beta finding two" }),
            makeStep(),
        );
        const s = serializeHandoff(h);
        expect(s).toContain("Findings:");
        expect(s).toContain("- alpha finding");
    });

    it("omits Findings when empty", () => {
        const h = buildHandoff(makeResult({ output: "just prose" }), makeStep());
        const s = serializeHandoff(h);
        expect(s).not.toContain("Findings:");
    });

    it("artifacts render as 'type:path' on one line", () => {
        const h = buildHandoff(
            makeResult({ output: "wrote /tmp/foo.txt and see https://x.com" }),
            makeStep(),
        );
        const s = serializeHandoff(h);
        expect(s).toMatch(/Artifacts: .*file:\/tmp\/foo\.txt/);
        expect(s).toMatch(/url:https:\/\/x\.com/);
    });

    it("errors render under an 'Errors:' header with a ⚠️ prefix", () => {
        const h = buildHandoff(
            makeResult({ success: false, error: "boom", output: "partial" }),
            makeStep(),
        );
        const s = serializeHandoff(h);
        expect(s).toContain("Errors:");
        expect(s).toContain("⚠️ boom");
    });

    it("status 'failed' is uppercased in the header", () => {
        const h = buildHandoff(makeResult({ success: false, output: "" }), makeStep());
        const s = serializeHandoff(h);
        expect(s).toContain("- FAILED]");
    });
});

// ── buildDependencyContext ────────────────────────

describe("buildDependencyContext", () => {
    it("concatenates handoff text for every dep in step.depends_on", () => {
        const step = makeStep({ depends_on: ["dep-a", "dep-b"] });
        const results = new Map([
            [
                "dep-a",
                {
                    result: makeResult({ id: "dep-a", output: "output A with /tmp/a.txt" }),
                    step: makeStep({ id: "dep-a", role: "coder" }),
                },
            ],
            [
                "dep-b",
                {
                    result: makeResult({ id: "dep-b", output: "output B with /tmp/b.txt" }),
                    step: makeStep({ id: "dep-b", role: "browser" }),
                },
            ],
        ]);
        const ctx = buildDependencyContext(step, results);
        expect(ctx).toContain("dep-a");
        expect(ctx).toContain("dep-b");
        expect(ctx).toContain("/tmp/a.txt");
        expect(ctx).toContain("/tmp/b.txt");
    });

    it("silently skips missing dependencies", () => {
        const step = makeStep({ depends_on: ["exists", "missing"] });
        const results = new Map([
            [
                "exists",
                {
                    result: makeResult({ id: "exists", output: "real output" }),
                    step: makeStep({ id: "exists" }),
                },
            ],
        ]);
        const ctx = buildDependencyContext(step, results);
        expect(ctx).toContain("exists");
        expect(ctx).not.toContain("missing");
    });

    it("returns empty string when no deps", () => {
        const step = makeStep({ depends_on: [] });
        const ctx = buildDependencyContext(step, new Map());
        expect(ctx).toEqual("");
    });

    it("separates multiple handoffs with a blank line (\\n\\n)", () => {
        const step = makeStep({ depends_on: ["a", "b"] });
        const results = new Map([
            [
                "a",
                { result: makeResult({ id: "a", output: "A" }), step: makeStep({ id: "a" }) },
            ],
            [
                "b",
                { result: makeResult({ id: "b", output: "B" }), step: makeStep({ id: "b" }) },
            ],
        ]);
        const ctx = buildDependencyContext(step, results);
        expect(ctx).toMatch(/\[END HANDOFF\]\n\n\[HANDOFF/);
    });
});
