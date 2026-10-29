// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// Extracts a PDF's text in its own process (src/documents/ingest.ts forks it per
// parse, with a 512MB heap and a deadline after which it is killed). pdf.js
// keeps decoded streams in ArrayBuffers, outside that heap, so a 1.5MB
// decompression bomb would still reach gigabytes: a watchdog thread kills this
// process once its RSS passes 1GB. A bomb, a hang or a crash ends this process,
// never the bot. One message in ({data}), one out ({ok, text} or {ok, error}).
"use strict";
// unpdf's pdf.js uses Promise.try, which only exists on Node >= 22.13 / 24+.
// On the project's supported Node 20-22.12 it throws "Promise.try is not a
// function" and PDF parsing crashes. Polyfill it before unpdf loads.
if (typeof Promise.try !== "function") {
    Promise.try = function (fn, ...args) {
        return new Promise((resolve) => resolve(fn(...args)));
    };
}
const { Worker } = require("node:worker_threads");

const MAX_RSS = Number(process.argv[2]) || 1024 * 1024 * 1024; // argv only from tests; the bot passes none
const MAX_TEXT = 2_000_000; // chars sent back: a bomb's "text" must not flood the bot either

// Its own thread, so it still runs while pdf.js decodes a stream synchronously.
// Use process.memoryUsage().rss (always present in a worker on every Node
// version) — the process.memoryUsage.rss() fast-path isn't defined in a worker
// thread on Node 22, so it threw and crashed the parse. If the watchdog can't
// start, parse anyway; the parent's deadline still bounds a runaway.
try {
    new Worker(
        `const rss = () => process.memoryUsage().rss;\n` +
            `setInterval(() => { try { if (rss() > ${MAX_RSS}) process.kill(process.pid, "SIGKILL"); } catch {} }, 50);`,
        { eval: true },
    ).unref();
} catch {
    /* no watchdog — the parent deadline still protects */
}

process.once("message", async (m) => {
    try {
        const { getDocumentProxy } = await import("unpdf");
        const pdf = await getDocumentProxy(new Uint8Array(m.data));
        // One page at a time, stopping at MAX_TEXT: unpdf's extractText loads every
        // page at once, so a long ordinary PDF (5000 text pages) outgrew the heap.
        // Same output as extractText({mergePages: true}): pages joined, whitespace collapsed.
        let text = "";
        for (let i = 1; i <= pdf.numPages && text.length < MAX_TEXT; i++) {
            const page = await pdf.getPage(i);
            const { items } = await page.getTextContent();
            const pageText = items
                .filter((it) => it.str != null)
                .map((it) => it.str + (it.hasEOL ? "\n" : ""))
                .join("");
            text += (i > 1 ? " " : "") + pageText.replace(/\s+/g, " ");
            page.cleanup();
        }
        process.send({ ok: true, text: text.replace(/\s+/g, " ").slice(0, MAX_TEXT) });
    } catch (e) {
        process.send({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
    }
});
