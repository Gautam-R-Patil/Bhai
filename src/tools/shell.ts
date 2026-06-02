// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";
import { isShellBypass, isSystemDestructive, shellArgsTargetProtectedPath } from "../security/allowlist.js";
import { auditLog } from "../security/audit-log.js";
import { sanitizeSecrets } from "../security/secrets-sanitizer.js";
import { resolveWindowsShell, wrapForShell } from "../utils/win-shell.js";
import type { ToolDefinition } from "./get-current-time.js";
import { IS_WIN } from "./platform.js";

const execFileAsync = promisify(execFile);

// ── Constants ─────────────────────────────────

const MAX_OUTPUT = 10000; // characters
const DEFAULT_TIMEOUT = 30000; // 30s

// CLAUDE.md policy: never let the agent rewrite git config, since that
// affects user identity, hooks, signing, and remote auth. Block at the
// shell layer so the rule applies to shell_exec, sub-agents, and any
// new tool that funnels through here.
export function isGitConfigCall(command: string, args: string[]): boolean {
    const base = command.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") || "";
    if (base !== "git") return false;
    // Reject `git -c config.X=Y …` and `git config …` in any subcommand.
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-c" || a === "--config-env") return true;
        if (a === "config") return true;
        // Stop after the first non-flag arg — that's the subcommand.
        if (!a.startsWith("-")) break;
    }
    return false;
}

export function hasGitConfigEnvOverride(env: NodeJS.ProcessEnv): boolean {
    for (const k of Object.keys(env)) {
        if (/^GIT_CONFIG(_|$)/.test(k)) return true;
    }
    return false;
}

// ── Cross-Platform Command Executor ──────────

async function execCommand(
    command: string,
    args: string[],
    options: { cwd: string; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
    if (IS_WIN) {
        const shell = await resolveWindowsShell();
        const wrapped = wrapForShell(shell, command, args);
        return execFileAsync(wrapped.command, wrapped.args, {
            cwd: options.cwd,
            timeout: options.timeout,
            maxBuffer: 1024 * 1024,
        });
    }
    return execFileAsync(command, args, {
        cwd: options.cwd,
        timeout: options.timeout,
        maxBuffer: 1024 * 1024,
        shell: true,
    });
}

// ── Shell Command Tool ────────────────────────

export const shellExec: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "shell_exec",
            description:
                "Execute a shell command and return its output. Use for system tasks, checking status, running scripts.",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "The command to execute" },
                    args: {
                        type: "array",
                        items: { type: "string" },
                        description: "Command arguments",
                    },
                    cwd: { type: "string", description: "Working directory (optional)" },
                    timeout: { type: "number", description: "Timeout in ms (default 30000)" },
                },
                required: ["command"],
            },
        },
    },

    async handler(input) {
        const command = input.command as string;
        const args = (input.args as string[]) || [];
        // Default to the user's home dir, NOT process.cwd() — the bot runs from
        // its own install dir (…/bot), so an unscoped `du`/`ls` returned the
        // bot's node_modules instead of the user's files, causing the agent to
        // loop. Security is unchanged: the destructive/protected-path/allowlist
        // gates below still apply regardless of cwd.
        const cwd = (input.cwd as string) || homedir() || process.cwd();
        const timeout = (input.timeout as number) || DEFAULT_TIMEOUT;

        auditLog("shell_exec", { command, args, cwd });

        // Build full command string for pattern matching
        const fullCommand = args.length > 0 ? `${command} ${args.join(" ")}` : command;

        // Security check: only block truly system-destructive commands
        if (isSystemDestructive(fullCommand)) {
            return JSON.stringify({
                error: `Blocked: This command would cause irreversible damage to the operating system. Commands that wipe the system disk, destroy boot files, or format the main drive are not allowed.`,
            });
        }

        // Block shell interpreters used to run system-destructive commands
        if (isShellBypass(command, args)) {
            return JSON.stringify({
                error: `Blocked: The inline command contains a system-destructive operation that could damage the OS.`,
            });
        }

        // Block `git config` / `git -c …` / GIT_CONFIG_* env overrides. CLAUDE.md
        // policy: never modify user git config (identity, hooks, signing).
        if (isGitConfigCall(command, args) || hasGitConfigEnvOverride(process.env)) {
            return JSON.stringify({
                error: `Blocked: git config / -c flag / GIT_CONFIG_* env overrides are not permitted.`,
            });
        }

        // Codebase self-protection: block destructive shell commands targeting the atlas folder
        const DESTRUCTIVE_CMDS = new Set(["rm", "mv", "cp", "rsync", "dd"]);
        // basename covers both separators so a Windows command path like
        // "C:\\Windows\\System32\\rm.exe" still resolves to "rm.exe" and
        // hits the DESTRUCTIVE_CMDS check (after trimming .exe below).
        const baseCmdRaw = basename(command);
        const baseCmd = baseCmdRaw.replace(/\.exe$/i, "");
        if (DESTRUCTIVE_CMDS.has(baseCmd)) {
            const allTokens = [command, ...args];
            const hit = shellArgsTargetProtectedPath(allTokens);
            if (hit) {
                return JSON.stringify({
                    error: `Blocked: command "${command}" targets the bot's own codebase path "${hit}". Write/delete operations on the atlas codebase are not allowed.`,
                });
            }
        }

        try {
            const { stdout, stderr } = await execCommand(command, args, { cwd, timeout });

            // Truncate first so we only scan what actually ships to the
            // agent (scanning a 10 MB buffer would be wasteful).
            const rawOut = (stdout || "").substring(0, MAX_OUTPUT);
            const rawErr = (stderr || "").substring(0, MAX_OUTPUT);

            // Redact well-known secret formats before the output reaches
            // the agent context. Prevents scripts like `echo $AWS_KEY`
            // or `env | grep TOKEN` from leaking credentials into LLM
            // memory + cloud logs.
            const outScan = sanitizeSecrets(rawOut);
            const errScan = sanitizeSecrets(rawErr);
            if (outScan.totalRedactions + errScan.totalRedactions > 0) {
                console.warn(
                    `[SHELL] redacted ${outScan.totalRedactions + errScan.totalRedactions} secret(s) ` +
                        `from command="${command}": ${JSON.stringify({
                            ...outScan.redactionsByType,
                            ...errScan.redactionsByType,
                        })}`,
                );
            }

            return JSON.stringify({
                success: true,
                stdout: outScan.sanitized,
                stderr: errScan.sanitized,
                truncated: (stdout || "").length > MAX_OUTPUT,
                ...(outScan.totalRedactions + errScan.totalRedactions > 0
                    ? { redacted: outScan.totalRedactions + errScan.totalRedactions }
                    : {}),
            });
        } catch (err) {
            const error = err as { message?: string; code?: number; killed?: boolean };
            const errMsg = error.message || "Command failed";

            // ── Self-heal: if command not found, try auto-installing and retry ──
            if (/ENOENT|command not found|not recognized/i.test(errMsg)) {
                try {
                    const { attemptSelfHeal } = await import("../agents/self-heal.js");
                    const heal = await attemptSelfHeal(errMsg);
                    if (heal.fixed) {
                        console.log(`  🔧 Shell self-healed (${heal.action}) — retrying: ${command}`);
                        try {
                            const { stdout, stderr } = await execCommand(command, args, { cwd, timeout });
                            const outScan = sanitizeSecrets((stdout || "").substring(0, MAX_OUTPUT));
                            const errScan = sanitizeSecrets((stderr || "").substring(0, MAX_OUTPUT));
                            return JSON.stringify({
                                success: true,
                                stdout: outScan.sanitized,
                                stderr: errScan.sanitized,
                                note: `Auto-installed missing dependency (${heal.action}) before retry`,
                                ...(outScan.totalRedactions + errScan.totalRedactions > 0
                                    ? { redacted: outScan.totalRedactions + errScan.totalRedactions }
                                    : {}),
                            });
                        } catch (retryErr) {
                            const re = retryErr as { message?: string; code?: number; killed?: boolean };
                            return JSON.stringify({
                                success: false,
                                error: re.message || "Command failed after self-heal retry",
                                code: re.code,
                                killed: re.killed,
                            });
                        }
                    }
                } catch {
                    /* self-heal module unavailable */
                }
            }

            return JSON.stringify({
                success: false,
                error: errMsg,
                code: error.code,
                killed: error.killed,
            });
        }
    },
};
