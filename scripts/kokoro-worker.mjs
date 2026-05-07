// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Kokoro TTS worker — loads the 82M ONNX model in an isolated Node process
// so its onnxruntime-node 1.21 binding doesn't collide with the 1.14 the
// main ATLAS process has already loaded via @xenova/transformers.
//
// Protocol (line-delimited on stdin/stdout):
//   parent → worker:  one JSON object per line. `{ id, text, voice? }`
//   worker → parent:  binary frames prefixed with 8-byte big-endian header:
//                     [4 bytes id u32] [4 bytes len u32] [len bytes payload]
//                     High bit of len is the error flag; payload is UTF-8
//                     error text when set, 16-bit mono PCM @ 24 kHz otherwise.
//   worker → parent stderr: human-readable log lines. Never written to stdout.
//
// Env inputs:
//   ATLAS_KOKORO_MODEL      HF model id (default onnx-community/Kokoro-82M-v1.0-ONNX)
//   ATLAS_KOKORO_DTYPE      fp32 | fp16 | q8 | q4 | q4f16 (default q8)
//   ATLAS_KOKORO_VOICE      default voice name (default af_heart)
//   ATLAS_KOKORO_CACHE_DIR  transformers.js cache root

import readline from "node:readline";

const MODEL_ID = process.env.ATLAS_KOKORO_MODEL || "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE    = process.env.ATLAS_KOKORO_DTYPE || "q8";
const VOICE    = process.env.ATLAS_KOKORO_VOICE || "af_heart";
const CACHE    = process.env.ATLAS_KOKORO_CACHE_DIR;

function log(msg) { process.stderr.write(`[KOKORO-WORKER] ${msg}\n`); }

async function loadModel() {
    const { env } = await import("@huggingface/transformers");
    if (CACHE) env.cacheDir = CACHE;
    const { KokoroTTS } = await import("kokoro-js");
    log(`loading ${MODEL_ID} (dtype=${DTYPE}) cache=${CACHE || "<default>"}`);
    const t0 = Date.now();
    const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: DTYPE, device: "cpu" });
    log(`ready in ${Date.now() - t0}ms`);
    return tts;
}

function float32ToPcm16(f32) {
    const buf = Buffer.alloc(f32.length * 2);
    for (let i = 0; i < f32.length; i++) {
        let s = f32[i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        buf.writeInt16LE(Math.round(s * 32767), i * 2);
    }
    return buf;
}

function writeFrame(id, payload, isError = false) {
    // Pack length + error flag into one u32: high bit = error, low 31 bits = len.
    // Single contiguous write so the header and payload never split across
    // stdout chunks at the byte level.
    const header = Buffer.alloc(8);
    header.writeUInt32BE(id, 0);
    const lenField = isError ? (payload.length | 0x80000000) >>> 0 : payload.length;
    header.writeUInt32BE(lenField, 4);
    process.stdout.write(Buffer.concat([header, payload]));
}

async function main() {
    let tts;
    try {
        tts = await loadModel();
    } catch (err) {
        log(`load failed: ${err?.message || err}`);
        process.exit(1);
    }
    // Signal readiness once the model is loaded.
    process.stdout.write("READY\n");

    const rl = readline.createInterface({ input: process.stdin });
    // Serialize synthesis — Kokoro's inner session is single-threaded anyway
    // and queueing avoids two overlapping tts.generate calls competing for
    // the same CPU tensor buffers.
    let queue = Promise.resolve();
    rl.on("line", (line) => {
        let req;
        try { req = JSON.parse(line); } catch {
            log(`bad request line: ${line.slice(0, 80)}`);
            return;
        }
        const { id, text, voice } = req;
        queue = queue.then(async () => {
            try {
                const audio = await tts.generate(text, { voice: voice || VOICE });
                writeFrame(id, float32ToPcm16(audio.audio));
            } catch (err) {
                const msg = err?.message || String(err);
                writeFrame(id, Buffer.from(msg, "utf8"), true);
                log(`synth id=${id} failed: ${msg}`);
            }
        });
    });
    rl.on("close", () => { log("stdin closed — exiting"); process.exit(0); });
}

main().catch(err => { log(`fatal: ${err?.message || err}`); process.exit(1); });
