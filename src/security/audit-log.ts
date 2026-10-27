// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Audit Logging ────────────────────────────────
// Appends JSON-line entries to <data dir>/audit.jsonl for security-relevant operations.
// All writes are non-blocking and fire-and-forget — audit logging must never
// slow down or break tool execution.

import fs from "node:fs";
import path from "node:path";
import { registerProtectedPath } from "./allowlist.js";
import { getDataDir } from "../config/paths.js";

// Honour ATLAS_DATA_DIR: in the packaged app the working directory is inside
// the (read-only, signed) app bundle.
const AUDIT_PATH = path.join(getDataDir(), "audit.jsonl");

// Make the audit log itself write/delete-protected — a tool that scrubs
// audit.jsonl could otherwise hide its own tracks. Idempotent register.
try {
    registerProtectedPath(AUDIT_PATH);
} catch {
    /* allowlist module unavailable — non-fatal */
}

/**
 * Append a single audit entry to `data/audit.jsonl`.
 *
 * Call this fire-and-forget (no `await`). Failures are silently swallowed
 * so that audit logging never interrupts normal tool execution.
 *
 * @param action  — e.g. "file_read", "file_write", "file_delete",
 *                  "shell_exec", "shell_exec_background"
 * @param details — arbitrary context (path, command, args, user, etc.)
 */
export function auditLog(action: string, details: Record<string, unknown>): void {
    try {
        const entry = JSON.stringify({
            timestamp: new Date().toISOString(),
            action,
            ...details,
        });

        // Ensure data/ directory exists (sync check is cheap and cached by the OS)
        const dir = path.dirname(AUDIT_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Non-blocking append — callback silently ignores errors
        fs.appendFile(AUDIT_PATH, entry + "\n", () => {});
    } catch {
        // Swallow any synchronous errors (JSON.stringify failure, etc.)
    }
}
