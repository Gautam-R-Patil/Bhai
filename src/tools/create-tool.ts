// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Dynamic Tool Creator ─────────────────────────────────
// Lets the agent create new tools at runtime when it doesn't have
// a built-in tool for a task. Supports session-only and persistent tools.
// Handler code runs under runIsolated (security/vm-isolate.ts), which keeps
// every host object, and so the host process, out of its reach.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { isPathAllowed } from "../security/allowlist.js";
import { isSensitivePath } from "../security/sensitive-paths.js";
import { type IsolatedRunOpts, runIsolated } from "../security/vm-isolate.js";
import type { ToolDefinition } from "./get-current-time.js";

const DYNAMIC_TOOLS_DIR = path.join(homedir(), ".atlas", "dynamic-tools");

// ── Registry reference (set by index.ts at boot) ─────────
let registryRef: Map<string, ToolDefinition> | null = null;

export function setRegistryRef(reg: Map<string, ToolDefinition>): void {
    registryRef = reg;
}

export function getRegistryRef(): Map<string, ToolDefinition> | null {
    return registryRef;
}

// ── Tracked dynamic tool names for listing ───────────────
const dynamicToolNames = new Set<string>();

/** True when `name` belongs to a built-in tool, which no dynamic tool may replace. */
export function isBuiltinToolName(name: string): boolean {
    return !!registryRef?.has(name) && !dynamicToolNames.has(name);
}

/** Register a runtime-made tool so list_dynamic_tools and the tool router see it. */
export function registerDynamicTool(name: string, def: ToolDefinition): boolean {
    if (!registryRef || isBuiltinToolName(name)) return false;
    registryRef.set(name, def);
    dynamicToolNames.add(name);
    return true;
}

/** Remove a dynamic tool; built-ins are left alone. */
export function unregisterDynamicTool(name: string): void {
    if (dynamicToolNames.delete(name)) registryRef?.delete(name);
}

/** Schemas of the dynamic tools still registered (revoke removes them). */
export function getDynamicToolSchemas(): ChatCompletionTool[] {
    return [...dynamicToolNames].flatMap((n) => registryRef?.get(n)?.schema ?? []);
}

// ── Persisted-handler integrity key (F8) ──────────────────
//
// Threat: a malicious actor (or another tool) that can write to
// ~/.atlas/dynamic-tools/*.json could swap a tool's handler_code for an
// arbitrary payload that auto-loads on next Bhai boot. The verifier never
// re-runs, the SAST never re-scans, and the user never re-approves — so
// the only defense is a tamper-detection signature.
//
// Strategy: at first call, lazily generate (or load) a 32-byte key at
// ~/.atlas/data/forge-persist-key (mode 0o600). At persist time, sign the
// canonical JSON of {name, handler_code, parameters_schema}. At load time,
// verify the signature; on mismatch or missing signature, move the file
// to ~/.atlas/store/dynamic/_failed/ and skip loading.
//
// Failure mode: if the key file gets deleted, ALL existing persisted tools
// are quarantined (correct — we cannot prove they're still safe). User has
// to re-create them via the verifier path.

const PERSIST_KEY_PATH = path.join(homedir(), ".atlas", "data", "forge-persist-key");
const FAILED_DIR = path.join(homedir(), ".atlas", "store", "dynamic", "_failed");

let _persistKey: Buffer | null = null;
function getPersistKey(): Buffer {
    if (_persistKey) return _persistKey;
    try {
        if (fs.existsSync(PERSIST_KEY_PATH)) {
            const buf = fs.readFileSync(PERSIST_KEY_PATH);
            if (buf.length === 32) {
                _persistKey = buf;
                return _persistKey;
            }
        }
    } catch {
        /* fall through to regenerate */
    }
    const fresh = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(PERSIST_KEY_PATH), { recursive: true });
    fs.writeFileSync(PERSIST_KEY_PATH, fresh, { mode: 0o600 });
    try {
        fs.chmodSync(PERSIST_KEY_PATH, 0o600);
    } catch {
        /* best-effort on platforms without POSIX chmod semantics */
    }
    _persistKey = fresh;
    return _persistKey;
}

function canonicalToolJson(o: { name: string; handler_code: string; parameters_schema: unknown }): string {
    return JSON.stringify({
        canon_version: 1,
        name: o.name,
        handler_code: o.handler_code,
        parameters_schema: o.parameters_schema ?? null,
    });
}

function signPersistedTool(o: { name: string; handler_code: string; parameters_schema: unknown }): string {
    return crypto.createHmac("sha256", getPersistKey()).update(canonicalToolJson(o)).digest("hex");
}

function verifyPersistedTool(data: {
    name?: unknown;
    handler_code?: unknown;
    parameters_schema?: unknown;
    hmac?: unknown;
}): boolean {
    if (typeof data.name !== "string" || typeof data.handler_code !== "string" || typeof data.hmac !== "string") {
        return false;
    }
    if (data.hmac.length !== 64) return false;
    const expected = signPersistedTool({
        name: data.name,
        handler_code: data.handler_code,
        parameters_schema: data.parameters_schema,
    });
    const a = Buffer.from(data.hmac, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

function quarantineCorruptTool(srcPath: string, reason: string): void {
    try {
        fs.mkdirSync(FAILED_DIR, { recursive: true });
        const base = path.basename(srcPath);
        const dst = path.join(FAILED_DIR, `${Date.now()}_${base}`);
        fs.renameSync(srcPath, dst);
        console.error(`⚠️ Quarantined persisted tool "${base}" → ${dst} (${reason})`);
    } catch (err) {
        console.error(`⚠️ Failed to quarantine "${srcPath}":`, (err as Error).message);
    }
}

// ── Sandboxed handler builder ────────────────────────────
// Handler code runs under runIsolated (security/vm-isolate.ts), which hands it
// no host-realm object at all: any host function or object inside the context
// leads back to the host Function constructor and from there to child_process.
// utils is built inside the sandbox; its fs and path functions make one
// string-only host call each. The verifier (forge/sandbox-runner.ts) runs
// handlers through this same runtime, so what passes verification runs here.

const SANDBOX_FS = ["readFile", "readFileSync", "readdir", "readdirSync", "existsSync", "stat", "statSync"];
const SANDBOX_PATH = ["join", "resolve", "basename", "dirname", "extname", "relative", "normalize", "isAbsolute"];

/** Host side of the sandbox's fs/path calls. Reads are path-checked. */
function sandboxBridge(name: string, rawArgs: unknown): unknown {
    const [op, fn] = name.split(".");
    const args = Array.isArray(rawArgs) ? rawArgs : [];
    if (op === "fs" && SANDBOX_FS.includes(fn)) {
        const target = path.resolve(String(args[0] ?? ""));
        if (!isPathAllowed(target) || isSensitivePath(target).denied) throw new Error(`Path not allowed: ${target}`);
        const base = fn === "existsSync" ? fn : fn.replace(/Sync$/, "");
        if (base === "readFile") return fs.readFileSync(target, "utf8");
        if (base === "readdir") {
            const withTypes = (args[1] as { withFileTypes?: boolean } | undefined)?.withFileTypes === true;
            return withTypes
                ? fs
                      .readdirSync(target, { withFileTypes: true })
                      .map((d) => ({ name: d.name, isFile: d.isFile(), isDirectory: d.isDirectory() }))
                : fs.readdirSync(target);
        }
        if (base === "existsSync") return fs.existsSync(target);
        const st = fs.statSync(target);
        return { size: st.size, isFile: st.isFile(), isDirectory: st.isDirectory(), mtimeMs: st.mtimeMs };
    }
    if (op === "path" && SANDBOX_PATH.includes(fn))
        return (path as unknown as Record<string, (...a: string[]) => unknown>)[fn](...args.map(String));
    throw new Error(`${name} is not available`);
}

// In-context expression for runIsolated's `api`: the handler's `utils`.
// Stats and Dirents come back in Node's shape (s.isFile() is a method).
export const SANDBOX_API = `(() => {
    const fns = (op, names, isAsync, post) => Object.freeze(Object.fromEntries(names.map((n) => [n, isAsync(n)
        ? async (...a) => post(n, callSync(op + "." + n, a))
        : (...a) => post(n, callSync(op + "." + n, a))])));
    const nodeShape = (s) => Object.freeze({ ...s, isFile: () => s.isFile, isDirectory: () => s.isDirectory });
    const fs = fns("fs", ${JSON.stringify(SANDBOX_FS)}, (n) => !/Sync$/.test(n) && n !== "existsSync", (n, v) =>
        /^stat/.test(n) ? nodeShape(v)
        : /^readdir/.test(n) && Array.isArray(v) && v.length && typeof v[0] === "object" ? v.map(nodeShape) : v);
    const path = Object.freeze({ ...fns("path", ${JSON.stringify(SANDBOX_PATH)}, () => false, (n, v) => v),
        sep: ${JSON.stringify(path.sep)}, delimiter: ${JSON.stringify(path.delimiter)} });
    const os = Object.freeze({ homedir: () => ${JSON.stringify(homedir())}, tmpdir: () => ${JSON.stringify(tmpdir())},
        platform: ${JSON.stringify(process.platform)} });
    const modules = { path, "node:path": path, fs, "node:fs": fs, os, "node:os": os };
    const deny = (what) => async () => { throw new Error(what + " is denied here: shell and network need the Phase-4 kernel sandbox (declare the capability in the forge envelope)."); };
    return Object.freeze({
        fs, path, homedir: os.homedir(), JSON,
        require: (m) => {
            if (Object.prototype.hasOwnProperty.call(modules, m)) return modules[m];
            throw new Error('require("' + m + '") is not available in the sandbox. Allowed: path, fs (read-only), os.');
        },
        exec: deny("utils.exec"), execFile: deny("utils.execFile"), fetch: deny("utils.fetch"),
    });
})()`;

/**
 * runIsolated options for a dynamic-tool handler body: called as
 * `(input, utils, console)`, with `require` and utils.console/setTimeout too.
 */
export function dynamicToolSandbox(code: string): Pick<IsolatedRunOpts, "fn" | "api" | "onCallSync"> {
    return {
        fn: `async function (input, utils, console) {
            utils = Object.freeze({ ...utils, console, setTimeout });
            const require = utils.require;
            ${code}
        }`,
        api: SANDBOX_API,
        onCallSync: sandboxBridge,
    };
}

function buildHandler(code: string): (input: Record<string, unknown>) => Promise<string> {
    // Compile once — throws early on syntax errors.
    const opts = dynamicToolSandbox(code);
    new vm.Script(`(${opts.fn})`, { filename: "dynamic-tool-sandbox.vm" });

    return async (input: Record<string, unknown>): Promise<string> => {
        const r = await runIsolated({
            ...opts,
            input: input ?? {},
            onLog: (_level, line) => console.log("  [dynamic-tool]", line),
            timeoutMs: 60_000,
            filename: "dynamic-tool-sandbox.vm",
        });
        if (!r.ok) return JSON.stringify({ error: `Dynamic tool error: ${r.error}` });
        return typeof r.result === "string" ? r.result : (JSON.stringify(r.result) ?? "");
    };
}

// ── create_tool ──────────────────────────────────────────

export const createTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "create_tool",
            description: `Create a new tool at runtime. The handler runs in a sandboxed async context with two variables: 'input' (parameters) and 'utils' (fs [read-only: readFile/readdir/stat/existsSync], path, homedir, JSON, console.log, setTimeout, require [path, fs (read-only), os only]). Plus the sandbox's own JavaScript built-ins: Math, JSON, parseInt, Array, Object, Date, Promise, Map, Set, RegExp, Error (no Buffer, URL, crypto or fetch). Reads outside allowed paths and of sensitive files are refused. Shell/network capabilities (utils.exec/execFile/fetch) are DENIED in this sandbox; they require the Phase-4 kernel-sandbox. Use the forge envelope (capabilities_declared) for those.`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description:
                            "Tool name in snake_case (e.g., 'send_whatsapp', 'translate_text'). Must be unique.",
                    },
                    description: {
                        type: "string",
                        description: "What this tool does — shown to the LLM for tool selection.",
                    },
                    parameters_schema: {
                        type: "object",
                        description:
                            "JSON Schema for the tool's input parameters. Must be {type: 'object', properties: {...}, required: [...]}.",
                    },
                    handler_code: {
                        type: "string",
                        description:
                            "JavaScript code for the handler. Runs in async context with 'input' and 'utils' available. Must return a string or JSON-serializable value.",
                    },
                    persistent: {
                        type: "boolean",
                        description:
                            "If true, saves the tool to disk so it persists across restarts. Default: false (session-only).",
                    },
                },
                required: ["name", "description", "handler_code"],
            },
        },
    },

    async handler(input: Record<string, unknown>): Promise<string> {
        const name = input.name as string;
        const description = input.description as string;
        const handlerCode = input.handler_code as string;
        const paramsSchema = input.parameters_schema as Record<string, unknown> | undefined;
        const persistent = input.persistent as boolean | undefined;

        if (!registryRef) {
            return JSON.stringify({ error: "Tool registry not initialized" });
        }

        // Validate name
        if (!/^[a-z][a-z0-9_]*$/.test(name)) {
            return JSON.stringify({
                error: "Invalid tool name — must be snake_case (lowercase letters, digits, underscores)",
            });
        }

        // Never a built-in's name, on any route: a forge tool named shell_exec or
        // send_message replaced the real one after approval (the check used to sit after
        // the forge routes had already returned).
        if (isBuiltinToolName(name)) {
            return JSON.stringify({ error: `Cannot override built-in tool "${name}". Choose a different name.` });
        }

        // ── FORGE Phase 3: route through verifier when ready ──
        if (process.env.ATLAS_NO_FORGE_VERIFIER !== "true") {
            try {
                const { synthesizeTool, isForgeReady } = await import("../forge/orchestrator.js");
                if (isForgeReady()) {
                    const result = await synthesizeTool({
                        name,
                        description,
                        parametersSchema: paramsSchema ?? { type: "object", properties: {}, required: [] },
                        persistent: !!persistent,
                        source: "synchronous",
                        originIntent: description,
                    });

                    if (result.kind === "lookup_hit") {
                        return JSON.stringify({
                            success: true,
                            lookup_hit: true,
                            tool_name: result.slug,
                            message: `Reused existing tool "${result.slug}" — its description matches what you requested. Call it directly.`,
                        });
                    }
                    if (result.kind === "synthesized") {
                        // Register the in-process handler so the agent can
                        // immediately call the synthesized tool. Persistent
                        // tools take a different path (awaiting_approval +
                        // sandboxed registration on approve_dynamic_tool).
                        if (result.handlerCode && registryRef && !registryRef.has(result.slug)) {
                            const sessionHandler = buildHandler(result.handlerCode);
                            registerDynamicTool(result.slug, {
                                schema: {
                                    type: "function",
                                    function: {
                                        name: result.slug,
                                        description,
                                        parameters: (result.parametersSchema as Record<string, unknown>) ??
                                            paramsSchema ?? { type: "object", properties: {}, required: [] },
                                    },
                                },
                                handler: sessionHandler,
                            });
                        }
                        return JSON.stringify({
                            success: true,
                            synthesized: true,
                            tool_name: result.slug,
                            attempts: result.attempts,
                            message: `Tool "${result.slug}" synthesized, verified (${result.testsPassed}/${result.testsTotal} tests passed), and registered.`,
                        });
                    }
                    if (result.kind === "awaiting_approval") {
                        return JSON.stringify({
                            success: true,
                            awaiting_approval: true,
                            tool_name: result.slug,
                            capabilities_requested: result.capabilitiesRequested,
                            message: `Tool "${result.slug}" synthesized. Ask the owner in plain words whether to turn on ${result.slug} and what it can access (capabilities_requested); when they say yes, call approve_dynamic_tool with their words.`,
                        });
                    }
                    if (result.kind === "failed") {
                        return JSON.stringify({
                            error: `Synthesis failed after ${result.report.attempts} attempts: ${result.report.failureReason}`,
                            report_path: result.report.reportPath,
                        });
                    }
                }
            } catch (err) {
                console.warn("[forge] synthesis route failed:", (err as Error).message);
            }
        }

        // Static-only validation: confirm the handler syntactically parses.
        // We do NOT execute the handler here — LLM-supplied code is untrusted and
        // the test-execution path lives inside buildHandler's vm sandbox, which is
        // not strong enough to safely run unknown code at registration time. The
        // proper test-execution path is the verifier (Phase 3); this branch is
        // reached only when the verifier is disabled or unavailable.
        try {
            const acorn = await import("acorn");
            acorn.parse(`(async function() { ${handlerCode} })`, {
                ecmaVersion: "latest",
                sourceType: "script",
            });
        } catch (err) {
            return JSON.stringify({ error: `Invalid handler code: ${(err as Error).message}` });
        }

        // Build the handler (lazy — only compiles, does not execute).
        let handler: (input: Record<string, unknown>) => Promise<string>;
        try {
            handler = buildHandler(handlerCode);
        } catch (err) {
            return JSON.stringify({ error: `Invalid handler code: ${(err as Error).message}` });
        }

        // Build schema
        const schema: ChatCompletionTool = {
            type: "function",
            function: {
                name,
                description: `[Dynamic] ${description}`,
                parameters: (paramsSchema as ChatCompletionTool["function"]["parameters"]) || {
                    type: "object" as const,
                    properties: {},
                    required: [],
                },
            },
        };

        // Register
        registerDynamicTool(name, { schema, handler });

        console.log(`🔧 Dynamic tool created: ${name}${persistent ? " (persistent)" : " (session)"}`);

        // Persist if requested
        if (persistent) {
            try {
                fs.mkdirSync(DYNAMIC_TOOLS_DIR, { recursive: true });
                const paramsSchemaValue = paramsSchema || { type: "object", properties: {}, required: [] };
                const toolData = {
                    name,
                    description,
                    parameters_schema: paramsSchemaValue,
                    handler_code: handlerCode,
                    created_at: new Date().toISOString(),
                    // F8: tamper-detection signature over the executable subset of the file.
                    // If anything mutates the handler_code or parameters_schema on disk,
                    // loadDynamicTools() will refuse to load it on next boot.
                    hmac: signPersistedTool({
                        name,
                        handler_code: handlerCode,
                        parameters_schema: paramsSchemaValue,
                    }),
                };
                fs.writeFileSync(path.join(DYNAMIC_TOOLS_DIR, `${name}.json`), JSON.stringify(toolData, null, 2));
                console.log(`💾 Dynamic tool persisted: ${name}`);
            } catch (err) {
                console.error(`⚠️ Failed to persist tool "${name}":`, (err as Error).message);
            }
        }

        return JSON.stringify({
            success: true,
            tool_name: name,
            message: `Tool "${name}" created and ready to use. Call it with its name and parameters.`,
            persistent: !!persistent,
        });
    },
};

// ── list_dynamic_tools ───────────────────────────────────

export const listDynamicTools: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "list_dynamic_tools",
            description: "List all dynamically created tools in the current session and persisted tools on disk.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },

    async handler(): Promise<string> {
        const sessionTools = Array.from(dynamicToolNames);

        // Check persisted tools
        const persistedTools: string[] = [];
        if (fs.existsSync(DYNAMIC_TOOLS_DIR)) {
            const files = fs.readdirSync(DYNAMIC_TOOLS_DIR).filter((f) => f.endsWith(".json"));
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(DYNAMIC_TOOLS_DIR, file), "utf-8"));
                    persistedTools.push(`${data.name}: ${data.description} (created ${data.created_at})`);
                } catch {
                    /* skip corrupt files */
                }
            }
        }

        return JSON.stringify({
            session_tools: sessionTools,
            persisted_tools: persistedTools,
            total: sessionTools.length + persistedTools.length,
        });
    },
};

// ── Load persisted dynamic tools (called at boot) ────────

export async function loadDynamicTools(): Promise<void> {
    if (!registryRef) {
        console.warn("⚠️ Cannot load dynamic tools — registry not set");
        return;
    }

    if (!fs.existsSync(DYNAMIC_TOOLS_DIR)) return;

    // F8 integrity check + F4 re-SAST. Dynamically import the SAST runner so
    // create-tool.ts doesn't pull in the entire forge graph at module-load time.
    const { runSastCritic } = await import("../forge/critics.js");

    const files = fs.readdirSync(DYNAMIC_TOOLS_DIR).filter((f) => f.endsWith(".json"));
    let loaded = 0;
    let quarantined = 0;

    for (const file of files) {
        const filePath = path.join(DYNAMIC_TOOLS_DIR, file);
        try {
            const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            const { name, description, parameters_schema, handler_code } = data;

            if (!name || !handler_code) continue;
            if (isBuiltinToolName(name)) continue; // Don't override built-in

            // F8: HMAC verification. Refuse unsigned / tampered files.
            if (
                !verifyPersistedTool({
                    name,
                    handler_code,
                    parameters_schema,
                    hmac: data.hmac,
                })
            ) {
                quarantineCorruptTool(filePath, "missing or bad HMAC");
                quarantined++;
                continue;
            }

            // F4: re-run SAST on load — new rules may flag legacy payloads.
            const sast = await runSastCritic(handler_code, { rulesPath: null });
            if (!sast.pass) {
                quarantineCorruptTool(
                    filePath,
                    `SAST rejected on reload: ${sast.findings.find((f) => f.severity === "ERROR")?.ruleId ?? "unknown"}`,
                );
                quarantined++;
                continue;
            }

            const handler = buildHandler(handler_code);
            const schema: ChatCompletionTool = {
                type: "function",
                function: {
                    name,
                    description: `[Dynamic] ${description}`,
                    parameters: parameters_schema || { type: "object", properties: {}, required: [] },
                },
            };

            registerDynamicTool(name, { schema, handler });
            loaded++;
        } catch (err) {
            console.error(`⚠️ Failed to load dynamic tool "${file}":`, (err as Error).message);
        }
    }

    if (loaded > 0) {
        console.log(`🔧 ${loaded} persisted dynamic tool(s) loaded`);
    }
    if (quarantined > 0) {
        console.warn(`⚠️ ${quarantined} persisted tool(s) quarantined due to integrity failure`);
    }
}

/** @internal — tests only. */
export const _buildHandlerForTest = buildHandler;
