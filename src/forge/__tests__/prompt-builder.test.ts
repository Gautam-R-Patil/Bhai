import { describe, it, expect } from "vitest";
import { buildSynthesisPrompt, buildDiagnosePrompt } from "../prompt-builder.js";

describe("synthesis prompt builder", () => {
    it("builds a user prompt with name, description, schema", () => {
        const p = buildSynthesisPrompt({
            name: "extract_pdf",
            description: "Extract text from a PDF",
            parametersSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            exemplars: [],
            trackB: false,
        });
        expect(p).toContain("extract_pdf");
        expect(p).toContain("Extract text from a PDF");
        expect(p).toContain("path");
    });

    it("includes exemplars when provided", () => {
        const p = buildSynthesisPrompt({
            name: "x", description: "x",
            parametersSchema: {},
            exemplars: [
                { slug: "send_email", description: "Send email via SMTP", handlerCode: "// e1", testsJson: "[]", capabilities: "[]", similarity: 0.7 },
                { slug: "send_sms", description: "Send SMS via Twilio", handlerCode: "// e2", testsJson: "[]", capabilities: "[]", similarity: 0.65 },
            ],
            trackB: false,
        });
        expect(p).toContain("send_email");
        expect(p).toContain("send_sms");
        expect(p).toContain("similarity: 0.7");
    });

    it("includes track_b context when trackB=true", () => {
        const p = buildSynthesisPrompt({
            name: "x", description: "x",
            parametersSchema: {},
            exemplars: [],
            trackB: true,
            patternClass: "repeated_sequence",
            evidenceSummary: "User invoked tool A then B then C three times this week.",
        });
        expect(p).toContain("retrospective");
        expect(p).toContain("repeated_sequence");
        expect(p).toContain("User invoked tool A");
    });
});

describe("diagnose prompt builder", () => {
    it("includes prior handler + failures", () => {
        const p = buildDiagnosePrompt({
            priorHandlerCode: "return 1;",
            failures: [
                { description: "test 1", input: { x: 1 }, expectedKind: "returns_equals", expectedValue: 2, actual: 1 },
                { description: "test 2", input: { x: 5 }, expectedKind: "returns_equals", expectedValue: 6, actual: 1 },
            ],
            sastFindings: [],
            attemptNumber: 2,
            maxAttempts: 3,
        });
        expect(p).toContain("Prior attempt failed");
        expect(p).toContain("return 1;");
        expect(p).toContain("test 1");
        expect(p).toContain("2 of 3");
    });

    it("includes SAST findings when present", () => {
        const p = buildDiagnosePrompt({
            priorHandlerCode: "eval(x);",
            failures: [],
            sastFindings: [{ ruleId: "forge-no-eval", severity: "ERROR", message: "eval not allowed", line: 1 }],
            attemptNumber: 2,
            maxAttempts: 3,
        });
        expect(p).toContain("forge-no-eval");
        expect(p).toContain("eval not allowed");
    });
});
