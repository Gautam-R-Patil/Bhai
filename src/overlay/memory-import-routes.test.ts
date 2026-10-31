// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("../memory/memory-import.js", () => ({
    MEMORY_EXPORT_PROMPT: "PROMPT",
    MEMORY_IMPORT_SOURCES: [{ id: "chatgpt", label: "ChatGPT", hint: "h" }],
    extractMemoryFacts: vi.fn(async () => ({ facts: [], chunks: 1 })),
    estimateImport: vi.fn(() => ({ chunks: 4, credits: 4, kind: "text", truncated: false, incomplete: false })),
    saveImportedFacts: vi.fn(async () => ({ added: 0, duplicates: 0, rejected: 0, ids: [] })),
}));
vi.mock("../tools/import-memory.js", () => ({ readImportFile: vi.fn() }));
const recall = vi.fn(async () => [{ id: 7 }, { id: 3 }]);
vi.mock("../memory/sqlite.js", () => ({ recall }));
vi.mock("../memory/forget.js", () => ({
    undoImportBatch: vi.fn((b: string) => (b.startsWith("import:") ? { forgotten: 3 } : { error: "Not an import batch." })),
}));

const { handleMemoryImportRoute } = await import("./memory-import-routes.js");
const mi = await import("../memory/memory-import.js");

class FakeRes extends EventEmitter {
    status = 0;
    out = "";
    writableEnded = false;
    get headersSent() {
        return this.status !== 0;
    }
    writeHead(s: number) {
        this.status = s;
    }
    end(b: string) {
        this.out = b;
        this.writableEnded = true;
    }
}

function call(
    method: string,
    pathname: string,
    scope: "native-overlay" | "web-widget" | null,
    body = "",
    res = new FakeRes(),
) {
    const req = Object.assign(new PassThrough(), { method, headers: {} }) as unknown as IncomingMessage;
    (req as unknown as PassThrough).end(body);
    return handleMemoryImportRoute(req, res as unknown as ServerResponse, pathname, scope, null).then(() => ({
        status: res.status,
        body: JSON.parse(res.out),
    }));
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

    it("estimates parts and credits for the owner only, with the preview's checks", async () => {
        const body = '{"text":"[unknown] - Lives in Pune","source":"gemini"}';
        expect((await call("POST", "/api/memory/import/estimate", "web-widget", body)).status).toBe(403);
        expect(await call("POST", "/api/memory/import/estimate", "native-overlay", body)).toEqual({
            status: 200,
            body: { chunks: 4, credits: 4, kind: "text", truncated: false, incomplete: false },
        });
        expect(mi.estimateImport).toHaveBeenCalledWith("[unknown] - Lives in Pune", undefined);
        expect(mi.extractMemoryFacts).not.toHaveBeenCalled();
        expect((await call("POST", "/api/memory/import/estimate", "native-overlay", '{"path":"rel.json"}')).status).toBe(400);
        expect((await call("POST", "/api/memory/import/estimate", "native-overlay", '{"text":" "}')).status).toBe(400);
    });

    it("preview: the client going away aborts the extraction; a normal answer doesn't", async () => {
        let finish = () => {};
        let signal: AbortSignal | undefined;
        vi.mocked(mi.extractMemoryFacts).mockImplementationOnce(async (o) => {
            signal = o.signal;
            await new Promise<void>((r) => {
                finish = r;
            });
            return { facts: [], chunks: 1 } as never;
        });
        const res = new FakeRes();
        const done = call("POST", "/api/memory/import/preview", "native-overlay", '{"text":"Lives in Pune"}', res);
        await vi.waitFor(() => expect(signal).toBeDefined());
        expect(signal?.aborted).toBe(false);
        res.emit("close");
        expect(signal?.aborted).toBe(true);
        finish();
        await done;

        const ok = new FakeRes();
        await call("POST", "/api/memory/import/preview", "native-overlay", '{"text":"Lives in Pune"}', ok);
        ok.emit("close");
        expect(vi.mocked(mi.extractMemoryFacts).mock.lastCall?.[0].signal?.aborted).toBe(false);
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
