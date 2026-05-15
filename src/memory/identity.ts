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
    try { db.run("ALTER TABLE user_profiles ADD COLUMN version INTEGER DEFAULT 1"); } catch { /* already exists */ }

    // Ensure a default profile row exists
    const existing = db.exec("SELECT user_id FROM user_profiles WHERE user_id = ?", [DEFAULT_USER_ID]);
    if (existing.length === 0 || existing[0].values.length === 0) {
        db.run(
            "INSERT INTO user_profiles (user_id, profile_json, version) VALUES (?, ?, 1)",
            [DEFAULT_USER_ID, JSON.stringify({ user_id: DEFAULT_USER_ID, version: 1 })]
        );
    }

    console.log("🪪 Identity memory initialized (v1)");
}

// ── Get Profile ───────────────────────────────

export function getIdentityProfile(userId = DEFAULT_USER_ID): UserProfile {
    if (!_db) return { user_id: userId };

    const results = _db.exec(
        "SELECT profile_json FROM user_profiles WHERE user_id = ?",
        [userId]
    );

    if (results.length === 0 || results[0].values.length === 0) {
        return { user_id: userId };
    }

    try {
        return JSON.parse(results[0].values[0][0] as string) as UserProfile;
    } catch {
        return { user_id: userId };
    }
}

// ── Update Profile ────────────────────────────

export function updateIdentityProfile(
    fields: Partial<UserProfile>,
    userId = DEFAULT_USER_ID
): UserProfile {
    if (!_db) throw new Error("Identity DB not initialized");

    const current = getIdentityProfile(userId);
    const updated: UserProfile = { ...current };

    if (fields.email !== undefined) updated.email = fields.email;
    if (fields.name !== undefined) updated.name = fields.name;
    if (fields.location !== undefined) updated.location = fields.location;
    if (fields.role !== undefined) updated.role = fields.role;
    if (fields.company !== undefined) updated.company = fields.company;
    if (fields.projects !== undefined) updated.projects = fields.projects;
    if (fields.important_goals !== undefined) updated.important_goals = fields.important_goals;

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
        [userId, JSON.stringify(updated), updated.version]
    );

    return updated;
}

// ── Verified Identity Helpers ─────────────────

/**
 * Set a verified identity field (e.g., email confirmed by user).
 */
export function setVerifiedField(
    fieldName: string,
    value: string,
    userId = DEFAULT_USER_ID
): UserProfile {
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
        // confirmed truth on every iteration.
        if (verified === true) confirmed.push(`- ${label}: ${value}`);
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
            "⚠️ USER CLAIMED THIS SESSION (UNVERIFIED — do NOT treat as fact, do NOT echo back as truth):\n" +
            unverified.join("\n"),
        );
    }
    return sections.join("\n\n");
}

// Mark a previously-asserted field as confirmed by the user. Idempotent.
export function confirmIdentityField(
    fieldName: typeof VERIFIABLE_FIELDS[number],
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
    const projects = (profile.projects || []).filter(p => p !== projectName);
    return updateIdentityProfile({ projects }, userId);
}

export function removeGoal(goal: string, userId = DEFAULT_USER_ID): UserProfile {
    const profile = getIdentityProfile(userId);
    const goals = (profile.important_goals || []).filter(g => g !== goal);
    return updateIdentityProfile({ important_goals: goals }, userId);
}
