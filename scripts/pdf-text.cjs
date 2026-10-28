// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Extracts a PDF's text in its own process (src/documents/ingest.ts forks it per
// parse, with a 512MB heap and a deadline after which it is killed). pdf.js
// keeps decoded streams in ArrayBuffers, outside that heap, so a 1.5MB
// decompression bomb would still reach gigabytes: a watchdog thread kills this
// process once its RSS passes 1GB. A bomb, a hang or a crash ends this process,
// never the bot. One message in ({data}), one out ({ok, text} or {ok, error}).
"use strict";
const { Worker } = require("node:worker_threads");

const MAX_RSS = Number(process.argv[2]) || 1024 * 1024 * 1024; // argv only from tests; the bot passes none
const MAX_TEXT = 2_000_000; // chars sent back: a bomb's "text" must not flood the bot either

// Its own thread, so it still runs while pdf.js decodes a stream synchronously.
new Worker(
    `setInterval(() => { if (process.memoryUsage.rss() > ${MAX_RSS}) process.kill(process.pid, "SIGKILL"); }, 50);`,
    { eval: true },
).unref();

process.once("message", async (m) => {
    try {
        const { extractText, getDocumentProxy } = await import("unpdf");
        const pdf = await getDocumentProxy(new Uint8Array(m.data));
        const { text } = await extractText(pdf, { mergePages: true });
        process.send({
            ok: true,
            text: (Array.isArray(text) ? text.join("\n") : String(text ?? "")).slice(0, MAX_TEXT),
        });
    } catch (e) {
        process.send({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
    }
});
