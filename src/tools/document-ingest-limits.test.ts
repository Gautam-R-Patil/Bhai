// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// PDF ingest guards: inputs over 50MB are refused before parsing, and a parse
// that never finishes is abandoned at the 60s deadline.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getDocumentProxy = vi.fn();
vi.mock("unpdf", () => ({ getDocumentProxy, extractText: vi.fn() }));

const { ingestPdfToDocument } = await import("../documents/ingest.js");

let dir: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-limits-"));
    getDocumentProxy.mockReset();
});
afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("ingestPdfToDocument limits", () => {
    it("refuses a PDF over 50MB without parsing it", async () => {
        const file = path.join(dir, "big.pdf");
        fs.writeFileSync(file, "");
        fs.truncateSync(file, 50 * 1024 * 1024 + 1); // sparse, costs no disk
        await expect(ingestPdfToDocument(file, "resume")).rejects.toThrow(/too large .*limit is 50MB/);
        expect(getDocumentProxy).not.toHaveBeenCalled();
    });

    it("gives up when parsing exceeds the deadline", async () => {
        const file = path.join(dir, "slow.pdf");
        fs.writeFileSync(file, "%PDF-1.4\n");
        getDocumentProxy.mockReturnValue(new Promise(() => {})); // pathological PDF: never finishes
        vi.useFakeTimers();
        const result = expect(ingestPdfToDocument(file, "resume")).rejects.toThrow(/longer than 60s/);
        await vi.advanceTimersByTimeAsync(60_000);
        await result;
    });
});
