// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "./get-current-time.js";
import { isSystemDestructive, shellArgsTargetProtectedPath, isShellBypass } from "../security/allowlist.js";
import { auditLog } from "../security/audit-log.js";

const execFileAsync = promisify(execFile);

// ── Constants ─────────────────────────────────

const MAX_OUTPUT = 10000; // characters
const DEFAULT_TIMEOUT = 30000; // 30s

// ── Shell Command Tool ────────────────────────

export const shellExec: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "shell_exec",
            description: "Execute a shell command and return its output. Use for system tasks, checking status, running scripts.",
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
        const cwd = (input.cwd as string) || process.cwd();
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

        // Codebase self-protection: block destructive shell commands targeting the atlas folder
        const DESTRUCTIVE_CMDS = new Set(["rm", "mv", "cp", "rsync", "dd"]);
        const baseCmd = command.split("/").at(-1) ?? command;
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
            const { stdout, stderr } = await execFileAsync(command, args, {
                cwd,
                timeout,
                maxBuffer: 1024 * 1024,
                shell: true,
            });

            const output = (stdout || "").substring(0, MAX_OUTPUT);
            const errors = (stderr || "").substring(0, MAX_OUTPUT);

            return JSON.stringify({
                success: true,
                stdout: output,
                stderr: errors,
                truncated: (stdout || "").length > MAX_OUTPUT,
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
                            const { stdout, stderr } = await execFileAsync(command, args, {
                                cwd, timeout, maxBuffer: 1024 * 1024, shell: true,
                            });
                            return JSON.stringify({
                                success: true,
                                stdout: (stdout || "").substring(0, MAX_OUTPUT),
                                stderr: (stderr || "").substring(0, MAX_OUTPUT),
                                note: `Auto-installed missing dependency (${heal.action}) before retry`,
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
                } catch { /* self-heal module unavailable */ }
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
