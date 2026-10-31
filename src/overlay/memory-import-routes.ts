// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── /api/memory/import/* — the desktop's "Import from another AI" ──
// Owner-token only (never the web widget): preview reads a file the desktop picked and
// shows what's in it (estimate: how many parts and credits that takes, no model call);
// save adds facts to the owner's memory. /api/memory/search is the
// Memory page's search box: ids of the memories recall() finds for a query, by meaning.

import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { LLMClient } from "../llm.js";
import {
    estimateImport,
    extractMemoryFacts,
    MEMORY_EXPORT_PROMPT,
    MEMORY_IMPORT_SOURCES,
    saveImportedFacts,
} from "../memory/memory-import.js";
import { readImportFile } from "../tools/import-memory.js";

const MAX_TEXT_CHARS = 20 * 1024 * 1024;
const PREVIEW_BODY_LIMIT = 25 * 1024 * 1024; // 20 MB of text, plus JSON escaping
const SAVE_BODY_LIMIT = 1024 * 1024; // 300 facts of ≤300 chars

/** Read a request body, refusing (413) past `limit` bytes without buffering the rest. */
export function readBoundedBody(req: IncomingMessage, limit: number): Promise<string> {
    return new Promise((resolve, reject) => {
        if (Number(req.headers["content-length"]) > limit) {
            req.resume();
            reject(Object.assign(new Error("Body too large"), { status: 413 }));
            return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const onData = (c: Buffer) => {
            size += c.length;
            if (size <= limit) return void chunks.push(c);
            req.off("data", onData);
            req.resume(); // drain the rest so the 413 can still be written
            reject(Object.assign(new Error("Body too large"), { status: 413 }));
        };
        req.on("data", onData);
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
}

function send(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The export a preview or estimate is about: pasted `text`, or the file at `path` the desktop picked. */
async function exportFrom(
    req: IncomingMessage,
): Promise<{ raw: string; filename?: string; source?: string } | { status: number; error: string }> {
    const body = JSON.parse(await readBoundedBody(req, PREVIEW_BODY_LIMIT)) as Record<string, unknown>;
    let raw = str(body.text) ?? "";
    let filename = str(body.filename);
    const filePath = str(body.path);
    if (filePath) {
        if (!path.isAbsolute(filePath)) return { status: 400, error: "path must be absolute" };
        const file = await readImportFile(filePath);
        if ("error" in file) return { status: 400, error: file.error };
        raw = file.raw;
        filename ??= file.filename;
    } else if (raw.length > MAX_TEXT_CHARS) {
        return { status: 413, error: "That text is over 20 MB." };
    }
    if (!raw.trim()) return { status: 400, error: "Paste the export or choose a file." };
    return { raw, filename, source: str(body.source) };
}

export async function handleMemoryImportRoute(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    scope: "native-overlay" | "web-widget" | null,
    llm: LLMClient | null,
): Promise<void> {
    if (!scope) return send(res, 401, { error: "Authorization required" });
    if (scope !== "native-overlay") return send(res, 403, { error: "Owner only" });
    try {
        if (pathname === "/api/memory/import/prompt" && req.method === "GET") {
            return send(res, 200, { prompt: MEMORY_EXPORT_PROMPT, sources: MEMORY_IMPORT_SOURCES });
        }
        if (
            (pathname === "/api/memory/import/preview" || pathname === "/api/memory/import/estimate") &&
            req.method === "POST"
        ) {
            const x = await exportFrom(req);
            if ("error" in x) return send(res, x.status, { error: x.error });
            if (pathname === "/api/memory/import/estimate") return send(res, 200, estimateImport(x.raw, x.filename));
            // The client went away (dialog closed, app quit) before the answer: start no more parts.
            // res, not req: req's "close" fires once its body is read.
            const ac = new AbortController();
            res.on("close", () => {
                if (!res.writableEnded) ac.abort();
            });
            return send(res, 200, await extractMemoryFacts({ ...x, llm: llm ?? undefined, signal: ac.signal }));
        }
        if (pathname === "/api/memory/import/save" && req.method === "POST") {
            const body = JSON.parse(await readBoundedBody(req, SAVE_BODY_LIMIT)) as Record<string, unknown>;
            if (!Array.isArray(body.facts)) return send(res, 400, { error: "facts must be a list" });
            return send(res, 200, await saveImportedFacts(body.facts, str(body.source), true));
        }
        if (pathname === "/api/memory/search" && req.method === "POST") {
            const body = JSON.parse(await readBoundedBody(req, 4096)) as Record<string, unknown>;
            const query = str(body.query)?.slice(0, 500);
            if (!query?.trim()) return send(res, 400, { error: "query is required" });
            const { recall } = await import("../memory/sqlite.js");
            const rows = await recall(query, 50, undefined, undefined, undefined, undefined, { touch: false });
            return send(res, 200, { ids: rows.map((r) => r.id) });
        }
        if (pathname === "/api/memory/import/undo" && req.method === "POST") {
            const body = JSON.parse(await readBoundedBody(req, 4096)) as Record<string, unknown>;
            const { undoImportBatch } = await import("../memory/forget.js");
            const r = undoImportBatch(str(body.batch) ?? "");
            return send(res, "error" in r ? 400 : 200, r);
        }
        return send(res, 404, { error: "Not found" });
    } catch (err) {
        const status = (err as { status?: number }).status ?? (err instanceof SyntaxError ? 400 : 500);
        send(res, status, {
            error: status === 413 ? "Too large" : status === 400 ? "Invalid JSON" : (err as Error).message,
        });
    }
}
