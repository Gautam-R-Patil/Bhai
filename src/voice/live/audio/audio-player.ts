// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Audio Player — raw PCM → sox play / afplay ───

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { ensureSox } from "./dep-check.js";

export interface AudioPlayerEvents {
    "started": () => void;
    "stopped": () => void;
    "flushed": () => void;
    "error": (err: Error) => void;
}

export class AudioPlayer extends EventEmitter {
    private process: ChildProcess | null = null;
    private _playing = false;
    private sampleRate: number;
    private pendingChunks: Buffer[] = [];

    /**
     * @param sampleRate - Sample rate of incoming PCM (default 24000 for Gemini output)
     */
    constructor(sampleRate = 24000) {
        super();
        this.sampleRate = sampleRate;
    }

    get playing(): boolean {
        return this._playing;
    }

    /**
     * Ensure the playback process is running.
     * Uses sox `play` command reading raw 16-bit signed LE mono PCM from stdin.
     */
    private ensureProcess(): void {
        if (this.process && this._playing) return;

        // sox `play` reads raw PCM from stdin
        this.process = spawn("play", [
            "-q",              // quiet
            "-t", "raw",       // raw PCM input
            "-b", "16",        // 16-bit
            "-e", "signed-integer",
            "-c", "1",         // mono
            "-r", String(this.sampleRate),
            "-",               // read from stdin
        ], {
            stdio: ["pipe", "ignore", "pipe"],
        });

        this._playing = true;

        this.process.stderr!.on("data", (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg && !msg.includes("sox WARN")) {
                this.emit("error", new Error(`play stderr: ${msg}`));
            }
        });

        this.process.on("error", async (err) => {
            this._playing = false;
            console.warn("[PLAYER] play command failed, attempting self-heal...");
            const fixed = await ensureSox();
            if (fixed) {
                console.log("[PLAYER] sox recovered — playback will resume on next chunk");
            } else {
                this.emit("error", new Error(`Audio playback failed and self-heal unsuccessful: ${err.message}`));
            }
        });

        this.process.on("close", () => {
            this._playing = false;
            this.emit("stopped");
        });

        this.emit("started");
    }

    /**
     * Write a chunk of PCM audio to the player.
     * Starts the player process on first chunk.
     */
    write(pcm: Buffer): void {
        this.ensureProcess();
        if (this.process?.stdin?.writable) {
            this.process.stdin.write(pcm);
        }
    }

    /**
     * Flush / interrupt — kill the current playback process immediately.
     * Used when the user starts speaking (interruption).
     * A new process will be spawned on the next write().
     */
    flush(): void {
        if (!this.process) return;

        try {
            this.process.stdin?.end();
            this.process.kill("SIGKILL"); // Hard kill for instant silence
        } catch { /* already dead */ }

        this.process = null;
        this._playing = false;
        this.emit("flushed");
    }

    /**
     * End the current audio stream gracefully (let remaining buffer play out).
     */
    end(): void {
        if (!this.process) return;
        try {
            this.process.stdin?.end();
        } catch { /* */ }
        // Process will close naturally after draining
    }

    /** Full stop — kill and clean up */
    stop(): void {
        this.flush();
    }

    // ── Typed emitter helpers ──

    override on<K extends keyof AudioPlayerEvents>(event: K, listener: AudioPlayerEvents[K]): this {
        return super.on(event, listener as (...args: unknown[]) => void);
    }
    override emit<K extends keyof AudioPlayerEvents>(event: K, ...args: Parameters<AudioPlayerEvents[K]>): boolean {
        return super.emit(event, ...args);
    }
}
