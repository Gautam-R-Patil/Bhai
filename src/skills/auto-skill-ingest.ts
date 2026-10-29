// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

// Auto-skills no longer live on disk. The agent drafts them via
// self_improvement_draft into a local SQLite buffer; nightly synthesis
// merges them and uploads to the server's user_prompt_addenda table. The
// tool-router sees auto-skills via the regular server skill-metadata
// endpoint (loader.ts) once they've been synthesized — there is no
// boot-time disk read anymore.
//
// This file is retained as a no-op stub so that callers in older modules
// (loader.ts compatibility) don't break during the transition. Once those
// callers are removed, this file can be deleted entirely.

import type { SkillMetadata } from "./loader.js";

export function _setAutoSkillsDirForTests(_p: string | null): void {
    // no-op — drafts live in SQLite now
}

export function loadAutoSkillsFromDisk(): SkillMetadata[] {
    return [];
}

export function mergeAutoSkills(serverMetadata: SkillMetadata[]): SkillMetadata[] {
    return [...serverMetadata];
}
