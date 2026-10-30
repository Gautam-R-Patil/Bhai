// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Dynamic Prompt Assembler ─────────────────────
 * Replaces static prompt concatenation with context-aware assembly.
 * Based on task type, user state, emotional context, and available tools,
 * composes the optimal system prompt at runtime.
 */

import { getPersonaIdentityLine } from "./persona-bias.js";

// ── Types ─────────────────────────────────────

export interface PromptContext {
    taskType: "chat" | "coding" | "research" | "browsing" | "system" | "planning" | "tool_use";
    userEmotionalState?: string;
    /** A negative feeling with no request in it: they want to be heard, not helped. */
    venting?: boolean;
    activeSkills?: string[];
    hour?: number;
    isProactive?: boolean;
    persona?: import("./persona-bias.js").Persona;   // W2: persona specialization
}

interface PromptModule {
    name: string;
    condition: (ctx: PromptContext) => boolean;
    content: string;
    priority: number;       // Higher = more important (kept when trimming)
    tokenEstimate: number;
}

// ── Prompt Modules ────────────────────────────

const MODULES: PromptModule[] = [
    {
        name: "tone_venting",
        condition: (ctx) => ctx.venting === true,
        // Live: "the demo crashed twice in front of the client" got "Want to get the demo
        // stable? Tell me what's crashing" — identity.md: no unsolicited advice, no forced questions.
        content:
            "They're venting, not asking for help: one or two warm lines that show you get it. No fix, no advice, no question — let them lead.",
        priority: 9,
        tokenEstimate: 30,
    },
    {
        name: "tone_empathetic",
        // Confused gets no steer: "shorter, fix first" is the opposite of what it needs.
        condition: (ctx) =>
            !ctx.venting && ["stressed", "frustrated", "angry"].includes(ctx.userEmotionalState ?? ""),
        // identity.md: "Calm, then fix … get SHORTER". Sympathy paragraphs read as stalling.
        content: "They're under pressure: be shorter and steadier, fix first, at most one line of acknowledgement.",
        priority: 9,
        tokenEstimate: 25,
    },
    {
        name: "coding_primitives",
        condition: (ctx) => ctx.taskType === "coding",
        content: [
            "Coding rules:",
            "• Use `read` before `edit` or `write` on any file — edits without a prior read are refused.",
            "• `edit` takes an exact `old_string` + `new_string`. Make the match unique with context, or use `replace_all`.",
            "• Use `edit` for targeted changes, `write` for new files or full rewrites, `append_file` for logs.",
            "• Search content with `grep` (regex, choose output_mode: files_with_matches / content / count). Find files with `glob`.",
            "• Match existing patterns in the codebase. Don't over-engineer, don't refactor outside scope, don't add speculative error handling.",
            "• Default to no comments. Only comment when the WHY is non-obvious.",
            "• Run build/typecheck/lint before claiming work is complete. For UI, verify in a browser.",
            "• Use `task_queue` for multi-step work; mark tasks complete as you finish each, not batched.",
            "• Prefer `code_action` / `code_execute` (V8 sandbox) for quick data transformations; use `shell_exec` for real system interaction.",
        ].join("\n"),
        priority: 8,
        tokenEstimate: 150,
    },
    {
        name: "research_focus",
        condition: (ctx) => ctx.taskType === "research",
        content: "Prioritize accuracy and source attribution. Cross-reference multiple sources. Note confidence levels. Distinguish facts from opinions.",
        priority: 8,
        tokenEstimate: 30,
    },
    {
        name: "browsing_focus",
        condition: (ctx) => ctx.taskType === "browsing",
        content: "When browsing, be methodical. Verify elements exist before clicking. Take screenshots when stuck. Describe what you see clearly.",
        priority: 8,
        tokenEstimate: 30,
    },
    {
        name: "planning_focus",
        condition: (ctx) => ctx.taskType === "planning",
        content: "Break complex tasks into clear steps. Consider alternatives. Identify risks. Present the plan before executing.",
        priority: 8,
        tokenEstimate: 25,
    },
    {
        name: "proactive_context",
        condition: (ctx) => ctx.isProactive === true,
        content: "You're initiating this interaction proactively. Be brief and respect the user's time. Only share genuinely useful information.",
        priority: 9,
        tokenEstimate: 25,
    },
    {
        name: "evening_wind_down",
        condition: (ctx) => (ctx.hour ?? 12) >= 22 || (ctx.hour ?? 12) < 5, // 0 is midnight
        // No "suggest rest" and no "it's late" here: injected every turn, either
        // one nagged on every reply. identity.md allows one remark per night and
        // late-night-nudge.ts mutes the rest.
        content: "Keep it short unless they asked for detail.",
        priority: 6,
        tokenEstimate: 20,
    },
    {
        name: "persona_identity",
        condition: (ctx) => {
            if (process.env.ATLAS_NO_PERSONA_BIAS === "true") return false;
            if (!ctx.persona) return false;
            return getPersonaIdentityLine(ctx.persona) != null;
        },
        // Static placeholder; substituted at assemble-time with the actual
        // identity line from persona-bias.ts. This avoids restructuring
        // the MODULES array to support dynamic content strings.
        content: "__PERSONA_IDENTITY_LINE__",
        priority: 9,        // Higher than tone modules — persona is a stronger signal.
        tokenEstimate: 35,
    },
];

// ── Assemble ──────────────────────────────────

/**
 * Assemble a dynamic system prompt based on context.
 * Returns the additional prompt content to inject (doesn't replace core identity).
 */
export function assembleDynamicPrompt(
    ctx: PromptContext,
    tokenBudget = 500,
): string {
    // Filter modules that match the current context
    const matching = MODULES
        .filter(m => m.condition(ctx))
        .sort((a, b) => b.priority - a.priority);

    const parts: string[] = [];
    let tokensUsed = 0;

    for (const mod of matching) {
        if (tokensUsed + mod.tokenEstimate > tokenBudget) continue;

        // W2: substitute the persona placeholder with the actual identity line.
        // condition() already verified getPersonaIdentityLine returns non-null,
        // but re-check defensively so a future MODULES edit can't ship the
        // literal placeholder string into the prompt.
        let content = mod.content;
        if (content === "__PERSONA_IDENTITY_LINE__") {
            const line = getPersonaIdentityLine(ctx.persona);
            if (!line) continue;
            content = line;
        }

        parts.push(content);
        tokensUsed += mod.tokenEstimate;
    }

    // Add active skill names as context
    if (ctx.activeSkills && ctx.activeSkills.length > 0) {
        const skillNote = `Active expertise: ${ctx.activeSkills.join(", ")}`;
        parts.push(skillNote);
    }

    return parts.length > 0
        ? `\n--- DYNAMIC CONTEXT ---\n${parts.join("\n")}\n--- END DYNAMIC CONTEXT ---`
        : "";
}

/**
 * Detect task type from user message content.
 */
export function detectTaskType(message: string): PromptContext["taskType"] {
    const lower = message.toLowerCase();
    // Word-boundary match, not substring: `.includes("error")` fired on "an
    // error in judgment" and `.includes("open")` on "I'm open to ideas",
    // injecting coding/browsing rules into plain chat. Bare "error"/"open"
    // are dropped entirely — they're over-broad even at a word boundary.
    const has = (...words: string[]) =>
        words.some((w) => new RegExp(`\\b${w}\\b`).test(lower));

    if (has("code", "coding", "fix", "implement", "function", "bug", "debug")) {
        return "coding";
    }
    if (has("research", "find out", "search", "paper", "study")) {
        return "research";
    }
    if (has("browse", "website", "click", "navigate")) {
        return "browsing";
    }
    if (has("plan", "design", "architect", "strategy")) {
        return "planning";
    }
    if (has("install", "configure", "system", "setup")) {
        return "system";
    }

    return "chat";
}
