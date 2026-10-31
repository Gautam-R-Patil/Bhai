// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Convex system_prompts are shared across users — never auto-edit them here.
// Self-edits go to an audit log + a high-importance self-lesson memory.

import fs from "node:fs";
import path from "node:path";
import type { SelfEdit } from "../agents/self-editor.js";

const DATA_DIR = process.env.BHAI_DATA_DIR || path.resolve("data");
const AUDIT_LOG_PATH = path.join(DATA_DIR, "self-edits-audit.log");

/** Gate used by formatDreamResults: true = show in morning brief, false = silent actuation only. */
export function _selfEditIsUserFacing(
    task: string,
    result: string = "",
): boolean {
    const t = (task ?? "").toLowerCase();
    const r = (result ?? "").toLowerCase();
    if (t.includes("self-improvement proposal")) return false;
    if (t.includes("suggested instruction")) return false;
    if (r.startsWith("suggested instruction edit")) return false;
    return true;
}

// macOS PIPE_BUF=512 is the tight bound. Budget:
//   24 (ISO ts) + 43 (key prefixes) + 5 (bool) = 72 bytes fixed overhead.
//   Remaining 440 bytes across 4 fields × worst-case 2× escape expansion
//   (e.g. each `\r` becomes the 2-byte `\r`) = 55 pre-escape chars per
//   field. Round down to 50 for margin, then append a 13-byte truncation
//   marker (which itself doesn't expand).
const AUDIT_FIELD_CAP = 50;
const TRUNC_MARKER = "…[truncated]";

function truncateField(s: string, cap: number = AUDIT_FIELD_CAP): string {
    if (s.length <= cap) return s;
    return s.slice(0, cap - TRUNC_MARKER.length) + TRUNC_MARKER;
}

export function _formatSelfEditForAudit(edit: SelfEdit): string {
    const ts = new Date().toISOString();
    // Escape order: backslash first (otherwise literal "\\n" in input
    // decodes indistinguishably from a real newline), then CR/LF/TAB so
    // the row stays grep-friendly and hostile input can't forge a new row.
    const esc = (s: string) =>
        truncateField(s ?? "")
            .replace(/\\/g, "\\\\")
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n")
            .replace(/\t/g, " ");
    return `${ts}\ttarget=${esc(edit.targetFile)}\treason=${esc(edit.reason)}\toriginal=${esc(edit.originalSnippet)}\tedited=${esc(edit.editedSnippet)}\tapplied=${edit.applied}`;
}

export function _recordSelfEditActuation(edit: SelfEdit): string {
    const reason = (edit.reason ?? "").trim() || "avoids a recurring failure";
    const edited = (edit.editedSnippet ?? "").trim();
    // Agent-first voice — never user-directed language. Validated by test.
    return [
        `Self-lesson learned from recurring failures: ${reason}.`,
        `Adopt this rule going forward: ${edited}`,
    ].join(" ");
}

export async function appendSelfEditAudit(edit: SelfEdit): Promise<void> {
    try {
        await fs.promises.mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true });
        // appendFile with O_APPEND is atomic per POSIX for single writes
        // below PIPE_BUF — the whole line either lands or doesn't, even
        // under concurrent nightly dreaming + manual actuation.
        await fs.promises.appendFile(
            AUDIT_LOG_PATH,
            `${_formatSelfEditForAudit(edit)}\n`,
            "utf8",
        );
    } catch (err) {
        console.warn("[self-edit] audit log write failed:", (err as Error).message);
    }
}
