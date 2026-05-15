// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

// Agent-facing self-improvement tools. The bot drafts learnings throughout
// the day to a LOCAL SQLite buffer; the nightly dream-replay synthesis pass
// merges them and posts to the server (user_prompt_addenda). The local
// buffer is ephemeral — drafts get deleted after they're merged upstream.
//
// Slug conventions:
//   "self-improvement"      — general personality/behavior learnings
//   "skill-<topic>"         — custom skill addendum for a domain
//   "memory-<topic>"        — factual context worth keeping in prompt form
// The wizard/Settings UI owns slug "user-personality" exclusively — the
// agent must NEVER write to it. Attempts to draft to that slug are refused.

import type { ToolDefinition } from "./get-current-time.js";
import {
    addDraft,
    discardDraft,
    listDrafts,
} from "../memory/self-improvement-drafts.js";

const RESERVED_USER_OWNED_SLUGS = new Set(["user-personality"]);

function validateSlug(slug: string, kind: string): string | null {
    if (!slug || slug.length < 3 || slug.length > 64) return "slug must be 3-64 chars";
    if (!/^[a-z0-9-]+$/.test(slug)) return "slug must be kebab-case (lowercase letters, digits, dashes)";
    if (RESERVED_USER_OWNED_SLUGS.has(slug)) return `slug '${slug}' is reserved for user-controlled settings — the agent cannot write to it`;
    // Reserved system slug-prefixes
    const RESERVED_PREFIXES = ["rules", "identity", "browsing", "coding", "thinking", "spec", "orchestrator"];
    if (RESERVED_PREFIXES.some((p) => slug === p || slug.startsWith(p + "-") || slug.startsWith(p + "_"))) {
        return `slug '${slug}' collides with a core system slug`;
    }
    // Enforce kind-prefix for skill/memory slugs to avoid ambiguity
    if (kind === "skill" && !slug.startsWith("skill-")) return "skill addenda must use slug prefix 'skill-'";
    if (kind === "memory" && !slug.startsWith("memory-")) return "memory addenda must use slug prefix 'memory-'";
    return null;
}

export const selfImprovementDraft: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "self_improvement_draft",
            description:
                "Save a learning, observation, or skill note to your LOCAL self-improvement draft buffer. The buffer accumulates throughout the day; nightly synthesis merges all drafts for a slug into one coherent addendum and persists it to the server. Use sparingly — only for non-obvious patterns worth carrying into future conversations.\n\nWhen to call: user expressed a stable preference, your behavior caused a problem you should avoid repeating, you noticed a recurring task pattern worth codifying as a skill. Do NOT call for ephemeral details (those go to memory_store) or routine acknowledgments.\n\nSlug conventions: 'self-improvement' for general personality/behavior; 'skill-<topic>' for custom skill modules; 'memory-<topic>' for factual context.",
            parameters: {
                type: "object",
                properties: {
                    kind: {
                        type: "string",
                        enum: ["personality", "skill", "memory"],
                        description: "personality = how you should behave with this user; skill = a procedure for a recurring task; memory = factual context worth keeping in prompt form",
                    },
                    slug: {
                        type: "string",
                        description: "kebab-case slug. Use 'self-improvement' for general personality learnings, or 'skill-<topic>' / 'memory-<topic>'.",
                    },
                    content: {
                        type: "string",
                        description: "Markdown content of the draft (the learning itself, written from your perspective). Max 50KB.",
                    },
                    reason: {
                        type: "string",
                        description: "One-line explanation of why you're drafting this — what happened that made you want to remember it.",
                    },
                },
                required: ["kind", "slug", "content", "reason"],
            },
        },
    },
    async handler(input) {
        const kind = input.kind as "personality" | "skill" | "memory";
        const slug = input.slug as string;
        const content = input.content as string;
        const reason = input.reason as string;

        const err = validateSlug(slug, kind);
        if (err) return JSON.stringify({ success: false, error: err });
        if (!content || content.trim().length < 10) {
            return JSON.stringify({ success: false, error: "content must be at least 10 chars" });
        }
        if (!reason || reason.trim().length < 8) {
            return JSON.stringify({ success: false, error: "reason must be at least 8 chars" });
        }

        try {
            const { id } = addDraft({ kind, slug, content, reason });
            return JSON.stringify({
                success: true,
                id,
                message: `Draft saved locally (slug: ${slug}). Will be merged + persisted server-side tonight during dream replay.`,
            });
        } catch (e) {
            return JSON.stringify({ success: false, error: (e as Error).message });
        }
    },
};

export const selfImprovementListDrafts: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "self_improvement_list_drafts",
            description: "List your local self-improvement drafts (those waiting for nightly synthesis). Useful for checking what you've already noted before drafting a duplicate.",
            parameters: {
                type: "object",
                properties: {
                    slug: { type: "string", description: "Optional — filter to one slug" },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const rows = listDrafts(input.slug as string | undefined);
            return JSON.stringify({
                success: true,
                drafts: rows.map((r) => ({
                    id: r.id,
                    kind: r.kind,
                    slug: r.slug,
                    content_preview: r.content.slice(0, 160),
                    reason: r.reason,
                    age_min: Math.round((Date.now() - r.createdAt) / 60_000),
                })),
            });
        } catch (e) {
            return JSON.stringify({ success: false, error: (e as Error).message });
        }
    },
};

export const selfImprovementDiscardDraft: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "self_improvement_discard_draft",
            description: "Discard a self-improvement draft you decided was wrong or no longer relevant. Pass the id from self_improvement_list_drafts.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "number", description: "Draft id to remove" },
                },
                required: ["id"],
            },
        },
    },
    async handler(input) {
        try {
            const id = typeof input.id === "number" ? input.id : parseInt(input.id as string, 10);
            if (!Number.isInteger(id) || id <= 0) {
                return JSON.stringify({ success: false, error: "id must be a positive integer" });
            }
            discardDraft(id);
            return JSON.stringify({ success: true });
        } catch (e) {
            return JSON.stringify({ success: false, error: (e as Error).message });
        }
    },
};
