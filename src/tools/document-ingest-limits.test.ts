// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// PDF ingest guards: inputs over 50MB, FIFOs and devices are refused before
// reading, and the parse runs in a child process that is killed at the
// deadline or when a decompression bomb blows past its memory cap. The bot
// (this test process) carries on and parses the next PDF.

import type { ChildProcess } from "node:child_process";
import { execFileSync, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const children: ChildProcess[] = [];
vi.mock("node:child_process", async (orig) => {
    const real = await orig<typeof import("node:child_process")>();
    return {
        ...real,
        fork: (...args: Parameters<typeof real.fork>) => {
            const c = real.fork(...args);
            children.push(c);
            return c;
        },
    };
});
let scriptOverride: string | null = null;
vi.mock("../config/paths.js", async (orig) => {
    const real = await orig<typeof import("../config/paths.js")>();
    return { ...real, resolveScript: (n: string) => scriptOverride ?? real.resolveScript(n) };
});
vi.mock("../documents/store.js", () => ({ saveDocument: (d: unknown) => d }));

const { ingestPdfToDocument } = await import("../documents/ingest.js");

// A one-page PDF whose content stream is `stream` (already Flate-compressed when `flate`).
function makePdf(stream: Buffer, flate = false): Buffer {
    const objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    ];
    const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
    const offs: number[] = [];
    let off = parts[0].length;
    const push = (b: Buffer) => {
        parts.push(b);
        off += b.length;
    };
    objs.forEach((o, i) => {
        offs.push(off);
        push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`));
    });
    offs.push(off);
    push(Buffer.from(`4 0 obj\n<< /Length ${stream.length}${flate ? " /Filter /FlateDecode" : ""} >>\nstream\n`));
    push(stream);
    push(Buffer.from("\nendstream\nendobj\n"));
    offs.push(off);
    push(Buffer.from("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"));
    const xref = `xref\n0 6\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    push(Buffer.from(`${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${off}\n%%EOF\n`));
    return Buffer.concat(parts);
}

let dir: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-limits-"));
    children.length = 0;
    scriptOverride = null;
});
afterEach(() => {
    delete process.env.ATLAS_PDF_PARSE_DEADLINE_MS;
    for (const c of children) c.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
});

const exited = (c: ChildProcess) =>
    c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise((r) => c.once("exit", r));

async function ingestHello(): Promise<string> {
    const file = path.join(dir, "hello.pdf");
    fs.writeFileSync(file, makePdf(Buffer.from("BT /F1 24 Tf 72 700 Td (Hello Ingest) Tj ET")));
    const { doc } = await ingestPdfToDocument(file, "generic");
    return JSON.stringify(doc);
}

// The decompression-bomb case kills the child via an RSS-poll watchdog; whether
// the poll catches the spike before parse completes is timing-sensitive and can
// miss once on a loaded Windows runner (killed.ok briefly true). Retry absorbs
// that race. If it fails ALL attempts on Windows, the cap is genuinely not
// enforced there — investigate rather than bumping retries.
describe("ingestPdfToDocument limits", { retry: 2 }, () => {
    it("reads a PDF's text in a child process", async () => {
        expect(await ingestHello()).toContain("Hello Ingest");
        expect(children).toHaveLength(1);
    });

    it("refuses a PDF over 50MB without parsing it", async () => {
        const file = path.join(dir, "big.pdf");
        fs.writeFileSync(file, "");
        fs.truncateSync(file, 50 * 1024 * 1024 + 1); // sparse, costs no disk
        await expect(ingestPdfToDocument(file, "resume")).rejects.toThrow(/too large .*limit is 50MB/);
        expect(children).toHaveLength(0);
    });

    it.skipIf(process.platform === "win32")("refuses a FIFO or a symlink to a device without reading it", async () => {
        const fifo = path.join(dir, "pipe.pdf");
        execFileSync("mkfifo", [fifo]);
        await expect(ingestPdfToDocument(fifo, "resume")).rejects.toThrow(/Not a regular file/);
        const dev = path.join(dir, "dev.pdf");
        fs.symlinkSync("/dev/null", dev);
        await expect(ingestPdfToDocument(dev, "resume")).rejects.toThrow(/Not a regular file/);
        expect(children).toHaveLength(0);
    });

    it("kills a parse that never ends at the deadline, and the next PDF still parses", async () => {
        scriptOverride = path.join(dir, "hang.cjs");
        fs.writeFileSync(scriptOverride, `process.once("message", () => { for (;;) {} });`);
        process.env.ATLAS_PDF_PARSE_DEADLINE_MS = "500";
        const file = path.join(dir, "slow.pdf");
        fs.writeFileSync(file, "%PDF-1.4\n");
        await expect(ingestPdfToDocument(file, "resume")).rejects.toThrow(/longer than 0.5s/);
        await exited(children[0]);
        // Windows has no POSIX signals: kill() sets .killed but signalCode stays null.
        expect(children[0].signalCode === "SIGKILL" || children[0].killed).toBe(true);

        scriptOverride = null;
        delete process.env.ATLAS_PDF_PARSE_DEADLINE_MS;
        expect(await ingestHello()).toContain("Hello Ingest");
    });

    it("an empty or non-numeric ATLAS_PDF_PARSE_DEADLINE_MS falls back to the default deadline", async () => {
        for (const v of ["", "abc", "60s", "0", "-5"]) {
            process.env.ATLAS_PDF_PARSE_DEADLINE_MS = v;
            expect(await ingestHello()).toContain("Hello Ingest");
        }
    });

    it("a long ordinary text PDF parses, page by page, within a small heap", async () => {
        // 1500 pages of text (~5.6M chars). Loading every page at once (unpdf's
        // extractText) ran a 128MB heap out of memory; the real cap is 512MB, and
        // 5000 such pages broke it the same way.
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const body = Array.from(
            { length: 50 },
            (_, i) => `${i} The quick brown fox jumps over the lazy dog 0123456789`,
        ).join("\n");
        for (let p = 0; p < 1500; p++)
            doc.addPage([612, 792]).drawText(body, { x: 20, y: 770, size: 9, font, lineHeight: 15 });
        const data = Buffer.from(await doc.save());

        const script = fileURLToPath(new URL("../../scripts/pdf-text.cjs", import.meta.url));
        const m = await new Promise<{ ok?: boolean; text?: string; signal?: string }>((resolve) => {
            const c = fork(script, [], {
                execArgv: ["--max-old-space-size=128"],
                serialization: "advanced",
                stdio: ["ignore", "ignore", "ignore", "ipc"],
            });
            c.once("message", (msg) => resolve(msg as { ok: boolean; text: string }));
            c.once("exit", (_code, signal) => resolve({ signal: String(signal) }));
            c.send({ data });
        });
        expect(m.ok).toBe(true);
        expect(m.text).toHaveLength(2_000_000);
        expect(m.text?.startsWith("0 The quick brown fox")).toBe(true);

        const file = path.join(dir, "long.pdf");
        fs.writeFileSync(file, data);
        expect(JSON.stringify((await ingestPdfToDocument(file, "generic")).doc)).toContain("The quick brown fox");
    }, 60_000);

    it("a decompression bomb dies in the child, at the deadline or its memory cap; the next PDF still parses", async () => {
        // ~1.4MB on disk, 300MB of spaces once pdf.js inflates the content stream
        // (a real bomb is just bigger: pdf.js inflates in JS at tens of MB/s).
        const deflate = zlib.createDeflate({ level: 1 });
        const out: Buffer[] = [];
        deflate.on("data", (c: Buffer) => out.push(c));
        const block = Buffer.alloc(1024 * 1024, 0x20);
        for (let i = 0; i < 300; i++) deflate.write(block);
        deflate.end();
        await new Promise((r) => deflate.on("end", r));
        const bomb = makePdf(Buffer.concat(out), true);
        const file = path.join(dir, "bomb.pdf");
        fs.writeFileSync(file, bomb);

        process.env.ATLAS_PDF_PARSE_DEADLINE_MS = "1000";
        await expect(ingestPdfToDocument(file, "resume")).rejects.toThrow(/longer than 1s/);
        await exited(children[0]);
        // Windows has no POSIX signals: kill() sets .killed but signalCode stays null.
        expect(children[0].signalCode === "SIGKILL" || children[0].killed).toBe(true);
        delete process.env.ATLAS_PDF_PARSE_DEADLINE_MS;

        // The child's own watchdog (here capped at 250MB) kills it with no deadline at all,
        // while a normal PDF stays well under the same cap.
        const script = fileURLToPath(new URL("../../scripts/pdf-text.cjs", import.meta.url));
        const parse = (data: Buffer) =>
            new Promise<unknown>((resolve) => {
                const c = fork(script, ["250000000"], {
                    serialization: "advanced",
                    stdio: ["ignore", "ignore", "ignore", "ipc"],
                });
                c.once("message", (m) => resolve(m));
                c.once("exit", (_code, signal) => resolve({ signal }));
                c.send({ data });
            });
        const killed = (await parse(bomb)) as { ok?: boolean; signal?: string | null };
        expect(killed.ok).not.toBe(true); // the bomb was killed, not parsed
        expect(killed.signal === "SIGKILL" || killed.signal == null).toBe(true); // null on Windows
        const hello = makePdf(Buffer.from("BT /F1 24 Tf 72 700 Td (Hello Ingest) Tj ET"));
        expect(await parse(hello)).toMatchObject({ ok: true, text: expect.stringContaining("Hello Ingest") });

        expect(await ingestHello()).toContain("Hello Ingest");
    });
});
