// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness: Filesystem-Agent Code Proposer (type stub) ────────────────
// This file hosts the `CodeChange` contract used by the code-proposer agent
// and the patch validator. The full code-proposer implementation lives in
// Task 6; only the shared type surface is stabilized here so downstream
// modules (patch-validator, optimizer) can compile against a stable import.

/**
 * A single code change the filesystem-agent code proposer wants to apply.
 * `patchFile` is the basename (or relative path) under `src/harness/proposed-changes/`;
 * `content` is the full UTF-8 source text of the new file.
 */
export interface CodeChange {
    patchFile: string;
    content: string;
}
