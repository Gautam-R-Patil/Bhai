// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// TS shim wrapping the Rust forge sandbox napi exports.
//
// Routes synthesized-tool invocations through the OS-isolated child process
// pool. Mirrors the napi surface from `native/src/forge_sandbox/api.rs`:
//   - forgeInvokeTool(slug, handlerDir, capabilitiesJson, inputJson) → JSON-string
//   - forgeSpawnWarm(slug, handlerDir, capabilitiesJson) → void (pre-warm a worker)
//   - forgeEvict(slug) → void
//   - forgeStrikes(slug) → number
//   - forgeClearStrikes(slug) → void
//   - forgeSetPoolSize(size) → void

import { createRequire } from "node:module";
import path from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";

import { asJSON, type Capabilities } from "./capabilities.js";
import { manifestDir, readManifest, writeManifest } from "./manifest.js";
import type { PersistedToolManifest } from "./types.js";

export interface SandboxError {
    kind:
        | "handler_error"
        | "timeout"
        | "cap_denied"
        | "killed_oom"
        | "spawn_failed"
        | "archived"
        | "ipc_corruption"
        | "platform_unsupported";
    message: string;
    capability?: string;
    attempted?: string;
    stack?: string;
    strikes?: number;
    windowMs?: number;
    rssAtKillMb?: number;
    budgetMs?: number;
    archivedImmediately?: boolean;
}

export type SandboxResult =
    | { ok: true; result: unknown }
    | { ok: false; error: SandboxError };

interface NativeForge {
    forgeInvokeTool(
        slug: string,
        handlerDir: string,
        capabilitiesJson: string,
        inputJson: string,
    ): Promise<string>;
    forgeSpawnWarm(slug: string, handlerDir: string, capabilitiesJson: string): Promise<void>;
    forgeEvict(slug: string): Promise<void>;
    forgeStrikes(slug: string): number;
    forgeClearStrikes(slug: string): void;
    forgeSetPoolSize(size: number): void;
}

let native: NativeForge | null = null;

try {
    const nativePath = path.join(process.cwd(), "native", "index.js");
    const requireFn = createRequire(import.meta.url);
    const mod = requireFn(nativePath);
    if (typeof mod?.forgeInvokeTool === "function") {
        native = mod as NativeForge;
    }
} catch {
    // Native module unavailable. The shim returns platform_unsupported errors.
}

export function isNativeAvailable(): boolean {
    return native !== null;
}

function unsupportedResult(message: string): SandboxResult {
    return {
        ok: false,
        error: { kind: "platform_unsupported", message },
    };
}

function parseNativeResponse(raw: string): SandboxResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return {
            ok: false,
            error: {
                kind: "ipc_corruption",
                message: `failed to parse native response: ${(e as Error).message}`,
            },
        };
    }
    if (!parsed || typeof parsed !== "object") {
        return {
            ok: false,
            error: { kind: "ipc_corruption", message: "native response not an object" },
        };
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.ok === true) {
        return { ok: true, result: obj.result };
    }
    const err = (obj.error ?? {}) as Record<string, unknown>;
    return {
        ok: false,
        error: {
            kind: (err.kind as SandboxError["kind"]) ?? "handler_error",
            message: typeof err.message === "string" ? err.message : "(no message)",
            capability: err.capability as string | undefined,
            attempted: err.attempted as string | undefined,
            stack: err.stack as string | undefined,
            strikes: typeof err.strikes === "number" ? err.strikes : undefined,
            windowMs: typeof err.window_ms === "number" ? (err.window_ms as number) : undefined,
            budgetMs: typeof err.budget_ms === "number" ? (err.budget_ms as number) : undefined,
            archivedImmediately:
                err.archived_immediately === true ? true : undefined,
        },
    };
}

export async function invokePersistedTool(
    slug: string,
    input: Record<string, unknown>,
): Promise<SandboxResult> {
    if (!native) {
        return unsupportedResult("forge native module not loaded");
    }
    const manifest = readManifest(slug);
    if (!manifest) {
        return {
            ok: false,
            error: {
                kind: "spawn_failed",
                message: `manifest not found for slug ${slug}`,
            },
        };
    }
    const dir = manifestDir(slug);
    const capsJson = asJSON(manifest.capabilities);
    const inputJson = JSON.stringify(input);
    const raw = await native.forgeInvokeTool(slug, dir, capsJson, inputJson);
    return parseNativeResponse(raw);
}

export async function installPersistedTool(
    slug: string,
    handlerCode: string,
    manifest: PersistedToolManifest,
): Promise<void> {
    const dir = manifestDir(slug);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    // Write handler.js. Wrapped in the synthesizer's canonical form.
    const wrappedHandler = `module.exports = async function(input) {\n${handlerCode}\n};\n`;
    await writeFile(path.join(dir, "handler.js"), wrappedHandler, { encoding: "utf-8", mode: 0o644 });
    await writeManifest(slug, manifest);
    if (native) {
        const capsJson = asJSON(manifest.capabilities);
        await native.forgeSpawnWarm(slug, dir, capsJson);
    }
}

export async function uninstallPersistedTool(slug: string): Promise<void> {
    if (native) {
        await native.forgeEvict(slug);
        native.forgeClearStrikes(slug);
    }
    const dir = manifestDir(slug);
    if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
    }
}

export async function reinstallPersistedTool(slug: string): Promise<void> {
    if (!native) return;
    const manifest = readManifest(slug);
    if (!manifest) return;
    const dir = manifestDir(slug);
    const capsJson = asJSON(manifest.capabilities);
    await native.forgeSpawnWarm(slug, dir, capsJson);
}

export function getStrikes(slug: string): number {
    if (!native) return 0;
    return native.forgeStrikes(slug);
}

export function clearStrikes(slug: string): void {
    if (!native) return;
    native.forgeClearStrikes(slug);
}

export function setPoolSize(size: number): void {
    if (!native) return;
    native.forgeSetPoolSize(size);
}
