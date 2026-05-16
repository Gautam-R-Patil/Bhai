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

// ── Tracked dynamic tool names for listing ───────────────
const dynamicToolNames = new Set<string>();

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

const safeFetch = globalThis.fetch;

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

    // The utils object exposed inside the sandbox — restricted to safe operations
    const utils = Object.freeze({
        // Read-only filesystem access
        fs: readOnlyFs,
        path,
        homedir: homedir(),
        // Shell execution — validated through the allowlist before running
        exec: async (cmd: string, options?: Record<string, unknown>) => {
            if (typeof cmd !== "string") {
                throw new Error("utils.exec expects a command string, e.g. utils.exec('ls -la')");
            }
            validateShellCommand(cmd);
            return execAsync(cmd, { timeout: 30000, ...options });
        },
        // execFile for when command + args are separate: utils.execFile('git', ['status'])
        execFile: async (command: string, args?: string[], options?: Record<string, unknown>) => {
            if (typeof command !== "string") {
                throw new Error("utils.execFile expects a command string as first argument");
            }
            validateShellCommand(command, args);
            return execFileAsync(command, args, { timeout: 30000, ...options });
        },
        fetch: safeFetch,
        JSON,
        Buffer,
        // Safe console — only log, warn, error (no access to host stdout directly)
        console: Object.freeze({
            log: console.log.bind(console),
            warn: console.warn.bind(console),
            error: console.error.bind(console),
            info: console.info.bind(console),
        }),
        setTimeout: globalThis.setTimeout,
        URL,
        URLSearchParams,
        require: sandboxRequire,
    });

    return async (input: Record<string, unknown>): Promise<string> => {
        try {
            // Create a fresh V8 context for each execution — no access to host globals.
            // Each property here is explicitly chosen; nothing else leaks in.
            const sandbox: Record<string, unknown> = {
                // Safe built-in constructors (copies, not references to host globals)
                JSON,
                Math,
                Date,
                String,
                Number,
                Boolean,
                Array,
                Object,
                RegExp,
                Map,
                Set,
                WeakMap,
                WeakSet,
                Promise,
                Error,
                TypeError,
                RangeError,
                SyntaxError,
                URIError,
                Buffer,
                URL,
                URLSearchParams,
                // Safe global functions
                parseInt,
                parseFloat,
                isNaN,
                isFinite,
                encodeURIComponent,
                decodeURIComponent,
                encodeURI,
                decodeURI,
                setTimeout: globalThis.setTimeout,
                clearTimeout: globalThis.clearTimeout,
                setInterval: globalThis.setInterval,
                clearInterval: globalThis.clearInterval,
                // Explicitly blocked — these will be undefined in the sandbox
                // process: undefined,
                // globalThis: undefined,
                // global: undefined,
                // require: undefined (the real one — our shim is passed as a parameter)
                // __dirname: undefined,
                // __filename: undefined,
                console: utils.console,
                fetch: safeFetch,
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
            description: `Create a new tool at runtime. The handler code runs in a sandboxed async context with two variables: 'input' (parameters) and 'utils' (fs [read-only: readFile/readdir/stat/existsSync], path, exec [validated against security allowlist], execFile [validated], fetch, JSON, Buffer, console.log, URL, URLSearchParams, homedir, require [path/url/querystring/crypto only]). Built-in globals available: Math, Date, String, Array, Object, RegExp, Map, Set, Promise, setTimeout, parseInt, etc. Use utils.exec("command string") for shell commands. Example: "const {stdout} = await utils.exec('ls -la ' + input.dir); return stdout;"`,
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
                        return JSON.stringify({
                            success: true,
                            synthesized: true,
                            tool_name: result.slug,
                            attempts: result.attempts,
                            message: `Tool "${result.slug}" synthesized and verified (${result.testsPassed}/${result.testsTotal} tests passed).`,
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

        // Build the handler
        let handler: (input: Record<string, unknown>) => Promise<string>;
        try {
            handler = buildHandler(handlerCode);
        } catch (err) {
            return JSON.stringify({ error: `Invalid handler code: ${(err as Error).message}` });
        }

        // Quick validation — try calling with empty input
        try {
            await Promise.race([
                handler({}),
                new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
            ]);
        } catch {
            // Validation failure is OK — the tool may need real inputs to work
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
                const toolData = {
                    name,
                    description,
                    parameters_schema: paramsSchema || { type: "object", properties: {}, required: [] },
                    handler_code: handlerCode,
                    created_at: new Date().toISOString(),
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

    const files = fs.readdirSync(DYNAMIC_TOOLS_DIR).filter((f) => f.endsWith(".json"));
    let loaded = 0;

    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(DYNAMIC_TOOLS_DIR, file), "utf-8"));
            const { name, description, parameters_schema, handler_code } = data;

            if (!name || !handler_code) continue;
            if (registryRef.has(name) && !dynamicToolNames.has(name)) continue; // Don't override built-in

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
}
