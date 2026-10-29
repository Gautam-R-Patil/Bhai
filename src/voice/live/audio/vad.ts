// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Voice Activity Detection — Energy-based VAD for hybrid backend ──

import { EventEmitter } from "node:events";

export interface VADEvents {
    "speech_start": () => void;
    "speech_end": () => void;
}

export interface VADConfig {
    /** RMS threshold for speech detection (0-1). Default 0.01 */
    threshold: number;
    /** Number of consecutive silent frames before speech_end. Default 8 (~800ms at 100ms chunks) */
    silenceFrames: number;
    /** Number of consecutive speech frames before speech_start. Default 2 (~200ms) */
    speechFrames: number;
}

const DEFAULT_VAD_CONFIG: VADConfig = {
    threshold: 0.01,
    silenceFrames: 8,
    speechFrames: 2,
};

export class EnergyVAD extends EventEmitter {
    private config: VADConfig;
    private isSpeaking = false;
    private silentCount = 0;
    private speechCount = 0;

    constructor(config: Partial<VADConfig> = {}) {
        super();
        this.config = { ...DEFAULT_VAD_CONFIG, ...config };
    }

    /**
     * Process a chunk of 16-bit signed PCM audio.
     * Computes RMS energy and emits speech_start/speech_end events.
     */
    process(pcm: Buffer): boolean {
        const rms = computeRMS(pcm);
        const active = rms > this.config.threshold;

        if (active) {
            this.silentCount = 0;
            this.speechCount++;

            if (!this.isSpeaking && this.speechCount >= this.config.speechFrames) {
                this.isSpeaking = true;
                this.emit("speech_start");
            }
        } else {
            this.speechCount = 0;
            this.silentCount++;

            if (this.isSpeaking && this.silentCount >= this.config.silenceFrames) {
                this.isSpeaking = false;
                this.emit("speech_end");
            }
        }

        return this.isSpeaking;
    }

    reset(): void {
        this.isSpeaking = false;
        this.silentCount = 0;
        this.speechCount = 0;
    }

    // ── Typed emitter helpers ──

    override on<K extends keyof VADEvents>(event: K, listener: VADEvents[K]): this {
        return super.on(event, listener as (...args: unknown[]) => void);
    }
    override emit<K extends keyof VADEvents>(event: K, ...args: Parameters<VADEvents[K]>): boolean {
        return super.emit(event, ...args);
    }
}

/** Compute RMS (Root Mean Square) energy of 16-bit signed PCM buffer */
function computeRMS(pcm: Buffer): number {
    const samples = pcm.length / 2; // 16-bit = 2 bytes per sample
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < pcm.length; i += 2) {
        const sample = pcm.readInt16LE(i) / 32768; // Normalize to [-1, 1]
        sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
}
