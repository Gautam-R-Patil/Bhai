// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Local Kokoro 82M ONNX TTS. First `initKokoro()` call downloads ~96 MB into
// ATLAS_KOKORO_CACHE_DIR; subsequent calls load from disk. Output is 24 kHz
// 16-bit mono PCM — same format as Gemini Live, so it drops into AudioPlayer.

import { join } from "node:path";
import { homedir } from "node:os";

const VOICE = process.env.ATLAS_KOKORO_VOICE || "af_heart";
const MODEL_ID = process.env.ATLAS_KOKORO_MODEL || "onnx-community/Kokoro-82M-v1.0-ONNX";
// q8 is the sweet spot: ~96 MB, CPU-fast, near-indistinguishable from fp32.
const DTYPE = (process.env.ATLAS_KOKORO_DTYPE || "q8") as "fp32" | "fp16" | "q8" | "q4" | "q4f16";
const CACHE_DIR = process.env.ATLAS_KOKORO_CACHE_DIR || join(homedir(), ".atlas", "models", "kokoro");

type KokoroInstance = { generate(text: string, opts: { voice: string }): Promise<{ audio: Float32Array; sampling_rate: number }> };

let instance: KokoroInstance | null = null;
let loading: Promise<KokoroInstance | null> | null = null;
let loadFailed = false;

export function isKokoroReady(): boolean {
    return instance !== null;
}

export function hasKokoroFailed(): boolean {
    return loadFailed;
}

// Kick off the model download + load. Safe to call repeatedly — concurrent
// callers share the same in-flight promise. Permanently latches `loadFailed`
// on any error so we don't retry a broken install in a hot loop.
export async function initKokoro(): Promise<KokoroInstance | null> {
    if (instance) return instance;
    if (loadFailed) return null;
    if (loading) return loading;
    loading = (async () => {
        try {
            // transformers.js defaults its cache inside node_modules, which is
            // read-only in the packaged Electron .app. Redirect to a writable
            // user-scoped dir before importing kokoro-js.
            const { env } = await import("@huggingface/transformers");
            env.cacheDir = CACHE_DIR;
            const { KokoroTTS } = await import("kokoro-js");
            console.log(`[KOKORO] Loading ${MODEL_ID} (dtype=${DTYPE}) → ${CACHE_DIR}`);
            const t0 = Date.now();
            const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: DTYPE, device: "cpu" }) as unknown as KokoroInstance;
            instance = tts;
            console.log(`[KOKORO] Ready in ${Date.now() - t0}ms`);
            return tts;
        } catch (err) {
            loadFailed = true;
            console.warn("[KOKORO] Load failed, staying on `say` fallback:", (err as Error).message);
            return null;
        } finally {
            loading = null;
        }
    })();
    return loading;
}

export async function synthesize(text: string, voice: string = VOICE): Promise<Buffer> {
    const tts = instance ?? await initKokoro();
    if (!tts) throw new Error("Kokoro not available");
    const audio = await tts.generate(text, { voice });
    return float32ToPcm16(audio.audio);
}

function float32ToPcm16(f32: Float32Array): Buffer {
    const buf = Buffer.alloc(f32.length * 2);
    for (let i = 0; i < f32.length; i++) {
        let s = f32[i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        buf.writeInt16LE(Math.round(s * 32767), i * 2);
    }
    return buf;
}
