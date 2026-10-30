// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDocumentOpen } from "./lsp.js";

describe("lsp ensureDocumentOpen", () => {
    it("sends didChange with the new text after the file changes on disk", async () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bhai-lsp-")), "a.ts");
        fs.writeFileSync(file, "const a = 1;\n");
        const sent: string[] = [];
        const session = {
            language: "typescript",
            dead: false,
            child: { stdin: { write: (s: string) => sent.push(s.slice(s.indexOf("{"))) } },
            openDocs: new Map(),
            diagnostics: new Map(),
        } as unknown as Parameters<typeof ensureDocumentOpen>[0];
        const methods = () => sent.map((m) => JSON.parse(m).method);

        const uri = await ensureDocumentOpen(session, file);
        await ensureDocumentOpen(session, file); // unchanged: nothing sent
        expect(methods()).toEqual(["textDocument/didOpen"]);

        session.diagnostics.set(uri, []);
        fs.writeFileSync(file, "const a: string = 1;\n");
        fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
        await ensureDocumentOpen(session, file);
        const change = JSON.parse(sent[1]);
        expect(change.method).toBe("textDocument/didChange");
        expect(change.params).toEqual({
            textDocument: { uri, version: 2 },
            contentChanges: [{ text: "const a: string = 1;\n" }],
        });
        expect(session.diagnostics.has(uri)).toBe(false); // getDiagnostics waits for the fresh publish
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
    });
});
