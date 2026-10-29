// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Hooks Registry ────────────────────────────
// Loads hook configs from ~/.atlas/hooks.json (user-global) and
// .atlas/hooks.json (project-local). Config format:
//
//   {
//     "PreToolUse": [
//       { "matcher": "edit|write", "command": "/path/to/script.sh", "timeout": 5000 }
//     ],
//     "PostToolUse": [
//       { "matcher": "edit", "command": "prettier --write" }
//     ],
//     "UserPromptSubmit": [
//       { "command": "/path/to/inject-context.sh" }
//     ]
//   }
//
// The matcher is a regex run against the event's primary identifier (tool
// name for PreToolUse/PostToolUse, always matches for SessionStart/End/Stop).
// Commands are invoked via shell with JSON-over-stdin and their stdout is
// captured. Non-zero exit = log + skip (never fatal).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { BUILTIN_HOOKS } from "./built-in.js";

// ── Types ─────────────────────────────────────

export type HookEvent =
    | "SessionStart"
    | "SessionEnd"
    | "UserPromptSubmit"
    | "PreToolUse"
    | "PostToolUse"
    | "Stop";

/**
 * Return shape an in-process handler produces. Mirrors the JSON
 * contract that subprocess hooks emit on stdout, so firePreToolUse
 * can treat both the same way.
 */
export interface HookHandlerResult {
    modifiedInput?: Record<string, unknown>;
    block?: boolean;
    reason?: string;
    /** Free-form text injected as UserPromptSubmit stdout. */
    stdout?: string;
}

export type HookHandler = (payload: unknown) => Promise<HookHandlerResult | null | void>;

export interface HookDefinition {
    /** Regex string matched against tool name for tool events, or a loose tag for others. */
    matcher?: string;
    /**
     * Shell command to run. Receives JSON on stdin, emits JSON (or plain text) on stdout.
     * Mutually exclusive with `handler` — built-in hooks use `handler`, user hooks use `command`.
     */
    command?: string;
    /**
     * In-process handler — called directly with the event payload. Used by
     * built-in hooks to avoid subprocess spawn overhead.
     */
    handler?: HookHandler;
    /** Milliseconds before the hook is killed. Defaults to 5000. */
    timeout?: number;
    /** Human-readable label for logging. */
    name?: string;
}

type HooksByEvent = Partial<Record<HookEvent, HookDefinition[]>>;

// ── State ─────────────────────────────────────

let loaded: HooksByEvent = {};
let loadedFrom: string[] = [];

// ── Loader ────────────────────────────────────

function readHooksFile(p: string): HooksByEvent | null {
    try {
        if (!existsSync(p)) return null;
        const raw = readFileSync(p, "utf-8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;
        return parsed as HooksByEvent;
    } catch (err) {
        console.warn(`[HOOKS] Failed to read ${p}: ${(err as Error).message}`);
        return null;
    }
}

/**
 * Load hook configs from user and project locations. Project-local hooks
 * take precedence (appended after user-global — so they fire last, which
 * lets project hooks see/modify the result of user-global hooks).
 *
 * Safe to call multiple times; state is fully replaced each call.
 */
export function loadHooks(projectRoot?: string): void {
    const merged: HooksByEvent = {};
    const sources: string[] = [];

    const userPath = path.join(homedir(), ".atlas", "hooks.json");
    const projectPath = path.join(projectRoot ?? process.cwd(), ".atlas", "hooks.json");

    // ── Built-in hooks — registered first so user hooks fire after them
    // and can override or extend their behavior. Disabled via env.
    if (process.env.ATLAS_DISABLE_BUILTIN_HOOKS !== "true") {
        let builtinCount = 0;
        for (const event of Object.keys(BUILTIN_HOOKS) as HookEvent[]) {
            const defs = BUILTIN_HOOKS[event];
            if (!Array.isArray(defs)) continue;
            merged[event] = (merged[event] ?? []).concat(defs);
            builtinCount += defs.length;
        }
        if (builtinCount > 0) sources.push("builtin");
    }

    for (const p of [userPath, projectPath]) {
        const cfg = readHooksFile(p);
        if (!cfg) continue;
        sources.push(p);
        for (const event of Object.keys(cfg) as HookEvent[]) {
            const defs = cfg[event];
            if (!Array.isArray(defs)) continue;
            merged[event] = (merged[event] ?? []).concat(
                defs.filter((d) => d && (typeof d.command === "string" || typeof d.handler === "function")),
            );
        }
    }

    loaded = merged;
    loadedFrom = sources;
    const hookCount = Object.values(merged).reduce((n, arr) => n + (arr?.length ?? 0), 0);
    if (hookCount > 0) {
        console.log(`🪝 ${hookCount} hook(s) loaded from ${sources.join(", ")}`);
    }
}

// ── Query ─────────────────────────────────────

export function getHooksFor(event: HookEvent, identifier?: string): HookDefinition[] {
    const defs = loaded[event] ?? [];
    if (!identifier) return defs;
    return defs.filter((d) => {
        if (!d.matcher) return true;
        try {
            return new RegExp(d.matcher).test(identifier);
        } catch {
            return false;
        }
    });
}

export function getLoadedSources(): string[] {
    return [...loadedFrom];
}

export function hasAnyHooks(): boolean {
    return Object.values(loaded).some((arr) => Array.isArray(arr) && arr.length > 0);
}

export function clearHooks(): void {
    loaded = {};
    loadedFrom = [];
}
