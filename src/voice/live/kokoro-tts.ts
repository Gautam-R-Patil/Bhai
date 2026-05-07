// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Kokoro TTS client — spawns scripts/kokoro-worker.mjs in an isolated Node
// subprocess and talks to it over stdin/stdout. The worker loads
// @huggingface/transformers + onnxruntime-node 1.21, which must NOT share a
// process with the 1.14 binding that @xenova/transformers pulls in for
// embeddings (symbols collide → SIGBUS inside InferenceSession::Run).
//
// Wire format:
//   parent → worker  JSON line per request: { id, text, voice? }
//   worker → parent  8-byte header [id u32 BE][len u32 BE] then `len` bytes of
//                    payload. High bit of len is the error flag; low 31 bits
//                    are the payload length. Payload is 16-bit signed LE mono
//                    PCM at 24 kHz, or a UTF-8 error message when error flag set.

import { spawn, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

// Enabled by default now that Kokoro runs in an isolated subprocess. Opt-out
// via ATLAS_KOKORO_ENABLE=false for debugging the ONNX runtime conflict.
const ENABLED = process.env.ATLAS_KOKORO_ENABLE !== "false";
const VOICE = process.env.ATLAS_KOKORO_VOICE || "af_heart";
const MODEL_ID = process.env.ATLAS_KOKORO_MODEL || "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = process.env.ATLAS_KOKORO_DTYPE || "q8";

// Resolve a file that ships alongside the bot. In packaged electron-builder
// output, the bot bundle is at Contents/Resources/bot/bot-bundle.mjs, models
// at Contents/Resources/bot/models, scripts at Contents/Resources/bot/scripts.
// In dev, dist/voice/live/kokoro-tts.js is three segments deep under the repo
// root. Walk up candidate depths and return the first existing path.
function resolveBotAsset(relative: string[]): string | null {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const depth of [0, 1, 2, 3, 4]) {
        const up = Array(depth).fill("..");
        const candidate = join(here, ...up, ...relative);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

const CACHE_DIR = process.env.ATLAS_KOKORO_CACHE_DIR
    || resolveBotAsset(["models", "kokoro"])
    || join(homedir(), ".atlas", "models", "kokoro");

let worker: ChildProcess | null = null;
let ready = false;
let loadFailed = false;
let loadingPromise: Promise<boolean> | null = null;
let exitHookInstalled = false;

type Pending = { resolve: (pcm: Buffer) => void; reject: (err: Error) => void; };
const pending = new Map<number, Pending>();
let nextReqId = 1;

// Parsing state for the framed response stream.
let recvBuf = Buffer.alloc(0);
let recvId = -1;
let recvLen = -1;
let recvIsError = false;

function handleStdoutChunk(chunk: Buffer): void {
    recvBuf = Buffer.concat([recvBuf, chunk]);
    // eslint-disable-next-line no-constant-condition
    while (true) {
        if (recvLen < 0) {
            if (recvBuf.length < 8) return;
            recvId = recvBuf.readUInt32BE(0);
            const raw = recvBuf.readUInt32BE(4);
            recvIsError = (raw & 0x80000000) !== 0;
            recvLen = raw & 0x7FFFFFFF;
            recvBuf = recvBuf.subarray(8);
        }
        if (recvBuf.length < recvLen) return;
        const payload = recvBuf.subarray(0, recvLen);
        recvBuf = recvBuf.subarray(recvLen);
        if (recvIsError) {
            finalizePending(recvId, null, new Error(`Kokoro worker: ${payload.toString("utf8")}`));
        } else {
            finalizePending(recvId, Buffer.from(payload), null);
        }
        recvId = -1; recvLen = -1; recvIsError = false;
    }
}

function finalizePending(id: number, pcm: Buffer | null, err: Error | null): void {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (err) p.reject(err); else if (pcm) p.resolve(pcm);
}

function readyLineWatcher(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (!worker) { reject(new Error("worker not spawned")); return; }
        let buf = "";
        const onData = (chunk: Buffer) => {
            buf += chunk.toString("utf8");
            const idx = buf.indexOf("READY\n");
            if (idx >= 0) {
                // Stop line-based parsing; hand any remaining bytes to the
                // binary framer in case PCM somehow arrived early.
                worker?.stdout?.removeListener("data", onData);
                worker?.stdout?.on("data", handleStdoutChunk);
                const tail = Buffer.from(buf.slice(idx + "READY\n".length), "utf8");
                if (tail.length > 0) handleStdoutChunk(tail);
                resolve();
            }
        };
        worker.stdout?.on("data", onData);
        worker.once("exit", (code) => reject(new Error(`worker exited before ready (code=${code})`)));
    });
}

export function isKokoroReady(): boolean { return ready; }
export function hasKokoroFailed(): boolean { return loadFailed; }

export async function initKokoro(): Promise<boolean> {
    if (!ENABLED) { loadFailed = true; return false; }
    if (ready) return true;
    if (loadFailed) return false;
    if (loadingPromise) return loadingPromise;
    // Registering SIGINT/SIGTERM handlers here would preempt the bot's own
    // graceful shutdown (see src/index.ts). Only hook `exit` — fires after
    // the main shutdown path has already run, so it's a safe last-chance
    // cleanup for tsx --watch and similar hot-reload contexts.
    if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.once("exit", stopKokoro);
    }
    loadingPromise = (async () => {
        try {
            const scriptPath = resolveBotAsset(["scripts", "kokoro-worker.mjs"]);
            if (!scriptPath) throw new Error("kokoro-worker.mjs not found");
            console.log(`[KOKORO] Spawning worker: ${scriptPath} cache=${CACHE_DIR}`);
            worker = spawn(process.execPath, [scriptPath], {
                stdio: ["pipe", "pipe", "pipe"],
                env: {
                    ...process.env,
                    // In packaged electron-builder, process.execPath is the
                    // Electron binary. Force it to behave as plain Node so
                    // our worker script runs normally.
                    ELECTRON_RUN_AS_NODE: "1",
                    ATLAS_KOKORO_MODEL: MODEL_ID,
                    ATLAS_KOKORO_DTYPE: DTYPE,
                    ATLAS_KOKORO_VOICE: VOICE,
                    ATLAS_KOKORO_CACHE_DIR: CACHE_DIR,
                },
            });
            worker.stderr?.on("data", (c) => process.stderr.write(c));
            worker.on("exit", (code) => {
                console.warn(`[KOKORO] Worker exited (code=${code}), falling back to say`);
                loadFailed = true;
                ready = false;
                worker = null;
                // Reject all pending — caller will fall back to say.
                for (const p of pending.values()) p.reject(new Error("Kokoro worker exited"));
                pending.clear();
            });
            worker.on("error", (err) => {
                console.warn(`[KOKORO] Worker spawn error: ${err.message}`);
                loadFailed = true;
            });
            await readyLineWatcher();
            ready = true;
            console.log("[KOKORO] Worker ready");
            return true;
        } catch (err) {
            loadFailed = true;
            console.warn(`[KOKORO] Init failed: ${(err as Error).message}`);
            return false;
        } finally {
            loadingPromise = null;
        }
    })();
    return loadingPromise;
}

export function synthesize(text: string, voice: string = VOICE): Promise<Buffer> {
    if (!ready || !worker?.stdin) return Promise.reject(new Error("Kokoro worker not ready"));
    const id = nextReqId++;
    const promise = new Promise<Buffer>((resolve, reject) => {
        pending.set(id, { resolve, reject });
    });
    worker.stdin.write(JSON.stringify({ id, text, voice }) + "\n");
    return promise;
}

export function stopKokoro(): void {
    if (worker) {
        try { worker.kill("SIGTERM"); } catch { /* already dead */ }
        worker = null;
    }
    ready = false;
}
