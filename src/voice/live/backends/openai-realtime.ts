// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── OpenAI Realtime Backend — WebSocket speech-to-speech ──

import WebSocket from "ws";
import { LiveVoiceBackend } from "./base.js";
import type { LiveSessionConfig, LiveToolCall, LiveToolResult } from "../types.js";
import { getVoiceToolSchemas } from "../tool-bridge.js";

const REALTIME_URL = "wss://api.openai.com/v1/realtime";
const MODEL = "gpt-4o-realtime-preview";

export class OpenAIRealtimeBackend extends LiveVoiceBackend {
    private apiKey: string;
    private ws: WebSocket | null = null;

    constructor(apiKey: string) {
        super();
        this.apiKey = apiKey;
    }

    async connect(config: LiveSessionConfig): Promise<void> {
        if (this._connected) return;

        console.log(`[OPENAI-RT] Connecting to ${MODEL}...`);

        return new Promise<void>((resolve, reject) => {
            this.ws = new WebSocket(`${REALTIME_URL}?model=${MODEL}`, {
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "OpenAI-Beta": "realtime=v1",
                },
            });

            const timeout = setTimeout(() => {
                reject(new Error("OpenAI Realtime connection timeout (10s)"));
                this.ws?.close();
            }, 10000);

            this.ws.on("open", () => {
                clearTimeout(timeout);
                console.log("[OPENAI-RT] WebSocket connected");
                this._connected = true;

                // Send session configuration
                this.sendSessionUpdate(config);

                this.emit("connected");
                resolve();
            });

            this.ws.on("message", (data) => {
                try {
                    const event = JSON.parse(data.toString());
                    this.handleEvent(event);
                } catch (err) {
                    console.error("[OPENAI-RT] Message parse error:", err);
                }
            });

            this.ws.on("error", (err) => {
                clearTimeout(timeout);
                console.error("[OPENAI-RT] WebSocket error:", err.message);
                this.emit("error", err);
                if (!this._connected) reject(err);
            });

            this.ws.on("close", (code, reason) => {
                console.log(`[OPENAI-RT] WebSocket closed: ${code} ${reason.toString()}`);
                this._connected = false;
                this.emit("disconnected");
            });
        });
    }

    async disconnect(): Promise<void> {
        if (this.ws) {
            try { this.ws.close(); } catch { /* */ }
            this.ws = null;
        }
        this._connected = false;
    }

    sendAudio(pcm: Buffer): void {
        if (!this.ws || !this._connected) return;

        // OpenAI expects base64-encoded PCM in input_audio_buffer.append
        this.send({
            type: "input_audio_buffer.append",
            audio: pcm.toString("base64"),
        });
    }

    interrupt(): void {
        if (!this.ws || !this._connected) return;

        // Cancel current response generation
        this.send({ type: "response.cancel" });
    }

    sendToolResponse(results: LiveToolResult[]): void {
        if (!this.ws || !this._connected) return;

        // Send each tool result
        for (const result of results) {
            this.send({
                type: "conversation.item.create",
                item: {
                    type: "function_call_output",
                    call_id: result.id,
                    output: typeof result.result === "string"
                        ? result.result
                        : JSON.stringify(result.result),
                },
            });
        }

        // Trigger a new response after tool results
        this.send({ type: "response.create" });
    }

    sendText(text: string): void {
        if (!this.ws || !this._connected) return;

        // Add text as a conversation item
        this.send({
            type: "conversation.item.create",
            item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text }],
            },
        });

        // Trigger response
        this.send({ type: "response.create" });
    }

    // ── Session Configuration ────────────────────

    private sendSessionUpdate(config: LiveSessionConfig): void {
        const tools = getVoiceToolSchemas().map(t => ({
            type: "function" as const,
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
        }));

        this.send({
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                instructions: config.systemPrompt,
                voice: config.voiceName || "alloy",
                input_audio_format: "pcm16",
                output_audio_format: "pcm16",
                input_audio_transcription: { model: "whisper-1" },
                turn_detection: {
                    type: "server_vad",
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 500,
                },
                tools,
            },
        });
    }

    // ── Event Handler ────────────────────────────

    private handleEvent(event: any): void {
        switch (event.type) {
            // Audio response chunks
            case "response.audio.delta": {
                const pcm = Buffer.from(event.delta, "base64");
                this.emit("audio", {
                    pcm,
                    sampleRate: 24000,
                    channels: 1 as const,
                });
                break;
            }

            // Text response
            case "response.text.delta": {
                this.emit("text", event.delta);
                break;
            }

            // Audio transcript (what the model said)
            case "response.audio_transcript.delta": {
                this.emit("transcript", event.delta);
                break;
            }

            // User speech started (VAD detected)
            case "input_audio_buffer.speech_started": {
                this.emit("user_speech_started");
                break;
            }

            // User speech ended
            case "input_audio_buffer.speech_stopped": {
                this.emit("user_speech_ended");
                break;
            }

            // Tool call completed
            case "response.function_call_arguments.done": {
                let args: Record<string, unknown> = {};
                try {
                    args = JSON.parse(event.arguments || "{}");
                } catch { /* */ }

                const call: LiveToolCall = {
                    id: event.call_id,
                    name: event.name,
                    args,
                };
                this.emit("tool_call", [call]);
                break;
            }

            // Response completed
            case "response.done": {
                this.emit("turn_complete");
                break;
            }

            // Session created/updated confirmation
            case "session.created":
            case "session.updated": {
                console.log(`[OPENAI-RT] Session ${event.type}`);
                break;
            }

            // Errors
            case "error": {
                console.error("[OPENAI-RT] Server error:", event.error);
                this.emit("error", new Error(event.error?.message || "OpenAI Realtime error"));
                break;
            }
        }
    }

    // ── Send Helper ──────────────────────────────

    private send(data: Record<string, unknown>): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }
}
