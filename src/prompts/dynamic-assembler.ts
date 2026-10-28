// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
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
    relationshipDepth?: number;
    preferredLength?: "terse" | "normal" | "detailed";
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
        name: "tone_terse",
        condition: (ctx) => ctx.preferredLength === "terse",
        content: "Be extremely concise. Short sentences. No filler. Skip pleasantries.",
        priority: 8,
        tokenEstimate: 20,
    },
    {
        name: "tone_detailed",
        condition: (ctx) => ctx.preferredLength === "detailed",
        content: "Provide thorough explanations with examples. The user appreciates depth.",
        priority: 8,
        tokenEstimate: 20,
    },
    {
        name: "tone_empathetic",
        condition: (ctx) => ctx.userEmotionalState === "stressed" || ctx.userEmotionalState === "frustrated",
        // identity.md: "Calm, then fix … get SHORTER". Sympathy paragraphs read as stalling.
        content: "They're under pressure: be shorter and steadier, fix first, at most one line of acknowledgement.",
        priority: 9,
        tokenEstimate: 25,
    },
    {
        name: "tone_casual",
        condition: (ctx) => (ctx.relationshipDepth || 0) > 0.7,
        content: "You have a close relationship with this user. Be casual, use their style, joke where appropriate.",
        priority: 7,
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
        content: "Keep responses brief.",
        priority: 6,
        tokenEstimate: 20,
    },
    {
        name: "morning_energy",
        condition: (ctx) => (ctx.hour ?? 12) >= 6 && (ctx.hour ?? 12) < 10,
        content: "It's morning. Be calm and forward-looking. Surface priorities for the day if relevant.",
        priority: 5,
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

    if (lower.includes("code") || lower.includes("fix") || lower.includes("implement") ||
        lower.includes("function") || lower.includes("bug") || lower.includes("error")) {
        return "coding";
    }
    if (lower.includes("research") || lower.includes("find out") || lower.includes("search") ||
        lower.includes("paper") || lower.includes("study")) {
        return "research";
    }
    if (lower.includes("browse") || lower.includes("website") || lower.includes("click") ||
        lower.includes("open") || lower.includes("navigate")) {
        return "browsing";
    }
    if (lower.includes("plan") || lower.includes("design") || lower.includes("architect") ||
        lower.includes("strategy")) {
        return "planning";
    }
    if (lower.includes("install") || lower.includes("configure") || lower.includes("system") ||
        lower.includes("setup")) {
        return "system";
    }

    return "chat";
}
