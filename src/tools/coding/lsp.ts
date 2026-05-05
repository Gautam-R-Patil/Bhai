// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── LSP Tool ──────────────────────────────────
// Minimal Language Server Protocol client over stdio. Spawns a per-language
// server on first use, caches it per workspace, and exposes five high-value
// code-intelligence operations: goToDefinition, findReferences, hover,
// documentSymbol, workspaceSymbol.
//
// Fail-open: if the server binary is not installed, return a clear error
// the agent can act on. If the server crashes, we drop the cached session
// and the next call will respawn. LSP failures never take ATLAS down.
//
// Not a full LSP client — we don't implement diagnostics streaming, code
// actions, formatting, or completion. Just navigation and inspection.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { ToolDefinition } from "../get-current-time.js";
import { getPathBlockedReason, isPathAllowed } from "../../security/allowlist.js";
import { binaryExists as probeBinary } from "./binary-exists.js";

// ── Types ─────────────────────────────────────

type Operation =
    | "goToDefinition"
    | "findReferences"
    | "hover"
    | "documentSymbol"
    | "workspaceSymbol"
    | "getDiagnostics";

type Language = "typescript" | "javascript" | "python" | "rust" | "go";

interface ServerSpec {
    language: Language;
    binary: string;
    args: string[];
    rootIndicators: string[];
}

const SERVER_SPECS: ServerSpec[] = [
    {
        language: "typescript",
        binary: "typescript-language-server",
        args: ["--stdio"],
        rootIndicators: ["tsconfig.json", "package.json"],
    },
    {
        language: "javascript",
        binary: "typescript-language-server",
        args: ["--stdio"],
        rootIndicators: ["jsconfig.json", "package.json"],
    },
    {
        language: "python",
        binary: "pyright-langserver",
        args: ["--stdio"],
        rootIndicators: ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg"],
    },
    {
        language: "rust",
        binary: "rust-analyzer",
        args: [],
        rootIndicators: ["Cargo.toml"],
    },
    {
        language: "go",
        binary: "gopls",
        args: [],
        rootIndicators: ["go.mod"],
    },
];

const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".pyi": "python",
    ".rs": "rust",
    ".go": "go",
};

// ── Session ───────────────────────────────────

interface Pending {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timeoutHandle: NodeJS.Timeout;
}

interface Session {
    language: Language;
    rootUri: string;
    rootPath: string;
    child: ChildProcessByStdio<Writable, Readable, Readable>;
    nextId: number;
    pending: Map<number, Pending>;
    buffer: Buffer;
    openDocs: Map<string, number>; // uri → version
    /** Latest publishDiagnostics payload per URI — server-pushed after
     * didOpen/didChange. Consumed by the getDiagnostics operation. */
    diagnostics: Map<string, LspDiagnostic[]>;
    initPromise: Promise<void>;
    lastUsed: number;
    dead: boolean;
    idleTimer?: NodeJS.Timeout;
}

interface LspDiagnostic {
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    severity?: number; // 1=error, 2=warning, 3=info, 4=hint
    code?: string | number;
    source?: string;
    message: string;
}

// ── Registry ──────────────────────────────────

const sessions: Map<string, Session> = new Map();
const IDLE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

function sessionKey(rootPath: string, language: Language): string {
    return `${language}::${rootPath}`;
}

// ── Binary detection ──────────────────────────

async function binaryExists(binary: string): Promise<boolean> {
    // Delegates to the shared helper, which runs `where` on Windows and
    // `which` elsewhere, rejects shell metacharacters, and never spawns a
    // shell. Keeps lsp.ts's surface unchanged while fixing cross-platform.
    return probeBinary(binary);
}

// ── Language + root detection ─────────────────

function detectLanguage(filePath: string): Language | null {
    const ext = path.extname(filePath).toLowerCase();
    return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

function findWorkspaceRoot(startPath: string, indicators: string[]): string {
    let dir = path.resolve(startPath);
    try {
        if (statSync(dir).isFile()) dir = path.dirname(dir);
    } catch { /* keep given path */ }

    for (let depth = 0; depth < 30; depth++) {
        for (const ind of indicators) {
            if (existsSync(path.join(dir, ind))) return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return path.resolve(startPath);
}

// ── JSON-RPC framing ──────────────────────────

function writeMessage(child: Session["child"], message: Record<string, unknown>): void {
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    try {
        child.stdin.write(header + body, "utf-8");
    } catch (err) {
        console.warn(`[LSP] stdin write failed: ${(err as Error).message}`);
    }
}

function tryParseBuffer(session: Session): void {
    while (true) {
        const headerEnd = session.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = session.buffer.subarray(0, headerEnd).toString("utf-8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
            // Bad frame — drop everything to recover
            session.buffer = Buffer.alloc(0);
            return;
        }
        const contentLength = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        if (session.buffer.length < bodyStart + contentLength) return; // wait for more

        const bodyBuf = session.buffer.subarray(bodyStart, bodyStart + contentLength);
        session.buffer = session.buffer.subarray(bodyStart + contentLength);

        let message: Record<string, unknown>;
        try {
            message = JSON.parse(bodyBuf.toString("utf-8"));
        } catch {
            continue;
        }
        dispatchIncoming(session, message);
    }
}

function dispatchIncoming(session: Session, message: Record<string, unknown>): void {
    // Responses to our requests have an id we recognize.
    const id = message.id;
    if (typeof id === "number" && session.pending.has(id)) {
        const pending = session.pending.get(id)!;
        session.pending.delete(id);
        clearTimeout(pending.timeoutHandle);
        if (message.error) {
            const err = message.error as { message?: string };
            pending.reject(new Error(err.message ?? "LSP error"));
        } else {
            pending.resolve(message.result);
        }
        return;
    }
    // Server-initiated requests (window/showMessageRequest, workspace/configuration)
    // we don't support — reply with a null result so the server isn't blocked.
    if (typeof id === "number" && typeof message.method === "string") {
        writeMessage(session.child, { jsonrpc: "2.0", id, result: null });
        return;
    }
    // Store publishDiagnostics so the getDiagnostics operation can return them.
    // Other notifications (window/logMessage, telemetry/event) are ignored.
    if (message.method === "textDocument/publishDiagnostics") {
        const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
        if (params?.uri && Array.isArray(params.diagnostics)) {
            session.diagnostics.set(params.uri, params.diagnostics);
        }
    }
}

// ── Request primitives ────────────────────────

function sendRequest<T = unknown>(
    session: Session,
    method: string,
    params: unknown,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        if (session.dead) return reject(new Error("LSP session is not running"));
        const id = session.nextId++;
        const timeoutHandle = setTimeout(() => {
            if (session.pending.has(id)) {
                session.pending.delete(id);
                reject(new Error(`LSP request ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
            }
        }, REQUEST_TIMEOUT_MS);
        session.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timeoutHandle });
        writeMessage(session.child, { jsonrpc: "2.0", id, method, params });
    });
}

function sendNotification(session: Session, method: string, params: unknown): void {
    if (session.dead) return;
    writeMessage(session.child, { jsonrpc: "2.0", method, params });
}

// ── Session lifecycle ─────────────────────────

function resetIdleTimer(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
        killSession(session, "idle timeout");
    }, IDLE_MS);
}

function killSession(session: Session, reason: string): void {
    if (session.dead) return;
    session.dead = true;
    for (const [id, p] of session.pending) {
        clearTimeout(p.timeoutHandle);
        p.reject(new Error(`LSP session ended: ${reason}`));
        session.pending.delete(id);
    }
    try { session.child.stdin.end(); } catch { /* */ }
    try { session.child.kill("SIGTERM"); } catch { /* */ }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    const key = sessionKey(session.rootPath, session.language);
    sessions.delete(key);
}

async function getOrCreateSession(rootPath: string, language: Language): Promise<Session> {
    const key = sessionKey(rootPath, language);
    let session = sessions.get(key);
    if (session && !session.dead) {
        session.lastUsed = Date.now();
        resetIdleTimer(session);
        await session.initPromise;
        return session;
    }

    const spec = SERVER_SPECS.find((s) => s.language === language);
    if (!spec) throw new Error(`No LSP server configured for language: ${language}`);
    if (!(await binaryExists(spec.binary))) {
        throw new Error(
            `LSP server "${spec.binary}" is not installed. ` +
                `Install it with your package manager (e.g. npm i -g typescript-language-server for TS, ` +
                `pip install pyright for Python, rustup component add rust-analyzer for Rust).`,
        );
    }

    const child = spawn(spec.binary, spec.args, { stdio: ["pipe", "pipe", "pipe"] });
    session = {
        language,
        rootPath,
        rootUri: pathToFileURL(rootPath).toString(),
        child,
        nextId: 1,
        pending: new Map(),
        buffer: Buffer.alloc(0),
        openDocs: new Map(),
        diagnostics: new Map(),
        initPromise: Promise.resolve(),
        lastUsed: Date.now(),
        dead: false,
    };
    sessions.set(key, session);

    child.stdout.on("data", (chunk: Buffer) => {
        session!.buffer = Buffer.concat([session!.buffer, chunk]);
        try { tryParseBuffer(session!); } catch (err) {
            console.warn(`[LSP] Parse error: ${(err as Error).message}`);
        }
    });
    child.stderr.on("data", (chunk: Buffer) => {
        // Most servers log to stderr; quiet by default.
        const msg = chunk.toString("utf-8").trim();
        if (msg) console.debug(`[LSP ${language}] ${msg.slice(0, 500)}`);
    });
    child.on("exit", (code) => {
        killSession(session!, `server exited with code ${code}`);
    });
    child.on("error", (err) => {
        killSession(session!, `spawn error: ${err.message}`);
    });

    // Initialize
    session.initPromise = (async () => {
        try {
            await sendRequest(session!, "initialize", {
                processId: process.pid,
                rootUri: session!.rootUri,
                rootPath: session!.rootPath,
                capabilities: {
                    textDocument: {
                        definition: { linkSupport: false },
                        references: {},
                        hover: { contentFormat: ["plaintext", "markdown"] },
                        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                    },
                    workspace: {
                        symbol: {},
                    },
                },
                workspaceFolders: [{ uri: session!.rootUri, name: path.basename(session!.rootPath) }],
            });
            sendNotification(session!, "initialized", {});
        } catch (err) {
            killSession(session!, `initialize failed: ${(err as Error).message}`);
            throw err;
        }
    })();

    await session.initPromise;
    resetIdleTimer(session);
    return session;
}

// ── Document lifecycle ────────────────────────

function languageIdFor(language: Language): string {
    return language; // LSP language IDs happen to match our enum values
}

// Cap per session. Above this, the LSP server holds full text for every
// opened file in memory, which matters for long-running coder sessions across
// large repos. Evicting the LRU entry keeps the working set bounded.
const MAX_OPEN_DOCS_PER_SESSION = 500;

function closeOldestDocIfFull(session: Session): void {
    if (session.openDocs.size < MAX_OPEN_DOCS_PER_SESSION) return;
    const oldestUri = session.openDocs.keys().next().value;
    if (oldestUri === undefined) return;
    try {
        sendNotification(session, "textDocument/didClose", {
            textDocument: { uri: oldestUri },
        });
    } catch {
        /* best-effort notify */
    }
    session.openDocs.delete(oldestUri);
}

async function ensureDocumentOpen(session: Session, filePath: string): Promise<string> {
    const abs = path.resolve(filePath);
    const uri = pathToFileURL(abs).toString();
    if (session.openDocs.has(uri)) {
        // Refresh LRU order — re-insert to push this entry to the back of
        // the insertion-ordered Map so it's not the first eviction target.
        const v = session.openDocs.get(uri)!;
        session.openDocs.delete(uri);
        session.openDocs.set(uri, v);
        return uri;
    }

    let text: string;
    try {
        text = readFileSync(abs, "utf-8");
    } catch (err) {
        throw new Error(`Failed to read ${abs}: ${(err as Error).message}`);
    }
    closeOldestDocIfFull(session);
    sendNotification(session, "textDocument/didOpen", {
        textDocument: {
            uri,
            languageId: languageIdFor(session.language),
            version: 1,
            text,
        },
    });
    session.openDocs.set(uri, 1);
    return uri;
}

// ── Public API: single `lsp` tool ─────────────

function uriToPath(uri: string): string {
    if (!uri.startsWith("file://")) return uri;
    return decodeURIComponent(uri.slice(7));
}

function normalizeLocations(raw: unknown): Array<{ file: string; line: number; character: number }> {
    const locs: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const out: Array<{ file: string; line: number; character: number }> = [];
    for (const loc of locs) {
        const o = loc as { uri?: string; range?: { start?: { line?: number; character?: number } } };
        if (!o?.uri || !o.range?.start) continue;
        out.push({
            file: uriToPath(o.uri),
            line: (o.range.start.line ?? 0) + 1,
            character: (o.range.start.character ?? 0) + 1,
        });
    }
    return out;
}

interface SymbolSummary {
    name: string;
    kind: string;
    file: string;
    line: number;
    character: number;
    containerName?: string;
}

const SYMBOL_KIND_NAMES: Record<number, string> = {
    1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
    6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
    11: "Interface", 12: "Function", 13: "Variable", 14: "Constant", 15: "String",
    16: "Number", 17: "Boolean", 18: "Array", 19: "Object", 20: "Key",
    21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event", 25: "Operator",
    26: "TypeParameter",
};

function normalizeSymbols(raw: unknown, fallbackFile: string): SymbolSummary[] {
    const arr: unknown[] = Array.isArray(raw) ? raw : [];
    const out: SymbolSummary[] = [];
    const visit = (syms: unknown[], containerName?: string) => {
        for (const s of syms) {
            const o = s as {
                name?: string;
                kind?: number;
                location?: { uri?: string; range?: { start?: { line?: number; character?: number } } };
                range?: { start?: { line?: number; character?: number } };
                selectionRange?: { start?: { line?: number; character?: number } };
                containerName?: string;
                children?: unknown[];
            };
            if (!o?.name) continue;
            const locUri = o.location?.uri;
            const start = o.location?.range?.start ?? o.selectionRange?.start ?? o.range?.start;
            out.push({
                name: o.name,
                kind: SYMBOL_KIND_NAMES[o.kind ?? 0] ?? String(o.kind ?? "Unknown"),
                file: locUri ? uriToPath(locUri) : fallbackFile,
                line: (start?.line ?? 0) + 1,
                character: (start?.character ?? 0) + 1,
                containerName: o.containerName ?? containerName,
            });
            if (Array.isArray(o.children) && o.children.length > 0) {
                visit(o.children, o.name);
            }
        }
    };
    visit(arr);
    return out;
}

export const lsp: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "lsp",
            description:
                "Language Server Protocol operations for code navigation and inspection. " +
                "Operations: 'goToDefinition' (find where a symbol is defined), " +
                "'findReferences' (find all usages), 'hover' (type info + docs for a symbol), " +
                "'documentSymbol' (all symbols in a file), 'workspaceSymbol' (search symbols across the workspace), " +
                "'getDiagnostics' (parse/type/lint errors for a file — call this after an edit to see if your change broke anything). " +
                "Requires the language's LSP server to be installed: typescript-language-server for TS/JS, " +
                "pyright-langserver for Python, rust-analyzer for Rust, gopls for Go.",
            parameters: {
                type: "object",
                properties: {
                    operation: {
                        type: "string",
                        enum: ["goToDefinition", "findReferences", "hover", "documentSymbol", "workspaceSymbol", "getDiagnostics"],
                    },
                    file_path: {
                        type: "string",
                        description: "Target file path. Required for all operations except workspaceSymbol.",
                    },
                    line: {
                        type: "number",
                        description: "1-based line number. Required for goToDefinition, findReferences, hover.",
                    },
                    character: {
                        type: "number",
                        description: "1-based character position. Required for goToDefinition, findReferences, hover.",
                    },
                    query: {
                        type: "string",
                        description: "Symbol name to search for. Required for workspaceSymbol.",
                    },
                    workspace_root: {
                        type: "string",
                        description: "Optional workspace root. Auto-detected from file_path via project markers (tsconfig.json, Cargo.toml, etc.) if omitted.",
                    },
                },
                required: ["operation"],
            },
        },
    },

    async handler(input) {
        const op = input.operation as Operation;
        if (!op) return JSON.stringify({ error: "operation is required" });

        try {
            // workspaceSymbol can run without a file_path
            if (op === "workspaceSymbol") {
                const query = (input.query as string) ?? "";
                if (!query) return JSON.stringify({ error: "query is required for workspaceSymbol" });
                const wsRoot = (input.workspace_root as string) || process.cwd();
                const rootAbs = path.resolve(wsRoot);
                if (!isPathAllowed(rootAbs)) {
                    const reason = getPathBlockedReason(rootAbs) ?? `Path "${rootAbs}" is not allowed.`;
                    return JSON.stringify({ error: reason });
                }

                // Use TypeScript by default; caller can specify via file_path+ext.
                const filePath = (input.file_path as string) || "";
                const lang = filePath ? detectLanguage(filePath) : "typescript";
                if (!lang) {
                    return JSON.stringify({ error: `Could not determine language from ${filePath}` });
                }
                const spec = SERVER_SPECS.find((s) => s.language === lang)!;
                const detectedRoot = findWorkspaceRoot(rootAbs, spec.rootIndicators);
                const session = await getOrCreateSession(detectedRoot, lang);
                const result = await sendRequest(session, "workspace/symbol", { query });
                const symbols = normalizeSymbols(result, detectedRoot);
                return JSON.stringify({
                    success: true,
                    operation: op,
                    query,
                    language: lang,
                    workspace_root: detectedRoot,
                    symbols: symbols.slice(0, 100),
                    total: symbols.length,
                    truncated: symbols.length > 100,
                });
            }

            const rawPath = input.file_path as string;
            if (!rawPath) return JSON.stringify({ error: "file_path is required" });
            const filePath = path.resolve(rawPath);
            if (!isPathAllowed(filePath)) {
                const reason = getPathBlockedReason(filePath) ?? `Path "${filePath}" is not allowed.`;
                return JSON.stringify({ error: reason });
            }

            const lang = detectLanguage(filePath);
            if (!lang) {
                return JSON.stringify({
                    error: `Unsupported file extension for ${filePath}. LSP supports: ${Object.keys(EXTENSION_TO_LANGUAGE).join(", ")}`,
                });
            }
            const spec = SERVER_SPECS.find((s) => s.language === lang)!;
            const wsRoot = (input.workspace_root as string) || findWorkspaceRoot(filePath, spec.rootIndicators);
            const session = await getOrCreateSession(wsRoot, lang);
            const uri = await ensureDocumentOpen(session, filePath);

            if (op === "documentSymbol") {
                const result = await sendRequest(session, "textDocument/documentSymbol", {
                    textDocument: { uri },
                });
                const symbols = normalizeSymbols(result, filePath);
                return JSON.stringify({
                    success: true,
                    operation: op,
                    file: filePath,
                    language: lang,
                    symbols: symbols.slice(0, 500),
                    total: symbols.length,
                    truncated: symbols.length > 500,
                });
            }

            // position-based ops
            const line = Number(input.line);
            const character = Number(input.character);
            if (!Number.isFinite(line) || !Number.isFinite(character)) {
                return JSON.stringify({ error: "line and character are required for this operation" });
            }
            const position = { line: Math.max(0, line - 1), character: Math.max(0, character - 1) };

            if (op === "goToDefinition") {
                const result = await sendRequest(session, "textDocument/definition", {
                    textDocument: { uri },
                    position,
                });
                const locations = normalizeLocations(result);
                return JSON.stringify({
                    success: true,
                    operation: op,
                    language: lang,
                    locations,
                    found: locations.length,
                });
            }

            if (op === "findReferences") {
                const result = await sendRequest(session, "textDocument/references", {
                    textDocument: { uri },
                    position,
                    context: { includeDeclaration: true },
                });
                const locations = normalizeLocations(result);
                return JSON.stringify({
                    success: true,
                    operation: op,
                    language: lang,
                    references: locations.slice(0, 500),
                    total: locations.length,
                    truncated: locations.length > 500,
                });
            }

            if (op === "hover") {
                const result = await sendRequest<{
                    contents?:
                        | string
                        | { value?: string }
                        | Array<string | { value?: string; language?: string }>;
                }>(session, "textDocument/hover", {
                    textDocument: { uri },
                    position,
                });
                const contents = result?.contents;
                let text = "";
                if (typeof contents === "string") text = contents;
                else if (contents && typeof contents === "object" && !Array.isArray(contents)) {
                    text = (contents as { value?: string }).value ?? "";
                } else if (Array.isArray(contents)) {
                    text = contents
                        .map((c) => (typeof c === "string" ? c : ((c as { value?: string }).value ?? "")))
                        .filter(Boolean)
                        .join("\n\n");
                }
                return JSON.stringify({
                    success: true,
                    operation: op,
                    language: lang,
                    hover: text,
                });
            }

            if (op === "getDiagnostics") {
                // uri + filePath + session already exist from shared setup above.
                // Wait a short window for the LSP to push publishDiagnostics.
                const deadline = Date.now() + 2500;
                // The LSP may push multiple updates as it analyzes; settle for
                // the latest value by polling at short intervals.
                let lastSeen: LspDiagnostic[] | undefined;
                while (Date.now() < deadline) {
                    lastSeen = session.diagnostics.get(uri);
                    if (lastSeen !== undefined) break;
                    await new Promise((r) => setTimeout(r, 100));
                }
                const diagnostics = (lastSeen ?? []).map((d) => ({
                    line: (d.range.start.line ?? 0) + 1,
                    character: (d.range.start.character ?? 0) + 1,
                    severity:
                        d.severity === 1 ? "error" :
                        d.severity === 2 ? "warning" :
                        d.severity === 3 ? "info" :
                        d.severity === 4 ? "hint" : "unknown",
                    source: d.source,
                    code: d.code,
                    message: d.message,
                }));
                const errorCount = diagnostics.filter((d) => d.severity === "error").length;
                const warningCount = diagnostics.filter((d) => d.severity === "warning").length;
                return JSON.stringify({
                    success: true,
                    operation: op,
                    language: lang,
                    file: filePath,
                    diagnostics,
                    error_count: errorCount,
                    warning_count: warningCount,
                });
            }

            return JSON.stringify({ error: `Unknown operation: ${op}` });
        } catch (err) {
            return JSON.stringify({ error: (err as Error).message });
        }
    },
};

// ── Cleanup on process exit ───────────────────

function shutdownAll(): void {
    for (const session of sessions.values()) killSession(session, "process exit");
}

process.once("exit", shutdownAll);
process.once("SIGINT", () => { shutdownAll(); });
process.once("SIGTERM", () => { shutdownAll(); });

/** For diagnostics and tests. */
export function _getActiveSessionCount(): number {
    return sessions.size;
}

/** Explicit shutdown entrypoint for tests/reset. */
export function shutdownLspSessions(): void {
    shutdownAll();
}
