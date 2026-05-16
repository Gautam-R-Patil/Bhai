// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Shell Background Process Monitor ──────────
// Run long-running shell commands in the background,
// monitor their output, and wait for completion.
// Uses child_process.spawn for streaming output.

import { type ChildProcess, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { isShellBypass, isSystemDestructive, shellArgsTargetProtectedPath } from "../security/allowlist.js";
import { auditLog } from "../security/audit-log.js";
import { sanitizeSecrets } from "../security/secrets-sanitizer.js";
import { resolveWindowsShell, wrapForShell } from "../utils/win-shell.js";
import type { ToolDefinition } from "./get-current-time.js";
import { IS_WIN } from "./platform.js";

// Env vars that should NEVER be inherited into spawned children — these
// are the credentials that, if echoed by the child (e.g. `env`, `printenv`,
// `set`), would land in the LLM context. The sanitizer catches most
// formats but stripping at the spawn boundary is the cheaper defence.
const SENSITIVE_ENV_PATTERNS: RegExp[] = [
    /API[_-]?KEY$/i,
    /SECRET/i,
    /TOKEN$/i,
    /PASSWORD/i,
    /PASSPHRASE/i,
    /PRIVATE[_-]?KEY/i,
    /^OPENROUTER_/i,
    /^OPENAI_/i,
    /^ANTHROPIC_/i,
    /^GEMINI_/i,
    /^GOOGLE_/i,
    /^GROQ_/i,
    /^MISTRAL_/i,
    /^ELEVENLABS_/i,
    /^HF_/i,
    /^HUGGINGFACE_/i,
    /^CONVEX_/i,
    /^TELEGRAM_BOT_TOKEN/i,
    /^DISCORD_/i,
    /^SLACK_/i,
    /^MATRIX_/i,
    /^WHATSAPP_/i,
    /^GITHUB_TOKEN/i,
    /^GH_TOKEN/i,
    /^ADMIN_API_KEY/i,
    /^OTPLESS_/i,
];

function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
        if (typeof v !== "string") continue;
        if (SENSITIVE_ENV_PATTERNS.some((re) => re.test(k))) continue;
        out[k] = v;
    }
    return out;
}

// ── Constants ─────────────────────────────────

const LOG_DIR = join(process.env.ATLAS_DATA_DIR || join(process.cwd(), "data"), "process-logs");
const MAX_OUTPUT_PREVIEW = 5000; // chars in status preview
const MAX_WAIT_MS = 86_400_000; // 24 hours max wait

// ── Process Store ─────────────────────────────

interface BackgroundProcess {
    id: string;
    command: string;
    args: string[];
    pid: number;
    status: "running" | "completed" | "failed" | "killed";
    exitCode: number | null;
    startedAt: string;
    endedAt: string | null;
    stdout: string;
    stderr: string;
    process: ChildProcess;
    logFile: string;
}

const processes = new Map<string, BackgroundProcess>();
let processCounter = 0;

// ── Memory Leak Prevention: periodic cleanup of completed processes older than 1 hour ──
const PROCESS_CLEANUP_AGE_MS = 60 * 60 * 1000; // 1 hour

function cleanupStaleProcesses(): void {
    const now = Date.now();
    for (const [id, proc] of processes) {
        if (proc.status === "completed" || proc.status === "failed" || proc.status === "killed") {
            const endedAt = proc.endedAt ? new Date(proc.endedAt).getTime() : 0;
            if (endedAt > 0 && now - endedAt > PROCESS_CLEANUP_AGE_MS) {
                processes.delete(id);
                console.log(`[SHELL-MONITOR] 🧹 Cleaned up stale process: ${id} (${proc.status})`);
            }
        }
    }
}

// Run cleanup every 30 minutes
const _processCleanupInterval = setInterval(cleanupStaleProcesses, 30 * 60 * 1000);
_processCleanupInterval.unref(); // Don't prevent process exit

// ── Ensure log directory ──────────────────────

async function ensureLogDir(): Promise<void> {
    await fs.mkdir(LOG_DIR, { recursive: true });
}

// ── Shell Exec Background Tool ────────────────

export const shellExecBackground: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "shell_exec_background",
            description: `Start a shell command in the background and get a process ID to monitor it.
Use this instead of shell_exec when:
- The command will take more than 30 seconds (downloads, builds, installations)
- You need to monitor progress (e.g., download progress)
- The process should keep running while you do other things

Returns a process_id that you can use with shell_check_process and shell_wait_process.`,
            parameters: {
                type: "object",
                properties: {
                    command: {
                        type: "string",
                        description: "The command to execute (e.g., 'curl', 'wget', 'npm', 'make')",
                    },
                    args: {
                        type: "array",
                        items: { type: "string" },
                        description: "Command arguments as an array",
                    },
                    cwd: {
                        type: "string",
                        description: "Working directory (optional, defaults to current)",
                    },
                },
                required: ["command"],
            },
        },
    },

    async handler(input) {
        const command = input.command as string;
        const args = (input.args as string[]) || [];
        const cwd = (input.cwd as string) || process.cwd();

        auditLog("shell_exec_background", { command, args, cwd });

        // Mirror shell.ts's triple-check: system-destructive base command,
        // shell-bypass for destructive inline command, and protected-path
        // codebase targeting via destructive utilities.
        const fullCommand = args.length > 0 ? `${command} ${args.join(" ")}` : command;
        if (isSystemDestructive(fullCommand)) {
            return JSON.stringify({
                error: `Blocked: command would cause irreversible damage to the operating system.`,
            });
        }
        if (isShellBypass(command, args)) {
            return JSON.stringify({
                error: `Blocked: inline command contains a system-destructive operation.`,
            });
        }
        const DESTRUCTIVE_CMDS = new Set(["rm", "mv", "cp", "rsync", "dd"]);
        const baseCmd = basename(command).replace(/\.exe$/i, "");
        if (DESTRUCTIVE_CMDS.has(baseCmd)) {
            const hit = shellArgsTargetProtectedPath([command, ...args]);
            if (hit) {
                return JSON.stringify({
                    error: `Blocked: command "${command}" targets the bot's own codebase path "${hit}".`,
                });
            }
        }

        await ensureLogDir();

        const id = `proc_${++processCounter}_${Date.now()}`;
        const logFile = join(LOG_DIR, `${id}.log`);

        try {
            // Before spawn, resolve shell on Windows
            let spawnCmd = command;
            let spawnArgs = args;
            if (IS_WIN) {
                const shell = await resolveWindowsShell();
                const wrapped = wrapForShell(shell, command, args);
                spawnCmd = wrapped.command;
                spawnArgs = wrapped.args;
            }

            const child = spawn(spawnCmd, spawnArgs, {
                cwd,
                shell: !IS_WIN, // Git Bash / PowerShell handle their own quoting; don't double-shell on Windows
                env: scrubEnv(process.env),
                stdio: ["ignore", "pipe", "pipe"],
            });

            const bp: BackgroundProcess = {
                id,
                command,
                args,
                pid: child.pid || 0,
                status: "running",
                exitCode: null,
                startedAt: new Date().toISOString(),
                endedAt: null,
                stdout: "",
                stderr: "",
                process: child,
                logFile,
            };

            // Stream stdout — sanitize before storing in the in-memory buffer
            // that ships to the LLM. Raw text goes to disk so the user retains
            // the unredacted log.
            child.stdout?.on("data", (data: Buffer) => {
                const text = data.toString();
                const clean = sanitizeSecrets(text).sanitized;
                bp.stdout += clean;
                if (bp.stdout.length > 50000) {
                    bp.stdout = bp.stdout.slice(-40000);
                }
                fs.appendFile(logFile, text).catch(() => {});
            });

            // Stream stderr
            child.stderr?.on("data", (data: Buffer) => {
                const text = data.toString();
                const clean = sanitizeSecrets(text).sanitized;
                bp.stderr += clean;
                if (bp.stderr.length > 50000) {
                    bp.stderr = bp.stderr.slice(-40000);
                }
                fs.appendFile(logFile, `[STDERR] ${text}`).catch(() => {});
            });

            // Handle exit
            child.on("close", (code) => {
                bp.status = code === 0 ? "completed" : "failed";
                bp.exitCode = code;
                bp.endedAt = new Date().toISOString();
                console.log(`[SHELL-MONITOR] Process ${id} exited with code ${code}`);
            });

            child.on("error", (err) => {
                bp.status = "failed";
                bp.stderr += `\nProcess error: ${err.message}`;
                bp.endedAt = new Date().toISOString();
            });

            processes.set(id, bp);

            return JSON.stringify({
                success: true,
                process_id: id,
                pid: child.pid,
                command: `${command} ${args.join(" ")}`,
                message: `Process started in background. Use shell_check_process with process_id "${id}" to monitor, or shell_wait_process to wait for completion.`,
            });
        } catch (err) {
            return JSON.stringify({
                error: `Failed to start process: ${(err as Error).message}`,
            });
        }
    },
};

// ── Shell Check Process Tool ──────────────────

export const shellCheckProcess: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "shell_check_process",
            description: "Check the status and latest output of a background process. Returns without waiting.",
            parameters: {
                type: "object",
                properties: {
                    process_id: {
                        type: "string",
                        description: "Process ID returned by shell_exec_background",
                    },
                    tail_lines: {
                        type: "number",
                        description: "Number of lines to show from the end of output (default 20)",
                    },
                },
                required: ["process_id"],
            },
        },
    },

    async handler(input) {
        const processId = input.process_id as string;
        const tailLines = (input.tail_lines as number) || 20;

        const bp = processes.get(processId);
        if (!bp) {
            return JSON.stringify({ error: `Process "${processId}" not found` });
        }

        // Get last N lines of output. Buffers are already sanitized on
        // ingestion; sanitize once more in case a secret was split across
        // chunk boundaries during streaming.
        const allOutput = bp.stdout + (bp.stderr ? `\n[STDERR]\n${bp.stderr}` : "");
        const lines = sanitizeSecrets(allOutput).sanitized.split("\n");
        const tail = lines.slice(-tailLines).join("\n");

        const elapsed = bp.endedAt
            ? new Date(bp.endedAt).getTime() - new Date(bp.startedAt).getTime()
            : Date.now() - new Date(bp.startedAt).getTime();

        return JSON.stringify({
            process_id: bp.id,
            command: `${bp.command} ${bp.args.join(" ")}`,
            status: bp.status,
            pid: bp.pid,
            exit_code: bp.exitCode,
            started_at: bp.startedAt,
            ended_at: bp.endedAt,
            elapsed_seconds: (elapsed / 1000).toFixed(1),
            output_tail: tail.substring(0, MAX_OUTPUT_PREVIEW),
            total_output_length: allOutput.length,
            log_file: bp.logFile,
        });
    },
};

// ── Shell Wait Process Tool ───────────────────

export const shellWaitProcess: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "shell_wait_process",
            description: `Wait for a background process to complete. Blocks until the process exits or the timeout is reached.
Use this when you need to wait for a download, build, or installation to finish before proceeding.
Maximum wait time is 24 hours.`,
            parameters: {
                type: "object",
                properties: {
                    process_id: {
                        type: "string",
                        description: "Process ID returned by shell_exec_background",
                    },
                    timeout_seconds: {
                        type: "number",
                        description: "Maximum time to wait in seconds (default 3600 = 1 hour, max 86400 = 24 hours)",
                    },
                    poll_interval_seconds: {
                        type: "number",
                        description: "How often to check process status in seconds (default 5)",
                    },
                },
                required: ["process_id"],
            },
        },
    },

    async handler(input) {
        const processId = input.process_id as string;
        const timeoutSeconds = Math.min((input.timeout_seconds as number) || 3600, MAX_WAIT_MS / 1000);
        const pollInterval = Math.max((input.poll_interval_seconds as number) || 5, 1);

        const bp = processes.get(processId);
        if (!bp) {
            return JSON.stringify({ error: `Process "${processId}" not found` });
        }

        // Already finished?
        if (bp.status !== "running") {
            return JSON.stringify({
                process_id: bp.id,
                status: bp.status,
                exit_code: bp.exitCode,
                message: "Process already completed.",
                stdout_tail: bp.stdout.slice(-MAX_OUTPUT_PREVIEW),
                stderr_tail: bp.stderr.slice(-2000),
            });
        }

        // Wait loop
        const deadline = Date.now() + timeoutSeconds * 1000;
        console.log(`[SHELL-MONITOR] Waiting for process ${processId} (timeout: ${timeoutSeconds}s)...`);

        while (Date.now() < deadline) {
            if (bp.status !== "running") break;
            await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000));
        }

        if (bp.status === "running") {
            return JSON.stringify({
                process_id: bp.id,
                status: "timeout",
                message: `Process still running after ${timeoutSeconds}s. Use shell_check_process to monitor or shell_wait_process with a longer timeout.`,
                stdout_tail: bp.stdout.slice(-MAX_OUTPUT_PREVIEW),
            });
        }

        return JSON.stringify({
            process_id: bp.id,
            status: bp.status,
            exit_code: bp.exitCode,
            elapsed_seconds: bp.endedAt
                ? ((new Date(bp.endedAt).getTime() - new Date(bp.startedAt).getTime()) / 1000).toFixed(1)
                : "unknown",
            stdout_tail: bp.stdout.slice(-MAX_OUTPUT_PREVIEW),
            stderr_tail: bp.stderr.slice(-2000),
            log_file: bp.logFile,
        });
    },
};

// ── Kill Process ──────────────────────────────

export const shellKillProcess: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "shell_kill_process",
            description: "Kill a running background process.",
            parameters: {
                type: "object",
                properties: {
                    process_id: {
                        type: "string",
                        description: "Process ID to kill",
                    },
                },
                required: ["process_id"],
            },
        },
    },

    async handler(input) {
        const processId = input.process_id as string;
        const bp = processes.get(processId);
        if (!bp) {
            return JSON.stringify({ error: `Process "${processId}" not found` });
        }

        if (bp.status !== "running") {
            return JSON.stringify({
                message: `Process already ${bp.status}.`,
                exit_code: bp.exitCode,
            });
        }

        try {
            bp.process.kill("SIGTERM");
            // Give it 5s to die gracefully, then SIGKILL
            setTimeout(() => {
                if (bp.status === "running") {
                    bp.process.kill("SIGKILL");
                }
            }, 5000);

            bp.status = "killed";
            bp.endedAt = new Date().toISOString();

            return JSON.stringify({
                success: true,
                process_id: processId,
                message: "Process killed.",
            });
        } catch (err) {
            return JSON.stringify({
                error: `Failed to kill process: ${(err as Error).message}`,
            });
        }
    },
};
