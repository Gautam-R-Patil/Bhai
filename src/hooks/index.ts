// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Hooks Runtime ─────────────────────────────
// Fires user-configured hooks at well-defined lifecycle events. Shells
// out to arbitrary commands, JSON over stdin/stdout. Every hook failure
// is non-fatal — hooks must NEVER take the agent down. All errors are
// logged and the agent continues with the original tool input/output.
//
// Public API:
//   fireSessionStart / fireSessionEnd / fireStop / fireUserPromptSubmit
//   firePreToolUse — returns { modifiedInput?, block? }
//   firePostToolUse — side effects only
//
// Hook config format is defined in ./registry.ts.

import { spawn } from "node:child_process";
import { getHooksFor, hasAnyHooks, type HookDefinition, type HookEvent } from "./registry.js";

// ── Hook Execution ────────────────────────────

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_STDOUT_BYTES = 64 * 1024;

interface HookOutput {
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
}

async function runHook(def: HookDefinition, payload: unknown): Promise<HookOutput> {
    // In-process handler short-circuits the subprocess spawn. Built-in
    // hooks use this path; user hooks always go through `command`.
    if (typeof def.handler === "function") {
        const timeoutMs = Math.max(100, def.timeout ?? DEFAULT_TIMEOUT_MS);
        try {
            const result = await Promise.race([
                def.handler(payload),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
            ]);
            if (!result) return { ok: true, stdout: "", stderr: "", exitCode: 0 };
            const stdoutJson = JSON.stringify({
                modifiedInput: result.modifiedInput,
                block: result.block,
                reason: result.reason,
            });
            return {
                ok: true,
                stdout: result.stdout ?? (result.modifiedInput || result.block ? stdoutJson : ""),
                stderr: "",
                exitCode: 0,
            };
        } catch (err) {
            return { ok: false, stdout: "", stderr: (err as Error).message, exitCode: 1 };
        }
    }
    if (!def.command) {
        return { ok: false, stdout: "", stderr: "hook has neither command nor handler", exitCode: 2 };
    }

    return new Promise((resolve) => {
        const timeoutMs = Math.max(100, def.timeout ?? DEFAULT_TIMEOUT_MS);
        // Pick the platform's default command shell so hook authors can use
        // POSIX quoting on Unix and batch/PowerShell syntax on Windows.
        const [shellBin, shellArg] =
            process.platform === "win32" ? ["cmd.exe", "/c"] : ["sh", "-c"];
        const child = spawn(shellBin, [shellArg, def.command as string], {
            stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = Buffer.alloc(0);
        let stderr = "";
        let settled = false;

        const finish = (exitCode: number, ok: boolean) => {
            if (settled) return;
            settled = true;
            resolve({ ok, stdout: stdout.toString("utf-8"), stderr, exitCode });
        };

        const killTimer = setTimeout(() => {
            try { child.kill("SIGTERM"); } catch { /* */ }
            setTimeout(() => {
                try { child.kill("SIGKILL"); } catch { /* */ }
            }, 500);
            finish(-1, false);
        }, timeoutMs);

        child.stdout?.on("data", (chunk: Buffer) => {
            if (stdout.length + chunk.length > MAX_STDOUT_BYTES) {
                stdout = Buffer.concat([stdout, chunk.subarray(0, MAX_STDOUT_BYTES - stdout.length)]);
                try { child.kill("SIGTERM"); } catch { /* */ }
                return;
            }
            stdout = Buffer.concat([stdout, chunk]);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf-8");
        });

        child.on("error", (err) => {
            clearTimeout(killTimer);
            stderr += `\n${err.message}`;
            finish(127, false);
        });
        child.on("close", (code) => {
            clearTimeout(killTimer);
            finish(code ?? 0, code === 0);
        });

        try {
            const payloadJson = JSON.stringify(payload ?? {});
            child.stdin?.write(payloadJson);
            child.stdin?.end();
        } catch (err) {
            clearTimeout(killTimer);
            stderr += `\nstdin write failed: ${(err as Error).message}`;
            finish(-2, false);
        }
    });
}

function parseMaybeJson<T = unknown>(text: string): T | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed) as T;
    } catch {
        return null;
    }
}

// ── Fire helpers ──────────────────────────────

export async function fireSessionStart(meta: Record<string, unknown>): Promise<void> {
    if (!hasAnyHooks()) return;
    const defs = getHooksFor("SessionStart");
    for (const def of defs) {
        try {
            await runHook(def, { event: "SessionStart", ...meta });
        } catch (err) {
            console.warn(`[HOOKS] SessionStart hook failed: ${(err as Error).message}`);
        }
    }
}

export async function fireSessionEnd(meta: Record<string, unknown>): Promise<void> {
    if (!hasAnyHooks()) return;
    const defs = getHooksFor("SessionEnd");
    for (const def of defs) {
        try {
            await runHook(def, { event: "SessionEnd", ...meta });
        } catch (err) {
            console.warn(`[HOOKS] SessionEnd hook failed: ${(err as Error).message}`);
        }
    }
}

export async function fireStop(meta: Record<string, unknown>): Promise<void> {
    if (!hasAnyHooks()) return;
    const defs = getHooksFor("Stop");
    for (const def of defs) {
        try {
            await runHook(def, { event: "Stop", ...meta });
        } catch (err) {
            console.warn(`[HOOKS] Stop hook failed: ${(err as Error).message}`);
        }
    }
}

/**
 * UserPromptSubmit: hook stdout (if non-empty) is returned so the caller
 * can inject it into the model's context. Returns a concatenated string
 * across all hooks, or empty string when none apply.
 */
export async function fireUserPromptSubmit(userMessage: string): Promise<string> {
    if (!hasAnyHooks()) return "";
    const defs = getHooksFor("UserPromptSubmit");
    if (defs.length === 0) return "";

    const pieces: string[] = [];
    for (const def of defs) {
        try {
            const result = await runHook(def, { event: "UserPromptSubmit", message: userMessage });
            if (result.ok && result.stdout.trim()) {
                pieces.push(result.stdout.trim());
            } else if (!result.ok && result.stderr) {
                console.warn(`[HOOKS] UserPromptSubmit '${def.name ?? def.command}' exit=${result.exitCode}: ${result.stderr.trim()}`);
            }
        } catch (err) {
            console.warn(`[HOOKS] UserPromptSubmit hook failed: ${(err as Error).message}`);
        }
    }
    return pieces.join("\n");
}

// ── Tool hooks ────────────────────────────────

export interface PreToolUseResult {
    /** If present, use these args instead of the originals. */
    modifiedInput?: Record<string, unknown>;
    /** If true, cancel the tool call and return block_reason to the model. */
    block?: boolean;
    block_reason?: string;
}

/**
 * PreToolUse: each matching hook sees the (possibly already-modified) input
 * and may return modified input of its own. Hooks are applied in registry
 * order; later hooks see earlier hooks' output.
 *
 * Return shape from the hook is JSON on stdout like:
 *   { "modifiedInput": { ... } }
 *   { "block": true, "reason": "..." }
 *   (empty stdout = passthrough)
 */
export async function firePreToolUse(
    toolName: string,
    input: Record<string, unknown>,
): Promise<PreToolUseResult> {
    if (!hasAnyHooks()) return {};
    const defs = getHooksFor("PreToolUse", toolName);
    if (defs.length === 0) return {};

    let currentInput: Record<string, unknown> = { ...input };
    for (const def of defs) {
        try {
            const out = await runHook(def, { event: "PreToolUse", tool: toolName, input: currentInput });
            if (!out.ok) {
                if (out.stderr.trim()) {
                    console.warn(`[HOOKS] PreToolUse '${def.name ?? def.command}' for ${toolName} exit=${out.exitCode}: ${out.stderr.trim()}`);
                }
                continue;
            }
            const parsed = parseMaybeJson<{
                modifiedInput?: Record<string, unknown>;
                block?: boolean;
                reason?: string;
            }>(out.stdout);
            if (!parsed) continue;

            if (parsed.block === true) {
                return { block: true, block_reason: parsed.reason ?? "Blocked by PreToolUse hook." };
            }
            if (parsed.modifiedInput && typeof parsed.modifiedInput === "object") {
                currentInput = { ...currentInput, ...parsed.modifiedInput };
            }
        } catch (err) {
            console.warn(`[HOOKS] PreToolUse hook failed: ${(err as Error).message}`);
        }
    }

    // Only return modifiedInput if something actually changed.
    const changed = JSON.stringify(currentInput) !== JSON.stringify(input);
    return changed ? { modifiedInput: currentInput } : {};
}

/**
 * PostToolUse: fire-and-forget side effects (formatters, linters, notifiers).
 * Stdout is discarded. Errors are logged but never propagated.
 */
export async function firePostToolUse(
    toolName: string,
    input: Record<string, unknown>,
    result: string,
    success: boolean,
): Promise<void> {
    if (!hasAnyHooks()) return;
    const defs = getHooksFor("PostToolUse", toolName);
    if (defs.length === 0) return;

    for (const def of defs) {
        try {
            await runHook(def, {
                event: "PostToolUse",
                tool: toolName,
                input,
                result: result.length > 2000 ? result.slice(0, 2000) + "…" : result,
                success,
            });
        } catch (err) {
            console.warn(`[HOOKS] PostToolUse hook failed: ${(err as Error).message}`);
        }
    }
}

// ── Init (re-export loader) ───────────────────

export { loadHooks } from "./registry.js";
