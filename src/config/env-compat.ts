// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Env compat (ATLAS_* → BHAI_*) ─────────────────────
// Bhai was called ATLAS; users' shells and .env/.env.runtime files may still say
// ATLAS_X. Imported first by every entry point, so module-scope readers see the
// mirrored names. Loads dotenv itself (same as src/config.ts) so .env keys count.

import "dotenv/config";

/**
 * Mirror ATLAS_X ↔ BHAI_X in both directions wherever the other is unset (an
 * empty string counts as set). Both directions so the Rust std::env readers and
 * anything still on the old name agree. Safe to re-run.
 */
export function mirrorLegacyEnv(env: NodeJS.ProcessEnv = process.env): void {
    for (const key of Object.keys(env)) {
        const m = /^(ATLAS|BHAI)_(.+)$/.exec(key);
        if (!m) continue;
        const other = `${m[1] === "ATLAS" ? "BHAI" : "ATLAS"}_${m[2]}`;
        if (env[other] === undefined) env[other] = env[key];
    }
}

mirrorLegacyEnv();
