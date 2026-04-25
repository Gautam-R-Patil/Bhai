// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness: Patch Validator ───────────────────────────────────────
// Static safety gates for TypeScript patches the code-proposer agent writes
// under src/harness/proposed-changes/. Pure string/regex — no Rust needed.

import { writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CodeChange } from "./code-proposer.js";

export interface PatchValidationResult {
    valid: boolean;
    violations: string[];
}

const MAX_PATCH_BYTES = 50 * 1024;

const FORBIDDEN_CALLS: Array<{ pattern: RegExp; message: string }> = [
    { pattern: /\brequire\s*\(/, message: "require() is forbidden" },
    { pattern: /\beval\s*\(/, message: "eval() is forbidden" },
    { pattern: /\bnew\s+Function\s*\(/, message: "Function constructor is forbidden" },
    { pattern: /\bchild_process\b/, message: "child_process is forbidden" },
    { pattern: /\bexec\s*\(/, message: "exec() is forbidden" },
    { pattern: /\bspawn\s*\(/, message: "spawn() is forbidden" },
    { pattern: /\bfetch\s*\(/, message: "fetch() is forbidden (no network I/O)" },
    { pattern: /\bhttp\./, message: "http.* is forbidden (no network I/O)" },
    { pattern: /\bhttps\./, message: "https.* is forbidden (no network I/O)" },
    { pattern: /\bnet\.Socket\b/, message: "net.Socket is forbidden (no network I/O)" },
    { pattern: /\bWebSocket\b/, message: "WebSocket is forbidden (no network I/O)" },
];

const PROCESS_ENV_WRITE = /\bprocess\.env\.\w+\s*=/;
const FS_DESTRUCTIVE = /\bfs\.(rm|rmSync|unlink|unlinkSync)\s*\(\s*(['"`])([^'"`]*)\2/g;
const IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
const ALLOWED_IMPORT_PREFIXES = ["../registry", "../types"];

export function validatePatch(content: string, patchFile: string): PatchValidationResult {
    const violations: string[] = [];

    if (Buffer.byteLength(content, "utf-8") > MAX_PATCH_BYTES) {
        violations.push(`${patchFile}: patch exceeds 50KB size limit`);
    }

    if (!/export\s+(function|const)\b/.test(content)) {
        violations.push(`${patchFile}: must contain at least one 'export function' or 'export const'`);
    }

    if (PROCESS_ENV_WRITE.test(content)) {
        violations.push(`${patchFile}: process.env writes are forbidden`);
    }

    for (const { pattern, message } of FORBIDDEN_CALLS) {
        if (pattern.test(content)) {
            violations.push(`${patchFile}: ${message}`);
        }
    }

    FS_DESTRUCTIVE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FS_DESTRUCTIVE.exec(content)) !== null) {
        const path = m[3] ?? "";
        if (!path.includes("data/harness")) {
            violations.push(`${patchFile}: fs.${m[1]} on "${path}" — only paths under data/harness/ are allowed`);
        }
    }

    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(content)) !== null) {
        const spec = m[1] ?? "";
        const allowed = ALLOWED_IMPORT_PREFIXES.some(
            p => spec === p || spec.startsWith(`${p}.`) || spec.startsWith(`${p}/`)
        );
        if (!allowed) {
            violations.push(`${patchFile}: import from "${spec}" is not allowed — only ../registry or ../types`);
        }
    }

    return { valid: violations.length === 0, violations };
}

export function applyCodeChange(change: CodeChange, targetDir: string): void {
    const destPath = join(targetDir, "src/harness/proposed-changes", change.patchFile);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, change.content, "utf-8");
}

export function revertCodeChanges(targetDir: string): void {
    const dir = join(targetDir, "src/harness/proposed-changes");
    if (!existsSync(dir)) return;
    try {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            try {
                if (statSync(full).isDirectory()) {
                    rmSync(full, { recursive: true, force: true });
                } else {
                    rmSync(full, { force: true });
                }
            } catch { /* best-effort */ }
        }
    } catch { /* */ }
}
