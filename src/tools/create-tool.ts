// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Dynamic Tool Creator ─────────────────────────────────
// Lets the agent create new tools at runtime when it doesn't have
// a built-in tool for a task. Supports session-only and persistent tools.
// Handler code is executed inside a vm.createContext() sandbox to prevent
// access to the global scope, prototype chain, and dangerous Node APIs.

import { exec, execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import * as querystring from "node:querystring";
import * as url from "node:url";
import { promisify } from "node:util";
import * as vm from "node:vm";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { isShellBypass, isSystemDestructive, shellArgsTargetProtectedPath } from "../security/allowlist.js";
import type { ToolDefinition } from "./get-current-time.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
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

// ── Read-only fs subset ─────────────────────────────────
// Dynamic tools may read files but not create, write, or delete them.
// Write/delete operations must be done through proper tools or utils.exec().

const readOnlyFs = Object.freeze({
    readFile: fs.promises.readFile.bind(fs.promises),
    readFileSync: fs.readFileSync.bind(fs),
    readdir: fs.promises.readdir.bind(fs.promises),
    readdirSync: fs.readdirSync.bind(fs),
    stat: fs.promises.stat.bind(fs.promises),
    statSync: fs.statSync.bind(fs),
    existsSync: fs.existsSync.bind(fs),
    access: fs.promises.access.bind(fs.promises),
    lstat: fs.promises.lstat.bind(fs.promises),
    lstatSync: fs.lstatSync.bind(fs),
    realpath: fs.promises.realpath.bind(fs.promises),
    realpathSync: fs.realpathSync.bind(fs),
    createReadStream: fs.createReadStream.bind(fs),
    // Expose constants for access() checks (e.g. fs.constants.R_OK)
    constants: Object.freeze({ ...fs.constants }),
});

// ── Shell command validation ────────────────────────────
// Wraps exec/execFile to run commands through the existing security
// allowlist before execution, preventing system-destructive operations.

function validateShellCommand(cmd: string, args?: string[]): void {
    const fullCommand = args && args.length > 0 ? `${cmd} ${args.join(" ")}` : cmd;

    if (isSystemDestructive(fullCommand)) {
        throw new Error(
            `Blocked: command "${cmd}" is system-destructive and not allowed. ` +
                `Commands that wipe the system disk, destroy boot files, or format the main drive are blocked.`,
        );
    }

    if (args && isShellBypass(cmd, args)) {
        throw new Error(`Blocked: inline command contains a system-destructive operation.`);
    }

    // Codebase self-protection: block destructive shell commands targeting the atlas folder
    const DESTRUCTIVE_CMDS = new Set(["rm", "mv", "cp", "rsync", "dd"]);
    const baseCmd = cmd.split("/").at(-1)?.split(" ")[0] ?? cmd;
    if (DESTRUCTIVE_CMDS.has(baseCmd)) {
        const allTokens = args ? [cmd, ...args] : cmd.split(/\s+/);
        const hit = shellArgsTargetProtectedPath(allTokens);
        if (hit) {
            throw new Error(
                `Blocked: command "${cmd}" targets the bot's own codebase path "${hit}". ` +
                    `Write/delete operations on the atlas codebase are not allowed.`,
            );
        }
    }
}

// Note: host `fetch` is not exposed to the sandbox until Phase-4 kernel sandbox
// ships capability enforcement. utils.fetch refuses outright.

// ── Require shim for the sandbox ────────────────────────
// Only a curated set of safe, side-effect-free modules are allowed.
// Dangerous modules (child_process, fs full write access, net, etc.) are blocked.

const SAFE_REQUIRE_MODULES: Record<string, unknown> = {
    path,
    "node:path": path,
    url,
    "node:url": url,
    querystring,
    "node:querystring": querystring,
    crypto,
    "node:crypto": crypto,
    // Provide read-only fs via require('fs') too
    fs: readOnlyFs,
    "node:fs": readOnlyFs,
    os: Object.freeze({ homedir, tmpdir, platform: process.platform }),
    "node:os": Object.freeze({ homedir, tmpdir, platform: process.platform }),
};

function sandboxRequire(moduleName: string): unknown {
    const mod = SAFE_REQUIRE_MODULES[moduleName];
    if (!mod) {
        throw new Error(
            `require("${moduleName}") is not available in the sandbox. ` +
                `Allowed modules: ${Object.keys(SAFE_REQUIRE_MODULES)
                    .filter((k) => !k.startsWith("node:"))
                    .join(", ")}. ` +
                `Use utils.fs (read-only), utils.path, utils.exec instead.`,
        );
    }
    return mod;
}

// ── Sandboxed handler builder ────────────────────────────
// Handler code runs inside a vm.createContext() sandbox. The sandbox
// has NO access to the host global scope (no process, no globalThis,
// no prototype chain traversal back to the host).

function buildHandler(code: string): (input: Record<string, unknown>) => Promise<string> {
    // Pre-compile the script outside the per-call path for efficiency.
    // The script wraps user code in an async IIFE that receives input, utils, require.
    const wrappedSource = `
        (async function __sandboxedHandler(__input, __utils, __require) {
            // Alias for LLM-generated code that uses bare names
            const input = __input;
            const utils = __utils;
            const require = __require;
            ${code}
        })
    `;

    // Compile once — this will throw early if the code has syntax errors
    const compiledScript = new vm.Script(wrappedSource, {
        filename: "dynamic-tool-sandbox.vm",
    });

    // The utils object exposed inside the sandbox.
    //
    // Phase-4 plan: capabilities (fs/net/exec) enforced by an OS-level kernel
    // sandbox (seccomp/sandbox-exec/AppContainer). Until then, the interim
    // vm.createContext sandbox is NOT strong enough to safely expose
    // exec/execFile/fetch/Buffer/URL — those let LLM-supplied code reach
    // arbitrary host code via constructor chains or shell escape.
    //
    // Read-only fs stays (the allowlist gates protected paths) and is the
    // single privileged capability available to legacy synthesized handlers.
    const sandboxConsole = Object.freeze({
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        info: console.info.bind(console),
    });
    const denyExec = () => {
        throw new Error(
            "utils.exec/execFile denied — exec capability requires the Phase-4 kernel sandbox. " +
                "Declare an `exec` capability in your forge envelope; the verifier will provision it.",
        );
    };
    const denyFetch = () => {
        throw new Error(
            "utils.fetch denied — net capability requires the Phase-4 kernel sandbox. " +
                "Declare a `net` capability in your forge envelope; the verifier will provision it.",
        );
    };
    const utils = Object.freeze({
        // Read-only filesystem access (path-gated by allowlist at write sites).
        fs: readOnlyFs,
        path,
        homedir: homedir(),
        exec: denyExec,
        execFile: denyExec,
        fetch: denyFetch,
        JSON,
        console: sandboxConsole,
        setTimeout: globalThis.setTimeout,
        require: sandboxRequire,
    });

    return async (input: Record<string, unknown>): Promise<string> => {
        try {
            // Bootstrap-only globals. Host-realm constructors (Buffer, URL, Promise,
            // Error, Map, Set, WeakMap, RegExp, Array, Object) are NOT passed in:
            // their .constructor chains all resolve back to the host Function
            // constructor and enable `({}).constructor.constructor("...")()` style
            // escapes. The new vm context's own realm provides realm-isolated
            // copies of Array/Object/Date/Promise/Error/RegExp/Map/Set/etc
            // — code inside the sandbox uses those, not these.
            const sandbox: Record<string, unknown> = {
                // Static value-only globals — no constructor exposed back to host.
                JSON,
                Math,
                // Safe global functions (do not expose a useful .constructor surface).
                parseInt,
                parseFloat,
                isNaN,
                isFinite,
                encodeURIComponent,
                decodeURIComponent,
                encodeURI,
                decodeURI,
                // Timers stay (handlers commonly await delays). These are host refs,
                // but they don't expose a constructor-escape chain the way Buffer does.
                setTimeout: globalThis.setTimeout,
                clearTimeout: globalThis.clearTimeout,
                setInterval: globalThis.setInterval,
                clearInterval: globalThis.clearInterval,
                // Console is a sanitized object literal (no host method backrefs).
                console: utils.console,
            };

            const context = vm.createContext(sandbox, {
                name: "dynamic-tool-sandbox",
                codeGeneration: {
                    strings: false, // Block eval() and new Function() inside the sandbox
                    wasm: false, // Block WebAssembly compilation
                },
            });

            // Run the compiled script in the sandbox to get the handler function
            const handlerFn = compiledScript.runInContext(context, {
                timeout: 60000,
            }) as (
                input: Record<string, unknown>,
                utils: Record<string, unknown>,
                require: (mod: string) => unknown,
            ) => Promise<unknown>;

            // Execute the handler with the sandboxed utilities
            const result = await handlerFn(input, utils, sandboxRequire);

            // Ensure string return
            if (typeof result === "string") return result;
            return JSON.stringify(result);
        } catch (err) {
            return JSON.stringify({ error: `Dynamic tool error: ${(err as Error).message}` });
        }
    };
}

// ── create_tool ──────────────────────────────────────────

export const createTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "create_tool",
            description: `Create a new tool at runtime. The handler runs in a sandboxed async context with two variables: 'input' (parameters) and 'utils' (fs [read-only: readFile/readdir/stat/existsSync], path, homedir, JSON, console.log, setTimeout, require [path/url/querystring/crypto/os only]). Built-in sandbox globals: Math, JSON, parseInt, parseFloat, isNaN, isFinite, encode/decodeURIComponent, plus the vm-realm's own Array/Object/Date/Promise/Error/RegExp/Map/Set (use these — host Buffer/URL/fetch are NOT exposed). Shell/network capabilities (utils.exec/execFile/fetch) are DENIED in this sandbox; they require the Phase-4 kernel-sandbox. Use the forge envelope (capabilities_declared) for those.`,
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

        // ── FORGE Phase 2: lookup short-circuit ──
        if (process.env.ATLAS_NO_FORGE_LOOKUP !== "true") {
            try {
                const { lookupTool: forgeLookup, isForgeReady } = await import("../forge/orchestrator.js");
                if (isForgeReady()) {
                    const hit = await forgeLookup(description, paramsSchema ?? {});
                    if (hit) {
                        return JSON.stringify({
                            success: true,
                            lookup_hit: true,
                            tool_name: hit.slug,
                            message: `Reused existing tool "${hit.slug}" — its description matches what you requested. Call it directly with the appropriate parameters.`,
                        });
                    }
                }
            } catch {
                // Forge unavailable — fall through to synthesis
            }
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
                            message: `Reused existing tool "${result.slug}".`,
                        });
                    }
                    if (result.kind === "synthesized") {
                        // Register the in-process handler so the agent can
                        // immediately call the synthesized tool. Persistent
                        // tools take a different path (awaiting_approval +
                        // sandboxed registration on approve_dynamic_tool).
                        if (result.handlerCode && registryRef && !registryRef.has(result.slug)) {
                            const sessionHandler = buildHandler(result.handlerCode);
                            registryRef.set(result.slug, {
                                schema: {
                                    type: "function",
                                    function: {
                                        name: result.slug,
                                        description,
                                        parameters:
                                            (result.parametersSchema as Record<string, unknown>) ??
                                            paramsSchema ??
                                            { type: "object", properties: {}, required: [] },
                                    },
                                },
                                handler: sessionHandler,
                            });
                            dynamicToolNames.add(result.slug);
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
                            message: `Tool "${result.slug}" synthesized. Awaiting user approval — call approve_dynamic_tool({slug, user_quote}) to activate.`,
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

        // Check for conflicts with built-in tools
        if (registryRef.has(name) && !dynamicToolNames.has(name)) {
            return JSON.stringify({ error: `Cannot override built-in tool "${name}". Choose a different name.` });
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
        const toolDef: ToolDefinition = { schema, handler };
        registryRef.set(name, toolDef);
        dynamicToolNames.add(name);

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
            if (registryRef.has(name) && !dynamicToolNames.has(name)) continue; // Don't override built-in

            // F8: HMAC verification. Refuse unsigned / tampered files.
            if (!verifyPersistedTool({
                name,
                handler_code,
                parameters_schema,
                hmac: data.hmac,
            })) {
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

            registryRef.set(name, { schema, handler });
            dynamicToolNames.add(name);
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
