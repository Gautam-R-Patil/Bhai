// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── generate_design_docs ──────────────────────
// For complex coding tasks, produce a trio of design artifacts:
//   • PRD.md           — what we're building and why
//   • TECHNICAL.md     — APIs, data models, tool choices
//   • ARCHITECTURE.md  — component layout + data flow + key decisions
//
// Docs land under A.T.L.A.S Files/Documents/<slug>/ by default so users
// can find them later. The tool returns the file paths so the agent
// can attach them to a channel message and wait for approval before
// executing. Markdown is the format for every channel — overlay
// renders inline, TG/WA attach as files.
//
// This is a scaffolding tool: it writes the docs using pre-filled
// templates derived from the task description + an LLM pass to flesh
// out the substantive sections. The LLM call happens in-tool so the
// caller doesn't need a separate step.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getConvexSiteUrl } from "../../config/keys.js";
import { getWorkspaceSubdir } from "../../config/paths.js";
import { encryptedFetch } from "../../crypto-transport.js";
import { auditLog } from "../../security/audit-log.js";
import { getSessionToken, handleAuthError } from "../../session.js";
import { logToolAction } from "../../utils/debug-log.js";
import type { ToolDefinition } from "../get-current-time.js";

interface DesignDocResult {
    slug: string;
    dir: string;
    files: { prd: string; technical: string; architecture: string };
}

function slugify(s: string): string {
    return (
        s
            .toLowerCase()
            .replace(/[^\w\s-]/g, "")
            .trim()
            .split(/\s+/)
            .slice(0, 6)
            .join("-")
            .slice(0, 48) || `design-${Date.now()}`
    );
}

const DOC_PROMPT = `You are a senior software engineer asked to write three short but concrete design documents for the task below.

Return ONLY a JSON object with this exact shape (all three fields required, markdown bodies only, no outer headings beyond what you write):

{
  "prd": "<markdown body for PRD.md — problem, user, success criteria, scope, out-of-scope>",
  "technical": "<markdown body for TECHNICAL.md — data model, APIs/interfaces, key algorithms, edge cases, testing strategy>",
  "architecture": "<markdown body for ARCHITECTURE.md — component diagram in ASCII or mermaid, data flow, key design decisions + rationale, risks>"
}

Be concrete. No filler. Each doc should be 200-600 words. Use # H1 for the top title and ## H2 for sections. Include at least one fenced code block or ASCII diagram in the architecture doc.

Task:
`;

async function generateDocBodies(
    task: string,
): Promise<{ prd: string; technical: string; architecture: string } | null> {
    try {
        const token = (await getSessionToken()) ?? (await handleAuthError());
        if (!token) return null;
        const url = `${getConvexSiteUrl()}/api/llm/chat`;
        const body = {
            model: "anthropic/claude-sonnet-4.6",
            max_tokens: 8192,
            messages: [{ role: "user", content: DOC_PROMPT + task }],
            response_format: { type: "json_object" },
            platform: process.platform,
            skillSlugs: [],
        };
        const res = await encryptedFetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) return null;
        const payload = (await res.json()) as {
            choices?: { message?: { content?: string } }[];
        };
        const text = payload?.choices?.[0]?.message?.content ?? "";
        // Parse the JSON out of the response (may or may not have fences)
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        const parsed = JSON.parse(jsonMatch[0]) as {
            prd?: unknown;
            technical?: unknown;
            architecture?: unknown;
        };
        if (typeof parsed.prd !== "string" || typeof parsed.technical !== "string" || typeof parsed.architecture !== "string") {
            return null;
        }
        return { prd: parsed.prd, technical: parsed.technical, architecture: parsed.architecture };
    } catch {
        return null;
    }
}

function fallbackBodies(task: string): { prd: string; technical: string; architecture: string } {
    // Offline / LLM-unavailable fallback — a scaffold the agent can fill
    // in itself via follow-up edits. Strictly better than no docs.
    const header = `> Auto-scaffolded from the task description. Edit freely before approval.\n\n`;
    return {
        prd: `# PRD — ${task.slice(0, 80)}\n\n${header}## Problem\n_Describe the user pain point._\n\n## Users\n_Who benefits?_\n\n## Success criteria\n- [ ] ...\n- [ ] ...\n\n## Scope\n- ...\n\n## Out of scope\n- ...\n`,
        technical: `# Technical design\n\n${header}## Data model\n_Schemas / tables / TS types._\n\n## APIs / interfaces\n_Function signatures or HTTP routes._\n\n## Algorithms\n_Key logic. Pseudocode when non-obvious._\n\n## Edge cases\n- ...\n\n## Testing strategy\n- ...\n`,
        architecture: `# Architecture\n\n${header}## Component diagram\n\n\`\`\`\n[user] → [layer A] → [layer B]\n\`\`\`\n\n## Data flow\n_Where does state live? What mutates it?_\n\n## Key decisions\n- **Decision**: _choice_ — _rationale_.\n\n## Risks\n- _What could go wrong._\n`,
    };
}

export const designDocsTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "generate_design_docs",
            description:
                "Generate PRD.md + TECHNICAL.md + ARCHITECTURE.md for a complex coding task. " +
                "Writes to the ATLAS workspace Documents folder by default so the user can find " +
                "them later. Returns the slug + file paths — pass these to your channel's sender " +
                "(send_message_on_channel with filePath, or include the markdown inline for overlay) " +
                "so the user can review before implementation. **Required** before implementing any " +
                "multi-file / new-feature / architectural change; skip for trivial edits.",
            parameters: {
                type: "object",
                properties: {
                    task: {
                        type: "string",
                        description: "The coding task as the user stated it (verbatim is fine).",
                    },
                    slug: {
                        type: "string",
                        description:
                            "Optional short slug for the output directory. Auto-derived from the task if omitted.",
                    },
                    parent_dir: {
                        type: "string",
                        description:
                            "Parent directory. Defaults to A.T.L.A.S Files/Documents/design-docs/.",
                    },
                },
                required: ["task"],
            },
        },
    },

    async handler(input) {
        const task = typeof input.task === "string" ? input.task.trim() : "";
        if (!task) return JSON.stringify({ success: false, error: "task description required" });
        const slug = typeof input.slug === "string" && input.slug ? slugify(input.slug) : slugify(task);
        const parent =
            typeof input.parent_dir === "string" && input.parent_dir
                ? path.resolve(input.parent_dir)
                : path.join(getWorkspaceSubdir("Documents"), "design-docs");
        if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
        const dir = path.join(parent, slug);
        mkdirSync(dir, { recursive: true });

        auditLog("generate_design_docs", { slug, dir });
        logToolAction({ tool: "generate_design_docs", filePath: dir, action: `drafting design docs for '${task.slice(0, 60)}'` });

        const bodies = (await generateDocBodies(task)) ?? fallbackBodies(task);
        const files = {
            prd: path.join(dir, "PRD.md"),
            technical: path.join(dir, "TECHNICAL.md"),
            architecture: path.join(dir, "ARCHITECTURE.md"),
        };
        try {
            writeFileSync(files.prd, bodies.prd, "utf-8");
            writeFileSync(files.technical, bodies.technical, "utf-8");
            writeFileSync(files.architecture, bodies.architecture, "utf-8");
        } catch (err) {
            return JSON.stringify({ success: false, error: `write failed: ${(err as Error).message}` });
        }
        const result: DesignDocResult = { slug, dir, files };
        return JSON.stringify({
            success: true,
            ...result,
            approval_hint:
                "Attach these three files to the current channel (use channel sender with filePath for each) " +
                "and ask the user 'approve, or what changes?' Do NOT start implementation until the user " +
                "explicitly approves or revises.",
        });
    },
};
