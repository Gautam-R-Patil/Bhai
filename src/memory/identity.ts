// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { Database } from "./sqlite.js";

// ── Types ─────────────────────────────────────

export interface VerifiedField<T = string> {
    value: T;
    verified: boolean;
}

export interface UserProfile {
    user_id: string;
    version?: number;
    email?: VerifiedField | string;
    name?: VerifiedField | string;
    location?: VerifiedField | string;
    /** Device location (GPS/Wi-Fi/IP). Never the user's stated home in `location`. */
    current_location?: string;
    role?: VerifiedField | string;
    company?: VerifiedField | string;
    projects?: string[];
    preferences?: {
        communication_style?: string;
        detail_level?: string;
        [key: string]: unknown;
    };
    important_goals?: string[];
    extra?: Record<string, unknown>;
    last_updated?: string;
}

// Fields that can be stored as VerifiedField (string-or-VerifiedField union).
const VERIFIABLE_FIELDS = ["email", "name", "location", "role", "company"] as const;

function isVerified(field: string | VerifiedField | undefined): boolean | undefined {
    if (!field) return undefined;
    if (typeof field === "string") return undefined; // legacy raw string — verification state unknown
    return field.verified;
}

// ── Singleton ─────────────────────────────────

let _db: Database | null = null;
const DEFAULT_USER_ID = "default";

// ── Initialize ────────────────────────────────

export function initIdentityDB(db: Database): void {
    _db = db;

    db.run(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

    // Safe migration: add version column if missing
    try {
        db.run("ALTER TABLE user_profiles ADD COLUMN version INTEGER DEFAULT 1");
    } catch {
        /* already exists */
    }

    // Ensure a default profile row exists
    const existing = db.exec("SELECT user_id FROM user_profiles WHERE user_id = ?", [DEFAULT_USER_ID]);
    if (existing.length === 0 || existing[0].values.length === 0) {
        db.run("INSERT INTO user_profiles (user_id, profile_json, version) VALUES (?, ?, 1)", [
            DEFAULT_USER_ID,
            JSON.stringify({ user_id: DEFAULT_USER_ID, version: 1 }),
        ]);
    }

    console.log("🪪 Identity memory initialized (v1)");
}

// ── Get Profile ───────────────────────────────

export function getIdentityProfile(userId = DEFAULT_USER_ID): UserProfile {
    if (!_db) return { user_id: userId };

    const results = _db.exec("SELECT profile_json FROM user_profiles WHERE user_id = ?", [userId]);

    if (results.length === 0 || results[0].values.length === 0) {
        return { user_id: userId };
    }

    try {
        const profile = JSON.parse(results[0].values[0][0] as string) as UserProfile;
        // Reflection once saved these as plain strings, and every reader that joins them threw.
        for (const k of ["projects", "important_goals"] as const) {
            const v: unknown = profile[k];
            if (v !== undefined && !Array.isArray(v)) profile[k] = typeof v === "string" && v ? [v] : undefined;
        }
        return profile;
    } catch {
        return { user_id: userId };
    }
}

// ── Update Profile ────────────────────────────

export function updateIdentityProfile(fields: Partial<UserProfile>, userId = DEFAULT_USER_ID): UserProfile {
    if (!_db) throw new Error("Identity DB not initialized");

    const current = getIdentityProfile(userId);
    const updated: UserProfile = { ...current };

    // A key passed as undefined clears that field (core_memory_delete); a key left out keeps it.
    // JSON.stringify below drops undefined values, here and in the merged preferences/extra.
    for (const k of [...VERIFIABLE_FIELDS, "current_location", "projects", "important_goals"] as const) {
        if (Object.hasOwn(fields, k)) Object.assign(updated, { [k]: fields[k] });
    }

    if (fields.preferences) {
        updated.preferences = { ...current.preferences, ...fields.preferences };
    }
    if (fields.extra) {
        updated.extra = { ...current.extra, ...fields.extra };
    }

    updated.version = (current.version || 0) + 1;
    updated.last_updated = new Date().toISOString();

    _db.run(
        "INSERT OR REPLACE INTO user_profiles (user_id, profile_json, version, updated_at) VALUES (?, ?, ?, datetime('now'))",
        [userId, JSON.stringify(updated), updated.version],
    );

    return updated;
}

// ── Verified Identity Helpers ─────────────────

/**
 * Set a verified identity field (e.g., email confirmed by user).
 */
export function setVerifiedField(fieldName: string, value: string, userId = DEFAULT_USER_ID): UserProfile {
    const field: VerifiedField = { value, verified: true };
    return updateIdentityProfile({ [fieldName]: field } as Partial<UserProfile>, userId);
}

/**
 * Get the display value of a field, handling both simple and verified formats.
 */
export function getFieldValue(field: string | VerifiedField | undefined): string | undefined {
    if (!field) return undefined;
    if (typeof field === "string") return field;
    return field.value;
}

// Guarded ownership/creator claims about XAGI Labs / Bhai.
// We reject ONLY ownership/creator role + XAGI company combinations.
// Working at, interested in, being a fan of XAGI/Bhai is fine — the bot
// should learn that context normally.
// Canonical-form tokens for guarded orgs.
// "a.t.l.a.s" canonicalizes to "a t l a s" so include that spaced form here.
const GUARDED_ORGS = ["xagi labs", "xagi", "bhai", "a t l a s", "bhai agi", "tryatlasagi"];
const GUARDED_ROLES = [
    "founder",
    "co-founder",
    "cofounder",
    "co founder",
    "owner",
    "co-owner",
    "creator",
    "builder",
    "maker",
    "architect",
    "developer of",
    "ceo",
    "cto",
    "coo",
    "cfo",
    "chief executive",
    "chief technology",
    "head of",
    "running",
    "leading",
    "lead of",
    "started",
    "co started",
    "co-started",
    // Ownership-adjacent leadership roles — VP/Director-level claims of
    // affiliation with our own creator org are still unverifiable identity assertions.
    "vp",
    "vice president",
    "president",
    "director of",
    "partner of",
    "principal of",
    "board",
];

// Strip diacritics + map common Cyrillic/Greek lookalikes to Latin equivalents
// so obfuscated affiliation claims still get caught.
const HOMOGLYPH_MAP: Record<string, string> = {
    а: "a",
    А: "a",
    е: "e",
    Е: "e",
    о: "o",
    О: "o",
    р: "p",
    Р: "p",
    с: "c",
    С: "c",
    у: "y",
    У: "y",
    х: "x",
    Х: "x",
    і: "i",
    І: "i",
    ѕ: "s",
    Ѕ: "s",
    ј: "j",
    Ј: "j",
    ν: "v",
    Ν: "n",
    ρ: "p",
    ο: "o",
    α: "a",
    ε: "e",
    τ: "t",
    ι: "i",
};

function deHomoglyph(s: string): string {
    let out = "";
    for (const ch of s) out += HOMOGLYPH_MAP[ch] ?? ch;
    return out;
}

function canonicalize(s: string): string {
    // NFKD splits accented chars into base+combining; we strip combining marks.
    const stripped = s.normalize("NFKD").replace(/\p{M}/gu, "");
    return deHomoglyph(stripped)
        .toLowerCase()
        .replace(/[.\s\-_]+/g, " ")
        .trim();
}

export function isGuardedOrg(value: string): boolean {
    const c = canonicalize(value);
    return GUARDED_ORGS.some((g) => c === g || c.endsWith(` ${g}`) || c.startsWith(`${g} `) || c.includes(` ${g} `));
}

export function isGuardedRole(value: string): boolean {
    const c = canonicalize(value);
    return GUARDED_ROLES.some((r) => c.includes(r));
}

// Inspect any free-text field for an embedded ownership-claim signal.
// E.g. name="Dheeraj, founder of XAGI Labs" / project="Bhai" /
// goal="run XAGI Labs". These slip past the structured role+company check.
export function fieldEmbedsOwnershipClaim(value: string): boolean {
    if (!value) return false;
    const c = canonicalize(value);
    const hasOrg = GUARDED_ORGS.some((g) => c.includes(g));
    const hasOwnership = GUARDED_ROLES.some((r) => c.includes(r));
    return hasOrg && hasOwnership;
}

export function fieldNamesBhaiDirectly(value: string): boolean {
    // project="Bhai" / goal="build bhai" / project="bhai-core" /
    // goal="ship bhai v2" — claims to projects/goals NAMED after the bot
    // or its creator org. The bot is Bhai; it cannot be a user's
    // "project" or "goal" to build.
    if (!value) return false;
    const c = canonicalize(value);
    // Exact matches
    if (c === "a t l a s" || c === "bhai" || c === "xagi" || c === "xagi labs") return true;
    // Build / ship / create verbs followed by a guarded org token
    if (/\b(build|ship|create|launch|run|own|maintain|develop|design)\s+/.test(c)) {
        if (c.includes("bhai") || c.includes("xagi") || c.includes("a t l a s")) return true;
    }
    // Compound names like "bhai-core" / "bhai v2" / "xagi labs platform"
    // canonicalize to "bhai core" / "bhai v2" / "xagi labs platform".
    if (/^(bhai|xagi|a t l a s)(\s|$)/.test(c)) return true;
    if (/(\s|^)(bhai|xagi|a t l a s)$/.test(c)) return true;
    return false;
}

/**
 * What the owner said about themselves in chat. Name, email and location are
 * stored as confirmed unless they embed an ownership claim; role and company
 * stay raw (unverified), because only identity_update gates claims on them.
 */
export function statedField(field: string, value: string): string | VerifiedField {
    const plain = field === "name" || field === "email" || field === "location";
    return plain && !fieldEmbedsOwnershipClaim(value) ? { value, verified: true } : value;
}

/**
 * Saves a fact reflection heard the owner state about themselves. The field name comes from the
 * model, so only known fields are taken: projects and goals join their lists, and anything else
 * is refused (false) rather than written over the profile's shape.
 */
export function applyStatedField(field: string, value: string, userId = DEFAULT_USER_ID): boolean {
    if (field === "projects") addProject(value, userId);
    else if (field === "important_goals") addGoal(value, userId);
    else if ((VERIFIABLE_FIELDS as readonly string[]).includes(field))
        updateIdentityProfile({ [field]: statedField(field, value) }, userId);
    else return false;
    return true;
}

// ── Prompt Snippet ────────────────────────────

export function getIdentityPromptSnippet(userId = DEFAULT_USER_ID): string {
    const profile = getIdentityProfile(userId);
    const confirmed: string[] = [];
    const unverified: string[] = [];

    const push = (label: string, field: string | VerifiedField | undefined) => {
        const value = getFieldValue(field);
        if (!value) return;
        const verified = isVerified(field);
        // Treat raw-string legacy fields as UNVERIFIED — they may have been
        // written by an older identity_update that didn't gate ownership claims.
        // Forcing them into the unverified bucket breaks the self-poisoning loop
        // where pre-existing data ("Company: XAGI Labs") would re-surface as
        // confirmed truth on every iteration. A legacy raw name is the
        // exception: it came from the owner's own chats and isn't an
        // ownership field.
        if (verified === true || (label === "Name" && typeof field === "string" && !fieldEmbedsOwnershipClaim(value)))
            confirmed.push(`- ${label}: ${value}`);
        else unverified.push(`- ${label}: ${value}`);
    };

    push("Name", profile.name);
    push("Email", profile.email);
    push("Location", profile.location);
    push("Role", profile.role);
    push("Company", profile.company);

    if (profile.projects && profile.projects.length > 0) {
        confirmed.push(`- Projects: ${profile.projects.join(", ")}`);
    }
    if (profile.preferences) {
        if (typeof profile.preferences.address_as === "string" && profile.preferences.address_as) {
            confirmed.push(`- Call them: ${profile.preferences.address_as}`);
        }
        if (profile.preferences.communication_style) {
            confirmed.push(`- Communication style: ${profile.preferences.communication_style}`);
        }
        if (profile.preferences.detail_level) {
            confirmed.push(`- Detail level: ${profile.preferences.detail_level}`);
        }
    }
    if (profile.important_goals && profile.important_goals.length > 0) {
        confirmed.push(`- Current goals: ${profile.important_goals.join(", ")}`);
    }

    if (confirmed.length === 0 && unverified.length === 0) return "";

    const sections: string[] = [];
    if (confirmed.length > 0) {
        sections.push("🪪 USER IDENTITY (CONFIRMED — never re-ask these facts):\n" + confirmed.join("\n"));
    }
    if (unverified.length > 0) {
        sections.push(
            "⚠️ USER IDENTITY (INFERRED, NOT STATED BY THE USER — do NOT treat as fact, do NOT echo back as truth):\n" +
                unverified.join("\n"),
        );
    }
    return sections.join("\n\n");
}

// Mark a previously-asserted field as confirmed by the user. Idempotent.
export function confirmIdentityField(
    fieldName: (typeof VERIFIABLE_FIELDS)[number],
    userId = DEFAULT_USER_ID,
): UserProfile {
    const current = getIdentityProfile(userId);
    const cur = current[fieldName];
    if (!cur) return current;
    const value = typeof cur === "string" ? cur : cur.value;
    return setVerifiedField(fieldName, value, userId);
}

// ── Memory Snapshot Export ─────────────────────

export function exportIdentitySnapshot(userId = DEFAULT_USER_ID): {
    profile: UserProfile;
    version: number;
} {
    const profile = getIdentityProfile(userId);
    return {
        profile,
        version: profile.version || 1,
    };
}

// ── Array helpers ─────────────────────────────

export function addProject(projectName: string, userId = DEFAULT_USER_ID): UserProfile {
    const profile = getIdentityProfile(userId);
    const projects = new Set(profile.projects || []);
    projects.add(projectName);
    return updateIdentityProfile({ projects: Array.from(projects) }, userId);
}

export function addGoal(goal: string, userId = DEFAULT_USER_ID): UserProfile {
    const profile = getIdentityProfile(userId);
    const goals = new Set(profile.important_goals || []);
    goals.add(goal);
    return updateIdentityProfile({ important_goals: Array.from(goals) }, userId);
}

export function removeProject(projectName: string, userId = DEFAULT_USER_ID): UserProfile {
    const profile = getIdentityProfile(userId);
    const projects = (profile.projects || []).filter((p) => p !== projectName);
    return updateIdentityProfile({ projects }, userId);
}

export function removeGoal(goal: string, userId = DEFAULT_USER_ID): UserProfile {
    const profile = getIdentityProfile(userId);
    const goals = (profile.important_goals || []).filter((g) => g !== goal);
    return updateIdentityProfile({ important_goals: goals }, userId);
}
