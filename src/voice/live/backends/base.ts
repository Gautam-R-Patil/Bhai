// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Live Voice Backend — Abstract Base ───────────

import { EventEmitter } from "node:events";
import type { AudioChunk, LiveBackendEvents, LiveSessionConfig, LiveToolCall, LiveToolResult } from "../types.js";

export abstract class LiveVoiceBackend extends EventEmitter {
    protected _connected = false;

    /** Connect to the real-time voice service */
    abstract connect(config: LiveSessionConfig): Promise<void>;

    /** Disconnect and clean up */
    abstract disconnect(): Promise<void>;

    /** Send a chunk of raw PCM audio to the model */
    abstract sendAudio(pcm: Buffer): void;

    /** Interrupt the current model response (user started speaking) */
    abstract interrupt(): void;

    /** Send tool execution results back to the model */
    abstract sendToolResponse(results: LiveToolResult[]): void;

    /** Send a text message (for hybrid backend or text injection) */
    abstract sendText(text: string): void;

    /** Check connection status */
    isConnected(): boolean {
        return this._connected;
    }

    // ── Typed event emitter helpers ──────────────

    override on<K extends keyof LiveBackendEvents>(
        event: K,
        listener: LiveBackendEvents[K]
    ): this {
        return super.on(event, listener as (...args: unknown[]) => void);
    }

    override emit<K extends keyof LiveBackendEvents>(
        event: K,
        ...args: Parameters<LiveBackendEvents[K]>
    ): boolean {
        return super.emit(event, ...args);
    }

    override off<K extends keyof LiveBackendEvents>(
        event: K,
        listener: LiveBackendEvents[K]
    ): this {
        return super.off(event, listener as (...args: unknown[]) => void);
    }
}
