// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── generate_walkthrough ──────────────────────
// After a complex coding task completes, produce a WALKTHROUGH.md
// summarizing:
//   • What changed (from recent git commits + touched files)
//   • Why each change was made (commit messages carry the reasoning)
//   • How to try it (one-liner run commands)
//   • Known limitations / follow-ups
//
// Landed under A.T.L.A.S Files/Documents/walkthroughs/<slug>/ so users
// have a persistent record. Returns the file path so the agent can
// attach it to the channel along with a screenshot or recording.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getWorkspaceSubdir } from "../../config/paths.js";
import { auditLog } from "../../security/audit-log.js";
import { logToolAction } from "../../utils/debug-log.js";
import type { ToolDefinition } from "../get-current-time.js";

function slugify(s: string): string {
    return (
        s
            .toLowerCase()
            .replace(/[^\w\s-]/g, "")
            .trim()
            .split(/\s+/)
            .slice(0, 6)
            .join("-")
            .slice(0, 48) || `walkthrough-${Date.now()}`
    );
}

function gitLines(cwd: string, args: string[]): string[] {
    try {
        const out = execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
        return out.split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

export const walkthroughTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "generate_walkthrough",
            description:
                "Generate WALKTHROUGH.md after a coding task completes — summarizes the changes " +
                "(from git log + touched files), explains each one, and lists run commands + known " +
                "limitations. Returns the file path so the agent can attach it to the active channel. " +
                "Call this at the END of any multi-file / new-feature task so the user has a record " +
                "of what was shipped.",
            parameters: {
                type: "object",
                properties: {
                    task: { type: "string", description: "The task description this walkthrough covers." },
                    slug: { type: "string", description: "Optional output slug; auto-derived from task if omitted." },
                    since_commit: {
                        type: "string",
                        description: "Optional starting git SHA. If omitted, uses the last 10 commits on HEAD.",
                    },
                    run_commands: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional 'try it' commands to include (e.g. ['npm run dev', 'npm test']).",
                    },
                    notes: {
                        type: "string",
                        description: "Optional 'known limitations / follow-ups' free-text block.",
                    },
                    repo_root: { type: "string", description: "Git repo root (default: cwd)." },
                },
                required: ["task"],
            },
        },
    },

    async handler(input) {
        const task = typeof input.task === "string" ? input.task.trim() : "";
        if (!task) return JSON.stringify({ success: false, error: "task description required" });
        const slug = typeof input.slug === "string" && input.slug ? slugify(input.slug) : slugify(task);
        const repoRoot =
            typeof input.repo_root === "string" && input.repo_root ? path.resolve(input.repo_root) : process.cwd();
        const sinceRef = typeof input.since_commit === "string" && input.since_commit ? input.since_commit : "HEAD~10";
        const runCommands = Array.isArray(input.run_commands) ? (input.run_commands as string[]) : [];
        const notes = typeof input.notes === "string" ? input.notes.trim() : "";

        const commits = gitLines(repoRoot, ["log", "--pretty=format:%h %s", `${sinceRef}..HEAD`]);
        const touched = gitLines(repoRoot, ["diff", "--name-only", `${sinceRef}..HEAD`]);
        const shortStat = gitLines(repoRoot, ["diff", "--shortstat", `${sinceRef}..HEAD`]).join("\n");

        const parent = path.join(getWorkspaceSubdir("Documents"), "walkthroughs");
        if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
        const dir = path.join(parent, slug);
        mkdirSync(dir, { recursive: true });
        const outFile = path.join(dir, "WALKTHROUGH.md");

        const lines: string[] = [];
        lines.push(`# Walkthrough — ${task.slice(0, 100)}`);
        lines.push("");
        lines.push(`> Generated ${new Date().toISOString()} from commits ${sinceRef}..HEAD in \`${repoRoot}\``);
        lines.push("");
        lines.push("## What changed");
        if (commits.length === 0) {
            lines.push("- _No commits found in the requested range._");
        } else {
            for (const c of commits) lines.push(`- \`${c}\``);
        }
        lines.push("");
        if (shortStat) lines.push(`> ${shortStat}\n`);
        lines.push("## Files touched");
        if (touched.length === 0) {
            lines.push("- _None._");
        } else {
            for (const f of touched.slice(0, 40)) lines.push(`- \`${f}\``);
            if (touched.length > 40) lines.push(`- …and ${touched.length - 40} more.`);
        }
        lines.push("");
        lines.push("## Try it");
        if (runCommands.length === 0) {
            lines.push("- _Add your project's run command here — e.g._ `npm run dev`, `npm test`.");
        } else {
            for (const cmd of runCommands) lines.push(`\`\`\`bash\n${cmd}\n\`\`\``);
        }
        lines.push("");
        lines.push("## Notes / follow-ups");
        lines.push(notes || "- _None._");
        lines.push("");

        try {
            writeFileSync(outFile, lines.join("\n"), "utf-8");
        } catch (err) {
            return JSON.stringify({ success: false, error: `write failed: ${(err as Error).message}` });
        }

        auditLog("generate_walkthrough", { slug, dir, commits: commits.length, touched: touched.length });
        logToolAction({
            tool: "generate_walkthrough",
            filePath: outFile,
            action: `summarized ${commits.length} commits across ${touched.length} files`,
        });

        return JSON.stringify({
            success: true,
            path: outFile,
            slug,
            commits_included: commits.length,
            files_touched: touched.length,
            delivery_hint:
                "On overlay, display the markdown inline and also call os_screenshot to show the result. " +
                "On Telegram/WhatsApp/Discord, use send_message_on_channel with filePath=this path to send " +
                "the walkthrough, then attach a screenshot (os_screenshot) as a second message.",
        });
    },
};
