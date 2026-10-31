// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("../memory/memory-import.js", () => ({
    MEMORY_EXPORT_PROMPT: "PROMPT",
    MEMORY_IMPORT_SOURCES: [{ id: "chatgpt", label: "ChatGPT", hint: "h" }],
    extractMemoryFacts: vi.fn(async () => ({ facts: [], chunks: 1 })),
    saveImportedFacts: vi.fn(async () => ({ added: 0, duplicates: 0, rejected: 0, ids: [] })),
}));
vi.mock("../tools/import-memory.js", () => ({ readImportFile: vi.fn() }));
const recall = vi.fn(async () => [{ id: 7 }, { id: 3 }]);
vi.mock("../memory/sqlite.js", () => ({ recall }));
vi.mock("../memory/forget.js", () => ({
    undoImportBatch: vi.fn((b: string) => (b.startsWith("import:") ? { forgotten: 3 } : { error: "Not an import batch." })),
}));

const { handleMemoryImportRoute } = await import("./memory-import-routes.js");

function call(method: string, pathname: string, scope: "native-overlay" | "web-widget" | null, body = "") {
    const req = Object.assign(new PassThrough(), { method, headers: {} }) as unknown as IncomingMessage;
    (req as unknown as PassThrough).end(body);
    let status = 0;
    let out = "";
    const res = {
        get headersSent() {
            return status !== 0;
        },
        writeHead(s: number) {
            status = s;
        },
        end(b: string) {
            out = b;
        },
    } as unknown as ServerResponse;
    return handleMemoryImportRoute(req, res, pathname, scope, null).then(() => ({ status, body: JSON.parse(out) }));
}

describe("/api/memory/import/*", () => {
    it("needs the owner's loopback token: none is 401, the web widget's is 403", async () => {
        expect((await call("GET", "/api/memory/import/prompt", null)).status).toBe(401);
        expect((await call("GET", "/api/memory/import/prompt", "web-widget")).status).toBe(403);
        expect((await call("POST", "/api/memory/import/save", "web-widget", '{"facts":[]}')).status).toBe(403);
    });

    it("serves the prompt and checks bodies for the owner", async () => {
        const p = await call("GET", "/api/memory/import/prompt", "native-overlay");
        expect(p).toEqual({ status: 200, body: { prompt: "PROMPT", sources: [{ id: "chatgpt", label: "ChatGPT", hint: "h" }] } });
        expect((await call("POST", "/api/memory/import/save", "native-overlay", "{nope")).status).toBe(400);
        expect((await call("POST", "/api/memory/import/save", "native-overlay", '{"facts":1}')).status).toBe(400);
        expect((await call("POST", "/api/memory/import/save", "native-overlay", '{"facts":[]}')).status).toBe(200);
        expect((await call("POST", "/api/memory/import/preview", "native-overlay", '{"path":"rel.json"}')).status).toBe(400);
    });

    it("undoes one import by its batch, for the owner only", async () => {
        const body = '{"batch":"import:2026-10-31T07:30:12-ab12"}';
        expect((await call("POST", "/api/memory/import/undo", "web-widget", body)).status).toBe(403);
        expect(await call("POST", "/api/memory/import/undo", "native-overlay", body)).toEqual({ status: 200, body: { forgotten: 3 } });
        expect((await call("POST", "/api/memory/import/undo", "native-overlay", '{"batch":"x"}')).status).toBe(400);
    });

    it("searches memories by meaning for the owner only, without touching them", async () => {
        expect((await call("POST", "/api/memory/search", "web-widget", '{"query":"sister"}')).status).toBe(403);
        expect((await call("POST", "/api/memory/search", "native-overlay", '{"query":" "}')).status).toBe(400);
        expect(await call("POST", "/api/memory/search", "native-overlay", '{"query":"my sister"}')).toEqual({ status: 200, body: { ids: [7, 3] } });
        expect(recall).toHaveBeenCalledWith("my sister", 50, undefined, undefined, undefined, undefined, { touch: false });
    });

    it("refuses a body over the limit with 413", async () => {
        const big = JSON.stringify({ facts: ["x".repeat(2 * 1024 * 1024)] });
        expect((await call("POST", "/api/memory/import/save", "native-overlay", big)).status).toBe(413);
    });
});
