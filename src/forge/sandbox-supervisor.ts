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

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";

import { SANDBOX_API } from "../tools/create-tool.js";
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
    // Verify on-disk handler.js matches the manifest's handlerHash. Defeats
    // post-approval handler swap: agent's `edit`/`write` tools could
    // theoretically rewrite handler.js under ~/.atlas/store/dynamic/<slug>/.
    try {
        const handlerPath = path.join(dir, "handler.js");
        if (!existsSync(handlerPath)) {
            return {
                ok: false,
                error: {
                    kind: "spawn_failed",
                    message: `handler.js missing for slug ${slug}`,
                },
            };
        }
        const handlerBytes = readFileSync(handlerPath);
        const recomputed = createHash("sha256")
            .update(handlerBytes)
            .digest("hex")
            .substring(0, 16);
        if (recomputed !== manifest.handlerHash) {
            return {
                ok: false,
                error: {
                    kind: "spawn_failed",
                    message:
                        `handler.js tamper detected: manifest=${manifest.handlerHash}, ` +
                        `on-disk=${recomputed}. Refusing invocation.`,
                },
            };
        }
    } catch (err) {
        return {
            ok: false,
            error: {
                kind: "spawn_failed",
                message: `handler hash check failed: ${(err as Error).message}`,
            },
        };
    }
    const capsJson = asJSON(manifest.capabilities);
    const inputJson = JSON.stringify(input);
    const raw = await native.forgeInvokeTool(slug, dir, capsJson, inputJson);
    return parseNativeResponse(raw);
}

// handler.js: the handler body under the same (input, utils, console)
// contract as session tools (create-tool's SANDBOX_API), with callSync done
// in-process like create-tool's sandboxBridge; the kernel caps fence the reads.
// console is a no-op: stdout is the shim's IPC channel and stderr is not drained.
export function wrapPersistedHandler(handlerCode: string): string {
    return `const __fs = require("fs"), __path = require("path");
const callSync = (name, a) => {
    const [op, fn] = name.split(".");
    if (op === "path") return __path[fn](...a.map(String));
    const t = __path.resolve(String(a[0] ?? ""));
    if (/^readFile/.test(fn)) return __fs.readFileSync(t, "utf8");
    if (/^readdir/.test(fn)) return a[1] && a[1].withFileTypes === true
        ? __fs.readdirSync(t, { withFileTypes: true }).map((d) => ({ name: d.name, isFile: d.isFile(), isDirectory: d.isDirectory() }))
        : __fs.readdirSync(t);
    if (fn === "existsSync") return __fs.existsSync(t);
    const st = __fs.statSync(t);
    return { size: st.size, isFile: st.isFile(), isDirectory: st.isDirectory(), mtimeMs: st.mtimeMs };
};
const __noop = () => {};
const __console = Object.freeze({ log: __noop, info: __noop, debug: __noop, warn: __noop, error: __noop });
const __utils = Object.freeze({ ...${SANDBOX_API}, console: __console, setTimeout });
const __handler = async function (input, utils, console) {
const require = utils.require;
${handlerCode}
};
module.exports = (input) => __handler(input, __utils, __console);
`;
}

export async function installPersistedTool(
    slug: string,
    handlerCode: string,
    manifest: PersistedToolManifest,
): Promise<void> {
    const dir = manifestDir(slug);
    if (existsSync(dir)) {
        // Refuse to follow symlinks at the slug-dir level. An attacker who
        // can drop a symlink at ~/.atlas/store/dynamic/<slug>/ before install
        // could otherwise divert handler.js writes anywhere user-writable.
        const stat = lstatSync(dir);
        if (stat.isSymbolicLink()) {
            throw new Error(
                `installPersistedTool: refusing to write through symlinked slug dir ${dir}`,
            );
        }
    } else {
        mkdirSync(dir, { recursive: true });
    }
    // Write handler.js: the handler body gets the same (input, utils, console)
    // contract as session tools; the kernel sandbox enforces the capabilities.
    const wrappedHandler = wrapPersistedHandler(handlerCode);
    // The manifest pins the bytes actually written (invoke and boot re-hash them).
    manifest = { ...manifest, handlerHash: createHash("sha256").update(wrappedHandler).digest("hex").substring(0, 16) };
    const handlerPath = path.join(dir, "handler.js");
    let handlerWritten = false;
    try {
        await writeFile(handlerPath, wrappedHandler, { encoding: "utf-8", mode: 0o644 });
        handlerWritten = true;
        await writeManifest(slug, manifest);
        if (native) {
            const capsJson = asJSON(manifest.capabilities);
            await native.forgeSpawnWarm(slug, dir, capsJson);
        }
    } catch (err) {
        // Roll back partial install — orphaned handler.js with no/invalid manifest
        // would leave the slug dir in an inconsistent state.
        if (handlerWritten) {
            try {
                await rm(handlerPath, { force: true });
            } catch {
                /* best-effort */
            }
        }
        throw err;
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
