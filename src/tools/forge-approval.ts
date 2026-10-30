// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Agent-facing tools for approving/revoking persisted dynamic tools.

import { approveDynamicTool, revokeDynamicTool } from "../forge/orchestrator.js";
import { isForgeReady } from "../forge/orchestrator.js";
import { getPlanModeState } from "../agents/plan-mode.js";
import { ownerApproved } from "../security/consent.js";

// Verbatim-quote audit-log gate (site-skill-mint) so agents can't shortcut by
// replaying "ok" or "approved" as user_quote.
const BANNED_USER_QUOTE_WORDS = new Set([
    "ok",
    "yes",
    "sure",
    "approved",
    "approve",
    "lgtm",
    "ship it",
    "looks good",
    "go ahead",
    "do it",
    "good",
    "fine",
]);

const MIN_USER_QUOTE_LENGTH = 10;

export function isQuoteAcceptable(quote: string): { ok: true } | { ok: false; reason: string } {
    const trimmed = quote.trim();
    if (trimmed.length < MIN_USER_QUOTE_LENGTH) {
        return { ok: false, reason: `user_quote must be ≥${MIN_USER_QUOTE_LENGTH} characters` };
    }
    const lower = trimmed.toLowerCase();
    if (BANNED_USER_QUOTE_WORDS.has(lower)) {
        return {
            ok: false,
            reason: `user_quote "${trimmed}" is too generic — paste the user's actual approval text verbatim`,
        };
    }
    return { ok: true };
}

export const approveDynamicToolTool = {
    schema: {
        type: "function" as const,
        function: {
            name: "approve_dynamic_tool",
            description:
                "Turn on a synthesized persistent tool after the owner said yes. The tool moves from awaiting_approval → active and becomes callable. user_quote is the owner's own yes from their latest message.",
            parameters: {
                type: "object",
                properties: {
                    slug: { type: "string", description: "Slug of the tool to approve" },
                    user_quote: {
                        type: "string",
                        description:
                            'The owner\'s own yes, copied from their latest message (e.g. "yes turn it on"). Used as an audit-log record.',
                    },
                },
                required: ["slug", "user_quote"],
            },
        },
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
        if (!isForgeReady()) {
            return JSON.stringify({ ok: false, error: "forge not ready" });
        }
        const slug = String(args.slug ?? "").trim();
        const userQuote = String(args.user_quote ?? "");
        if (!slug) {
            return JSON.stringify({ ok: false, error: "slug required" });
        }
        // The quote must come from the owner's latest message, sent after the
        // approval was requested, and that message must say yes (not no).
        if (!ownerApproved(userQuote, approvalRequestedAt())) {
            return JSON.stringify({
                ok: false,
                error: "user_quote must be the user's own yes from a message sent after you asked for approval. Ask them first.",
            });
        }
        const result = await approveDynamicTool(slug, userQuote);
        return JSON.stringify(result);
    },
};

export const revokeDynamicToolTool = {
    schema: {
        type: "function" as const,
        function: {
            name: "revoke_dynamic_tool",
            description:
                "Revoke a persisted dynamic tool. The tool is uninstalled, its sandbox worker dropped, and the library row archived.",
            parameters: {
                type: "object",
                properties: {
                    slug: { type: "string", description: "Slug of the tool to revoke" },
                },
                required: ["slug"],
            },
        },
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
        if (!isForgeReady()) {
            return JSON.stringify({ ok: false, error: "forge not ready" });
        }
        const slug = String(args.slug ?? "").trim();
        if (!slug) {
            return JSON.stringify({ ok: false, error: "slug required" });
        }
        await revokeDynamicTool(slug);
        return JSON.stringify({ ok: true });
    },
};

/** When the approval state began; "now" outside one (so no quote qualifies). */
function approvalRequestedAt(): number {
    const st = getPlanModeState();
    return "enteredAt" in st ? st.enteredAt : Date.now();
}
