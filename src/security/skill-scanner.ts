// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Skill Permission-Tier & Behavioral Scanner ──
// Scans skill content for dangerous patterns and classifies risk level.
// Called before sideloading to block critical-risk skills and warn on high-risk ones.

// ── Types ─────────────────────────────────────

export interface SkillScanResult {
    safe: boolean;
    riskLevel: "low" | "medium" | "high" | "critical";
    warnings: string[];
    requiredPermissions: string[];
}

// ── Pattern definitions ─────────────────────────

interface PatternRule {
    pattern: RegExp;
    description: string;
    permission?: string;
}

const CRITICAL_PATTERNS: PatternRule[] = [
    { pattern: /eval\s*\(/, description: "eval() call — arbitrary code execution", permission: "shell" },
    { pattern: /new\s+Function\s*\(/, description: "new Function() — dynamic code generation", permission: "shell" },
    { pattern: /child_process/, description: "child_process module — shell command execution", permission: "shell" },
    {
        pattern: /require\s*\(\s*['"]fs['"]\s*\)\s*\.\s*unlinkSync/,
        description: "fs.unlinkSync — synchronous file deletion",
        permission: "filesystem",
    },
    { pattern: /process\.env/, description: "process.env access — credential/secret exposure", permission: "shell" },
    {
        pattern: /__dirname\s*\+\s*['"]\/\.\.\//,
        description: "Path traversal via __dirname + '/../'",
        permission: "filesystem",
    },
    {
        pattern: /fetch\s*\(\s*['"]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/,
        description: "Insecure HTTP fetch to non-localhost URL",
        permission: "network",
    },
];

// Base64 strings longer than 100 chars (checked separately since it needs length logic)
const BASE64_PATTERN = /(?:[A-Za-z0-9+/]{4}){25,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g;

const HIGH_PATTERNS: PatternRule[] = [
    { pattern: /exec\s*\(/, description: "exec() call — shell command execution", permission: "shell" },
    { pattern: /spawn\s*\(/, description: "spawn() call — process spawning", permission: "shell" },
    { pattern: /fs\.writeFile/, description: "fs.writeFile — file system write", permission: "filesystem" },
    { pattern: /fs\.rmdir/, description: "fs.rmdir — directory removal", permission: "filesystem" },
    { pattern: /fs\.unlink(?!Sync)/, description: "fs.unlink — file deletion", permission: "filesystem" },
    {
        pattern: /https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^\s"'<>]+/,
        description: "External network request URL detected",
        permission: "network",
    },
];

const MEDIUM_PATTERNS: PatternRule[] = [
    {
        pattern: /fs\.readFile\s*\(\s*['"][^'"]*(?!data\/)['"]/,
        description: "fs.readFile on path potentially outside data/",
        permission: "filesystem",
    },
    { pattern: /os\.homedir\s*\(/, description: "os.homedir() — home directory access", permission: "filesystem" },
    { pattern: /clipboard/, description: "Clipboard access detected", permission: "filesystem" },
];

// ── Scanner ─────────────────────────────────────

export function scanSkillContent(content: string): SkillScanResult {
    const warnings: string[] = [];
    const permissionSet = new Set<string>();
    let maxLevel: "low" | "medium" | "high" | "critical" = "low";

    // Check critical patterns
    for (const rule of CRITICAL_PATTERNS) {
        if (rule.pattern.test(content)) {
            warnings.push(`[CRITICAL] ${rule.description}`);
            if (rule.permission) permissionSet.add(rule.permission);
            maxLevel = "critical";
        }
    }

    // Check for long Base64-encoded strings (>100 chars)
    const base64Matches = content.match(BASE64_PATTERN);
    if (base64Matches) {
        for (const match of base64Matches) {
            if (match.length > 100) {
                warnings.push(`[CRITICAL] Base64-encoded string (${match.length} chars) — possible obfuscated payload`);
                maxLevel = "critical";
                break;
            }
        }
    }

    // Check high patterns
    for (const rule of HIGH_PATTERNS) {
        if (rule.pattern.test(content)) {
            warnings.push(`[HIGH] ${rule.description}`);
            if (rule.permission) permissionSet.add(rule.permission);
            if (maxLevel !== "critical") maxLevel = "high";
        }
    }

    // Check medium patterns
    for (const rule of MEDIUM_PATTERNS) {
        if (rule.pattern.test(content)) {
            warnings.push(`[MEDIUM] ${rule.description}`);
            if (rule.permission) permissionSet.add(rule.permission);
            if (maxLevel !== "critical" && maxLevel !== "high") maxLevel = "medium";
        }
    }

    return {
        safe: maxLevel === "low" || maxLevel === "medium",
        riskLevel: maxLevel,
        warnings,
        requiredPermissions: Array.from(permissionSet).sort(),
    };
}
