// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acorn from "acorn";

export interface CriticFinding {
    ruleId: string;
    severity: "ERROR" | "WARNING" | "INFO";
    message: string;
    line?: number;
    column?: number;
    snippet?: string;
}

export interface CompileResult {
    pass: boolean;
    hardFail: boolean;
    error?: string;
}

export function runCompileCheck(code: string): CompileResult {
    try {
        acorn.parse(`(async function() { ${code} })`, { ecmaVersion: "latest", sourceType: "script" });
        return { pass: true, hardFail: false };
    } catch (err) {
        return { pass: false, hardFail: true, error: (err as Error).message };
    }
}

export interface LintCriticOpts {
    biomePath?: string;
}

export interface LintResult {
    pass: boolean;
    degraded: boolean;
    findings: CriticFinding[];
    error?: string;
}

export async function runLintCritic(code: string, opts: LintCriticOpts = {}): Promise<LintResult> {
    const biomePath = opts.biomePath ?? "biome";
    // Quick existence check by trying --version
    const versionOk = await new Promise<boolean>((resolve) => {
        const p = spawn(biomePath, ["--version"], { stdio: "ignore" });
        p.on("error", () => resolve(false));
        p.on("exit", (code) => resolve(code === 0));
    });
    if (!versionOk) {
        return { pass: true, degraded: true, findings: [], error: "biome binary not available" };
    }

    const tmpPath = join(tmpdir(), `forge-lint-${randomBytes(8).toString("hex")}.js`);
    await writeFile(tmpPath, code, "utf-8");
    try {
        const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
            const p = spawn(biomePath, ["check", tmpPath, "--reporter=json"]);
            let so = "",
                se = "";
            p.stdout?.on("data", (d) => (so += String(d)));
            p.stderr?.on("data", (d) => (se += String(d)));
            p.on("close", (code) => resolve({ code: code ?? -1, stdout: so, stderr: se }));
        });
        // Parse Biome JSON output for findings. Soft fail on any.
        const findings: CriticFinding[] = [];
        try {
            const parsed = JSON.parse(result.stdout);
            for (const diag of parsed?.diagnostics ?? []) {
                findings.push({
                    ruleId: diag.category ?? "biome",
                    severity: diag.severity === "error" ? "ERROR" : "WARNING",
                    message: diag.message ?? "",
                });
            }
        } catch {
            // Biome may print non-JSON when clean — that's fine, no findings
        }
        return { pass: true, degraded: false, findings };
    } finally {
        await unlink(tmpPath).catch(() => {});
    }
}

export interface SastCriticOpts {
    rulesPath: string | null;
    semgrepPath?: string;
}

export interface SastResult {
    pass: boolean;
    hardFail: boolean;
    findings: CriticFinding[];
    via: "semgrep" | "regex_fallback";
}

const REGEX_RULES: Array<{ id: string; pattern: RegExp; severity: "ERROR" | "WARNING"; message: string }> = [
    { id: "forge-no-eval", pattern: /\beval\s*\(/g, severity: "ERROR", message: "eval() not allowed" },
    {
        id: "forge-no-function-ctor",
        pattern: /new\s+Function\s*\(/g,
        severity: "ERROR",
        message: "new Function() not allowed",
    },
    {
        id: "forge-no-process-binding",
        pattern: /process\.binding\s*\(/g,
        severity: "ERROR",
        message: "process.binding() not allowed",
    },
    {
        id: "forge-no-child-process",
        pattern: /require\s*\(\s*['"](?:node:)?child_process['"]\s*\)/g,
        severity: "ERROR",
        message: "child_process require not allowed; use utils.exec",
    },
    {
        id: "forge-no-fs-write",
        pattern: /fs\.(writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync)\s*\(/g,
        severity: "ERROR",
        message: "direct fs write not allowed; declare capability",
    },
    {
        id: "forge-no-source-read",
        pattern: /['"][^'"]*\/(?:src|native|prompts|convex)\/[^'"]*['"]/g,
        severity: "ERROR",
        message: "reading ATLAS source paths not allowed",
    },
    {
        id: "forge-no-env-write",
        pattern: /process\.env\.\w+\s*=(?!=)/g,
        severity: "WARNING",
        message: "writing to process.env discouraged",
    },
    {
        id: "forge-no-dlopen",
        pattern: /process\.dlopen\s*\(/g,
        severity: "ERROR",
        message: "process.dlopen not allowed",
    },
    {
        id: "forge-infinite-loop",
        pattern: /while\s*\(\s*true\s*\)\s*\{(?![^}]*break)/g,
        severity: "WARNING",
        message: "while(true) without break detected",
    },
    {
        id: "forge-shell-injection",
        pattern: /utils\.exec\s*\(\s*['"`][^'"`]*\$\{[^}]*input\./g,
        severity: "WARNING",
        message: "potential shell injection via input.* in exec string",
    },
    {
        id: "forge-fetch-no-cap",
        pattern: /(?:^|[^\w.])fetch\s*\(/g,
        severity: "WARNING",
        message: "fetch call detected — ensure net capability declared",
    },
];

export async function runSastCritic(code: string, _opts: SastCriticOpts): Promise<SastResult> {
    // Phase 3: regex fallback always. Semgrep wiring can be added later.
    const findings: CriticFinding[] = [];
    for (const rule of REGEX_RULES) {
        const matches = [...code.matchAll(rule.pattern)];
        for (const m of matches) {
            // line number
            const before = code.slice(0, m.index ?? 0);
            const line = before.split("\n").length;
            findings.push({
                ruleId: rule.id,
                severity: rule.severity,
                message: rule.message,
                line,
                snippet: m[0].slice(0, 80),
            });
        }
    }
    const hardFail = findings.some((f) => f.severity === "ERROR");
    return { pass: !hardFail, hardFail, findings, via: "regex_fallback" };
}
