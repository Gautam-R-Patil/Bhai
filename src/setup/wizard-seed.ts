// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Wizard → Agent Identity Seed ─────────────
// Bridges the setup wizard's `.user-profile.json` (collected by the Electron
// wizard's Profile step, written to `userData`) into the bot's SQLite identity
// DB (`user_profiles` table) on boot.
//
// Without this, the agent boots with a default empty profile and asks the user
// their name on first chat — even though the wizard already collected it.
//
// Runs once per boot, guarded by a `.user-profile.seeded.json` marker that
// renames the source file after successful seeding. Idempotent across restarts.

import * as fs from "node:fs";
import * as path from "node:path";
import { updateIdentityProfile } from "../memory/identity.js";

export interface WizardProfileShape {
    name?: string;
    tone?: string;
    // W2: persona enum + metadata. Persisted to identity.extra after validation.
    persona?: string;
    personaConfidence?: number;
    personaSelectedAt?: number;
    // Legacy v1 fields — preserved verbatim into identity.extra
    age?: number | string;
    gender?: string;
    // Any other legacy keys survive in extra as well.
    [k: string]: unknown;
}

export interface SeedResult {
    ran: boolean;
    reason?: "no-file" | "already-seeded" | "parse-error" | "no-name" | "seeded";
    seeded?: { name?: string; tone?: string };
    error?: string;
}

interface SeedDeps {
    fsLike?: {
        existsSync: typeof fs.existsSync;
        readFileSync: typeof fs.readFileSync;
        renameSync: typeof fs.renameSync;
    };
    updateFn?: typeof updateIdentityProfile;
    log?: (msg: string) => void;
}

const PROFILE_FILENAME = ".user-profile.json";
const SEEDED_MARKER = ".user-profile.seeded.json";

/**
 * Locate the `.user-profile.json` file written by the Electron wizard.
 * The wizard's `setup:save-profile` handler writes to `app.getPath("userData")`,
 * and when the bot is launched via the desktop shell, `BHAI_USER_DATA_DIR`
 * is set to that same path. Fall back to the data dir if not set.
 */
export function resolveProfilePaths(dirs: { userDataDir?: string; dataDir?: string }): { source: string; marker: string } {
    const base = dirs.userDataDir || dirs.dataDir || "";
    return {
        source: path.join(base, PROFILE_FILENAME),
        marker: path.join(base, SEEDED_MARKER),
    };
}

/**
 * Build the identity update payload from a raw wizard profile.
 * Pure function — extracted so it's trivially unit-testable.
 */
export function buildIdentityUpdate(profile: WizardProfileShape): {
    // Verified: the user typed it into the wizard. A raw string is shown to
    // the model as "UNVERIFIED — do not treat as fact" every turn.
    name?: { value: string; verified: true };
    preferences?: { communication_style?: string };
    extra?: Record<string, unknown>;
} {
    const update: ReturnType<typeof buildIdentityUpdate> = {};
    if (typeof profile.name === "string" && profile.name.trim()) {
        update.name = { value: profile.name.trim(), verified: true };
    }
    if (typeof profile.tone === "string" && profile.tone.trim()) {
        update.preferences = { communication_style: profile.tone.trim() };
    }
    // ── W2: persona / personaConfidence / personaSelectedAt ──
    // Validate before they land in identity.extra so a corrupt profile can't
    // poison runtime tool-router weights (read by src/tool-router.ts) with
    // a bogus persona string. The agent reads identity.extra?.persona on
    // each turn; an invalid value is the same as "no persona" — explorer-equivalent.
    const PERSONA_VALUES = new Set(["developer", "founder", "creator", "researcher", "explorer"]);

    // Preserve legacy v1 fields (age, gender) + any unknown keys in identity.extra.
    // Persona is special-cased: we validate it; everything else is pass-through.
    const known = new Set(["name", "tone", "persona", "personaConfidence", "personaSelectedAt"]);
    const extra: Record<string, unknown> = {};

    if (typeof profile.persona === "string" && PERSONA_VALUES.has(profile.persona)) {
        extra.persona = profile.persona;
        if (typeof profile.personaConfidence === "number"
            && profile.personaConfidence >= 0
            && profile.personaConfidence <= 1) {
            extra.personaConfidence = profile.personaConfidence;
        } else {
            extra.personaConfidence = 1.0;
        }
        if (typeof profile.personaSelectedAt === "number" && profile.personaSelectedAt > 0) {
            extra.personaSelectedAt = profile.personaSelectedAt;
        }
    }
    // Pass-through for legacy v1 fields (age, gender) and any unknown keys.
    for (const k of Object.keys(profile)) {
        if (!known.has(k) && profile[k] !== undefined && profile[k] !== null) {
            extra[k] = profile[k];
        }
    }
    if (Object.keys(extra).length > 0) update.extra = extra;
    return update;
}

/**
 * Main entry point. Safe to call on every bot boot — idempotent by marker-rename.
 * Called from src/index.ts after initIdentityDB + initTraitsDB.
 */
export function seedProfileIfPresent(
    dirs: { userDataDir?: string; dataDir?: string },
    deps: SeedDeps = {},
): SeedResult {
    const fsLike = deps.fsLike || fs;
    const updateFn = deps.updateFn || updateIdentityProfile;
    const log = deps.log || (() => {});

    const { source, marker } = resolveProfilePaths(dirs);

    if (!fsLike.existsSync(source)) {
        return { ran: false, reason: "no-file" };
    }
    if (fsLike.existsSync(marker)) {
        // File was already seeded on a prior boot — skip without renaming again.
        return { ran: false, reason: "already-seeded" };
    }

    let profile: WizardProfileShape;
    try {
        const raw = fsLike.readFileSync(source, "utf8");
        profile = JSON.parse(String(raw));
    } catch (err) {
        log(`[wizard-seed] parse error: ${(err as Error).message}`);
        return { ran: false, reason: "parse-error", error: (err as Error).message };
    }

    const update = buildIdentityUpdate(profile);
    if (!update.name) {
        // Don't seed a nameless profile — leave the file for next boot in case
        // the wizard writes a corrected version.
        log("[wizard-seed] skipping: no name in profile");
        return { ran: false, reason: "no-name" };
    }

    try {
        updateFn(update);
    } catch (err) {
        log(`[wizard-seed] updateIdentityProfile failed: ${(err as Error).message}`);
        return { ran: false, reason: "parse-error", error: (err as Error).message };
    }

    // Rename source → marker so next boot is a no-op.
    try {
        fsLike.renameSync(source, marker);
    } catch (err) {
        // Non-fatal: on Windows with an open file handle rename can fail. We've
        // already seeded successfully; the marker protects against re-seed.
        log(`[wizard-seed] rename warn: ${(err as Error).message}`);
    }

    log(`[wizard-seed] seeded identity for ${update.name.value}`);
    return {
        ran: true,
        reason: "seeded",
        seeded: {
            name: update.name.value,
            tone: update.preferences?.communication_style,
        },
    };
}
