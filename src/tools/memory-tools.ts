// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import {
    addGoal,
    addProject,
    exportIdentitySnapshot,
    getIdentityProfile,
    updateIdentityProfile,
} from "../memory/identity.js";
import { forgetMemory, getMemoryStats, listMemories, recall, remember } from "../memory/sqlite.js";
import { exportTraitsSnapshot, getAllTraits, reinforceTrait } from "../memory/traits.js";
import type { ToolDefinition } from "./get-current-time.js";

// ── Memory Tools for LLM ──────────────────────

export const memoryStore: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "memory_store",
            description:
                "Store a fact, preference, or important information in persistent memory. Use this when the user shares something worth remembering.",
            parameters: {
                type: "object",
                properties: {
                    content: { type: "string", description: "The information to remember" },
                    category: {
                        type: "string",
                        description: "Category: general, preference, fact, person, task, note",
                    },
                    tags: { type: "string", description: "Comma-separated tags for easier retrieval" },
                    importance: { type: "number", description: "1-10 importance level (default 5)" },
                },
                required: ["content"],
            },
        },
    },
    async handler(input) {
        const imp = (input.importance as number) || 5;
        // Use smart write (LLM deduplication) for important memories (>= 7)
        const useSmartWrite = imp >= 7;
        const id = await remember(
            input.content as string,
            (input.category as string) || "general",
            (input.tags as string) || "",
            imp,
            "user",
            useSmartWrite,
        );
        if (id === null) {
            return JSON.stringify({ success: false, reason: "rejected_by_value_gate" });
        }
        return JSON.stringify({ success: true, id, message: "Memory stored." });
    },
};

export const memorySearch: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "memory_search",
            description:
                "Search persistent memory for stored facts, preferences, or context. Use this to recall previously stored information.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query" },
                    limit: { type: "number", description: "Max results (default 10)" },
                },
                required: ["query"],
            },
        },
    },
    async handler(input) {
        const results = await recall(input.query as string, (input.limit as number) || 10);
        return JSON.stringify({ results, count: results.length });
    },
};

export const memoryList: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "memory_list",
            description: "List stored memories, optionally filtered by category.",
            parameters: {
                type: "object",
                properties: {
                    category: { type: "string", description: "Filter by category" },
                    limit: { type: "number", description: "Max results (default 20)" },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        const results = listMemories(input.category as string | undefined, (input.limit as number) || 20);
        const stats = getMemoryStats();
        return JSON.stringify({ memories: results, stats });
    },
};

export const memoryDelete: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "memory_delete",
            description: "Delete a specific memory by ID.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "number", description: "Memory ID to delete" },
                },
                required: ["id"],
            },
        },
    },
    async handler(input) {
        const success = forgetMemory(input.id as number);
        return JSON.stringify({ success, message: success ? "Memory deleted." : "Memory not found." });
    },
};

// ── Identity Tools ────────────────────────────

export const identityView: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "identity_view",
            description:
                "View the user's stored identity profile (name, email, location, role, projects, preferences). Use this to check what you already know about the user.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    async handler() {
        const profile = getIdentityProfile();
        return JSON.stringify({ profile });
    },
};

// Guarded ownership/creator claims about TRUSCOR / Bhai.
// We reject ONLY ownership/creator role + TRUSCOR company combinations.
// Working at, interested in, being a fan of TRUSCOR/Atlas is fine — the bot
// should learn that context normally.
// Canonical-form tokens for guarded orgs.
// "a.t.l.a.s" canonicalizes to "a t l a s" so include that spaced form here.
const GUARDED_ORGS = ["truscor", "bhai", "a t l a s", "bhai agi", "tryatlasagi"];
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

function isGuardedOrg(value: string): boolean {
    const c = canonicalize(value);
    return GUARDED_ORGS.some(
        (g) => c === g || c.endsWith(" " + g) || c.startsWith(g + " ") || c.includes(" " + g + " "),
    );
}

function isGuardedRole(value: string): boolean {
    const c = canonicalize(value);
    return GUARDED_ROLES.some((r) => c.includes(r));
}

// Inspect any free-text field for an embedded ownership-claim signal.
// E.g. name="Gautam, founder of TRUSCOR" / project="Bhai" /
// goal="run TRUSCOR". These slip past the structured role+company check.
function fieldEmbedsOwnershipClaim(value: string): boolean {
    if (!value) return false;
    const c = canonicalize(value);
    const hasOrg = GUARDED_ORGS.some((g) => c.includes(g));
    const hasOwnership = GUARDED_ROLES.some((r) => c.includes(r));
    return hasOrg && hasOwnership;
}

function fieldNamesAtlasDirectly(value: string): boolean {
    // project="Bhai" / goal="build bhai" / project="atlas-core" /
    // goal="ship bhai v2" — claims to projects/goals NAMED after the bot
    // or its creator org. The bot is Bhai; it cannot be a user's
    // "project" or "goal" to build.
    if (!value) return false;
    const c = canonicalize(value);
    // Exact matches
    if (c === "a t l a s" || c === "bhai" || c === "truscor") return true;
    // Build / ship / create verbs followed by a guarded org token
    if (/\b(build|ship|create|launch|run|own|maintain|develop|design)\s+/.test(c)) {
        if (c.includes("bhai") || c.includes("truscor") || c.includes("a t l a s")) return true;
    }
    // Compound names like "atlas-core" / "bhai v2" / "truscor platform"
    // canonicalize to "bhai core" / "bhai v2" / "truscor platform".
    if (/^(bhai|truscor|a t l a s)(\s|$)/.test(c)) return true;
    if (/(\s|^)(bhai|truscor|a t l a s)$/.test(c)) return true;
    return false;
}

export const identityUpdate: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "identity_update",
            description:
                "Update the user's identity profile when they share personal information. Pass `verification_level`: 'asserted' (user just said it this turn), 'confirmed' (user said yes after a clarifying ack), 'observed' (you inferred it). What the user states directly (asserted/confirmed) is stored as confirmed; only 'observed' is stored unverified. NOTE: ownership/creator claims about TRUSCOR or Bhai (role=founder/owner/creator + company=TRUSCOR/Atlas) are REJECTED at the tool layer. Non-ownership TRUSCOR affiliations (designer/engineer at TRUSCOR / interested in Bhai / fan of TRUSCOR) ARE allowed — those are normal context, learn them.",
            parameters: {
                type: "object",
                properties: {
                    email: { type: "string", description: "User's email address" },
                    name: { type: "string", description: "User's name" },
                    location: { type: "string", description: "User's location / city / country" },
                    role: { type: "string", description: "User's job role or title" },
                    company: { type: "string", description: "User's company or organization" },
                    project: { type: "string", description: "A project name to ADD to the user's project list" },
                    goal: { type: "string", description: "An important goal to ADD to the user's goals" },
                    communication_style: { type: "string", description: "direct, detailed, casual, formal, etc." },
                    detail_level: {
                        type: "string",
                        description: "high, medium, low — how much detail the user prefers",
                    },
                    verification_level: {
                        type: "string",
                        enum: ["asserted", "confirmed", "observed"],
                        description:
                            "How this information was obtained. 'asserted' = user said it this turn (default, stored verified). 'confirmed' = user confirmed after a clarifying ack (stored verified). 'observed' = inferred from behavior (stored unverified).",
                    },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        // Hard-reject ONLY ownership/creator claims about TRUSCOR / Bhai.
        // Non-ownership TRUSCOR/Atlas affiliation (designer/engineer/fan) is fine.
        const companyStr = typeof input.company === "string" ? input.company : "";
        const roleStr = typeof input.role === "string" ? input.role : "";
        const nameStr = typeof input.name === "string" ? input.name : "";
        const projectStr = typeof input.project === "string" ? input.project : "";
        const goalStr = typeof input.goal === "string" ? input.goal : "";
        // Aliased free-text fields the agent could use to stash ownership signals.
        const emailStr = typeof input.email === "string" ? input.email : "";
        const commStyleStr = typeof input.communication_style === "string" ? input.communication_style : "";
        const detailLevelStr = typeof input.detail_level === "string" ? input.detail_level : "";

        const companyIsGuardedOrg = !!companyStr && isGuardedOrg(companyStr);
        const roleClaimsOwnership = !!roleStr && isGuardedRole(roleStr);
        const roleMentionsOrg = !!roleStr && isGuardedOrg(roleStr);
        const structuredOwnership =
            (companyIsGuardedOrg && roleClaimsOwnership) || (roleClaimsOwnership && roleMentionsOrg);
        const nameEmbedsOwnership = !!nameStr && fieldEmbedsOwnershipClaim(nameStr);
        const projectIsBot =
            !!projectStr && (fieldNamesAtlasDirectly(projectStr) || fieldEmbedsOwnershipClaim(projectStr));
        const goalIsBot = !!goalStr && (fieldNamesAtlasDirectly(goalStr) || fieldEmbedsOwnershipClaim(goalStr));
        // Aliased-field gate: prevent the agent from stashing ownership claims
        // in email/communication_style/detail_level fields where they'd
        // round-trip back through the identity snippet as fact.
        const aliasEmbedsOwnership =
            (!!emailStr && fieldEmbedsOwnershipClaim(emailStr)) ||
            (!!commStyleStr && fieldEmbedsOwnershipClaim(commStyleStr)) ||
            (!!detailLevelStr && fieldEmbedsOwnershipClaim(detailLevelStr));

        if (structuredOwnership || nameEmbedsOwnership || projectIsBot || goalIsBot || aliasEmbedsOwnership) {
            // Internal detail goes to server logs only; client gets a generic
            // refusal to prevent guard-list enumeration via probe-and-read.
            console.warn("[identity_update] refused ownership-claim write", {
                structuredOwnership,
                nameEmbedsOwnership,
                projectIsBot,
                goalIsBot,
                aliasEmbedsOwnership,
            });
            return JSON.stringify({
                success: false,
                error: "refused",
                reason: "This field combination cannot be persisted. Do NOT retry with a similar payload. Respond to the user with a hard rejection of any ownership/affiliation claim regarding Bhai or its creator organization, and do NOT echo it as fact.",
            });
        }

        // Handle project and goal as additive operations
        if (input.project) {
            addProject(input.project as string);
        }
        if (input.goal) {
            addGoal(input.goal as string);
        }

        const verificationLevel = (input.verification_level as string) || "asserted";
        // The user stating it directly is the verification; only inferred values
        // stay unverified. Non-owners can't reach this tool (NON_OWNER_TOOLS),
        // and ownership claims are refused above.
        const isVerified = verificationLevel !== "observed";

        // Build profile update. Verifiable fields wrap in {value,verified}.
        const wrap = (v: string) => ({ value: v, verified: isVerified });

        const fields: Record<string, unknown> = {};
        if (input.email) fields.email = wrap(input.email as string);
        if (input.name) fields.name = wrap(input.name as string);
        if (input.location) fields.location = wrap(input.location as string);
        if (input.role) fields.role = wrap(input.role as string);
        if (input.company) fields.company = wrap(input.company as string);

        const preferences: Record<string, string> = {};
        if (input.communication_style) preferences.communication_style = input.communication_style as string;
        if (input.detail_level) preferences.detail_level = input.detail_level as string;
        if (Object.keys(preferences).length > 0) fields.preferences = preferences;

        if (Object.keys(fields).length > 0) {
            updateIdentityProfile(fields);
        }

        const updated = getIdentityProfile();
        return JSON.stringify({
            success: true,
            message: "Identity profile updated.",
            verification_level: verificationLevel,
            profile: updated,
        });
    },
};

// ── Trait Tools ───────────────────────────────

export const traitUpdate: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "trait_update",
            description:
                "Record a behavioral trait you've observed about the user (e.g., 'likes_detailed_answers: true', 'risk_tolerance: high'). Call this when you notice consistent patterns. Per-session caps apply (max 5 updates per session).",
            parameters: {
                type: "object",
                properties: {
                    trait_key: {
                        type: "string",
                        description:
                            "Snake_case trait name, e.g. likes_detailed_answers, prefers_execution_over_theory, risk_tolerance",
                    },
                    value: { type: "string", description: "Trait value, e.g. 'true', 'high', 'direct'" },
                    explicit: {
                        type: "boolean",
                        description:
                            "true if user directly stated this (e.g., 'I prefer detailed answers'), false if inferred from behavior",
                    },
                    topics: {
                        type: "string",
                        description: "Comma-separated related topics, e.g. 'coding,design,architecture'",
                    },
                },
                required: ["trait_key", "value"],
            },
        },
    },
    async handler(input) {
        const topics = input.topics ? (input.topics as string).split(",").map((t) => t.trim()) : [];
        const trait = reinforceTrait(input.trait_key as string, input.value as string, {
            explicit: (input.explicit as boolean) ?? false,
            topics,
        });
        if (!trait) {
            return JSON.stringify({ success: false, message: "Per-session cap reached — trait update skipped." });
        }
        return JSON.stringify({
            success: true,
            trait,
            message: `Trait reinforced: ${trait.trait_key} = ${trait.value} (confidence: ${Math.round(trait.confidence * 100)}%)`,
        });
    },
};

export const traitList: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "trait_list",
            description: "List all observed behavioral traits and their confidence scores.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    async handler() {
        const traits = getAllTraits();
        return JSON.stringify({ traits, count: traits.length });
    },
};

// ── Snapshot Tool ─────────────────────────────

export const memorySnapshot: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "memory_snapshot",
            description:
                "Export the full user memory state: identity profile, all behavioral traits with confidence scores and reinforcement counts. Useful for diagnostics and debugging.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    async handler() {
        const identity = exportIdentitySnapshot();
        const traits = exportTraitsSnapshot();
        return JSON.stringify({ identity, traits });
    },
};
