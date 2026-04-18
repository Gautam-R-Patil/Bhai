// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Microphone Capture — sox/rec → raw PCM stream ──

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { ensureSox } from "./dep-check.js";

export interface MicCaptureEvents {
    "data": (pcm: Buffer) => void;
    "error": (err: Error) => void;
    "started": () => void;
    "stopped": () => void;
}

export class MicCapture extends EventEmitter {
    private process: ChildProcess | null = null;
    private _active = false;
    private sampleRate: number;
    private chunkSize: number;

    /**
     * @param sampleRate - Sample rate in Hz (default 16000 for Gemini/OpenAI)
     * @param chunkIntervalMs - How often to emit audio chunks (default 100ms)
     */
    constructor(sampleRate = 16000, chunkIntervalMs = 100) {
        super();
        this.sampleRate = sampleRate;
        // bytes per chunk = sampleRate * 2 (16-bit) * 1 (mono) * (interval/1000)
        this.chunkSize = Math.floor(sampleRate * 2 * (chunkIntervalMs / 1000));
    }

    get active(): boolean {
        return this._active;
    }

    /**
     * Start capturing audio from the default microphone.
     * Auto-installs sox if missing, then uses `rec` → raw PCM to stdout.
     */
    async start(): Promise<void> {
        if (this._active) return;

        // Auto-install sox if not present
        const hasSox = await ensureSox();
        if (!hasSox) {
            this.emit("error", new Error("sox is required for mic capture but could not be installed automatically."));
            return;
        }

        // sox `rec` records at the device's native rate (usually 44100Hz)
        // then resamples to the target rate via the `rate` effect in the output pipe.
        // We do NOT set -r on rec (that just sets the output label, not actual resampling).
        // Instead: rec at native rate → pipe through sox to resample → raw PCM output.
        this.process = spawn("sox", [
            "-q",                    // quiet
            "-d",                    // default audio device (input)
            "-t", "raw",             // output format: raw PCM
            "-b", "16",              // 16-bit
            "-e", "signed-integer",
            "-r", String(this.sampleRate), // output sample rate
            "-c", "1",              // mono
            "-",                     // output to stdout
        ], {
            stdio: ["ignore", "pipe", "pipe"],
        });

        this._active = true;
        let buffer = Buffer.alloc(0);

        this.process.stdout!.on("data", (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);

            // Emit chunks of the configured size
            while (buffer.length >= this.chunkSize) {
                const pcmChunk = buffer.subarray(0, this.chunkSize);
                buffer = buffer.subarray(this.chunkSize);
                this.emit("data", pcmChunk);
            }
        });

        this.process.stderr!.on("data", (data: Buffer) => {
            const msg = data.toString().trim();
            if (!msg) return;
            // sox/rec writes warnings and info to stderr — only treat as error if it's
            // a genuine failure (exit code handles that), not sample rate negotiation etc.
            if (msg.includes("FAIL") || msg.includes("error:")) {
                this.emit("error", new Error(`rec: ${msg}`));
            } else {
                // Log but don't emit as error (sample rate warnings, format info, etc.)
                console.log(`[MIC] sox info: ${msg}`);
            }
        });

        this.process.on("error", async (err) => {
            this._active = false;
            // Try auto-installing sox and retrying once
            console.warn("[MIC] rec command failed, attempting self-heal...");
            const fixed = await ensureSox();
            if (fixed) {
                console.log("[MIC] sox recovered — retrying mic capture");
                this.start();
            } else {
                this.emit("error", new Error(`Microphone capture failed and self-heal unsuccessful: ${err.message}`));
            }
        });

        this.process.on("close", (code) => {
            this._active = false;
            // Flush remaining buffer
            if (buffer.length > 0) {
                this.emit("data", buffer);
                buffer = Buffer.alloc(0);
            }
            this.emit("stopped");
        });

        this.emit("started");
        console.log(`[MIC] Capturing at ${this.sampleRate}Hz 16-bit mono PCM`);
    }

    /** Stop capturing */
    stop(): void {
        if (!this._active || !this.process) return;
        this._active = false;

        try {
            this.process.kill("SIGTERM");
        } catch { /* already dead */ }

        this.process = null;
    }

    // ── Typed emitter helpers ──

    override on<K extends keyof MicCaptureEvents>(event: K, listener: MicCaptureEvents[K]): this {
        return super.on(event, listener as (...args: unknown[]) => void);
    }
    override emit<K extends keyof MicCaptureEvents>(event: K, ...args: Parameters<MicCaptureEvents[K]>): boolean {
        return super.emit(event, ...args);
    }
}
