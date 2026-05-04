// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Convex system_prompts are shared across users — never auto-edit them here.
// Self-edits go to an audit log + a high-importance self-lesson memory.

import fs from "node:fs";
import path from "node:path";
import type { SelfEdit } from "../agents/self-editor.js";
import { atomicTextWrite } from "../utils/atomic-io.js";

const DATA_DIR = process.env.ATLAS_DATA_DIR || path.resolve("data");
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

export function _formatSelfEditForAudit(edit: SelfEdit): string {
    const ts = new Date().toISOString();
    const esc = (s: string) => (s ?? "").replace(/\n/g, "\\n").replace(/\t/g, " ");
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
        const line = _formatSelfEditForAudit(edit);
        let prior = "";
        try {
            prior = await fs.promises.readFile(AUDIT_LOG_PATH, "utf8");
        } catch { /* first run */ }
        const next = prior.endsWith("\n") || prior === "" ? prior : `${prior}\n`;
        await atomicTextWrite(AUDIT_LOG_PATH, `${next}${line}\n`);
    } catch (err) {
        console.warn("[self-edit] audit log write failed:", (err as Error).message);
    }
}
