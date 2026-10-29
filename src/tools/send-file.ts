// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import path from "node:path";
import type { InputFile } from "grammy";
import type { ToolDefinition } from "./get-current-time.js";

// ── Active chat state (set by telegram.ts) ────

let _botInstance: {
    api: {
        sendDocument: Function;
        sendPhoto: Function;
        sendVideo: Function;
        sendAudio: Function;
        sendVoice: Function;
        sendAnimation: Function;
    };
} | null = null;
let _activeChatId: number | null = null;

export function setTelegramContext(bot: unknown, chatId: number): void {
    _botInstance = bot as typeof _botInstance;
    _activeChatId = chatId;
}

export function getTelegramContext(): { bot: typeof _botInstance; chatId: number | null } {
    return { bot: _botInstance, chatId: _activeChatId };
}

// ── File type detection ───────────────────────

const PHOTO_EXTS = new Set(["jpg", "jpeg", "png", "webp", "bmp"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "mkv", "webm"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "aac", "m4a"]);
const GIF_EXTS = new Set(["gif"]);

function getFileCategory(ext: string): "photo" | "video" | "audio" | "gif" | "document" {
    const e = ext.toLowerCase();
    if (PHOTO_EXTS.has(e)) return "photo";
    if (VIDEO_EXTS.has(e)) return "video";
    if (AUDIO_EXTS.has(e)) return "audio";
    if (GIF_EXTS.has(e)) return "gif";
    return "document";
}

// ── Tool: Send File ───────────────────────────

export const sendFileTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "send_file",
            description:
                "Send a file from the local system to the user on Telegram. Supports all file types: photos (jpg/png), videos (mp4/mov), audio (mp3/wav), documents (pdf/doc/txt/zip/ppt), etc. The file will be sent as the appropriate type (photo, video, audio, or document).",
            parameters: {
                type: "object",
                properties: {
                    file_path: { type: "string", description: "Absolute path to the file on the local system" },
                    caption: { type: "string", description: "Optional caption to send with the file" },
                },
                required: ["file_path"],
            },
        },
    },
    async handler(input) {
        try {
            const filePath = input.file_path as string;
            const caption = (input.caption as string) || undefined;

            // Validate
            if (!_botInstance || !_activeChatId) {
                return JSON.stringify({ error: "Telegram context not available. Cannot send file." });
            }

            if (!fs.existsSync(filePath)) {
                return JSON.stringify({ error: `File not found: ${filePath}` });
            }

            const stats = fs.statSync(filePath);
            if (stats.size > 50 * 1024 * 1024) {
                return JSON.stringify({ error: "File exceeds Telegram's 50MB limit." });
            }

            const ext = path.extname(filePath).slice(1).toLowerCase();
            const category = getFileCategory(ext);
            const fileName = path.basename(filePath);

            // Read file as InputFile
            const fileBuffer = fs.readFileSync(filePath);
            const inputFile = new (await import("grammy")).InputFile(fileBuffer, fileName);

            // Send based on type
            switch (category) {
                case "photo":
                    await _botInstance.api.sendPhoto(_activeChatId, inputFile, { caption });
                    break;
                case "video":
                    await _botInstance.api.sendVideo(_activeChatId, inputFile, { caption });
                    break;
                case "audio":
                    await _botInstance.api.sendAudio(_activeChatId, inputFile, { caption });
                    break;
                case "gif":
                    await _botInstance.api.sendAnimation(_activeChatId, inputFile, { caption });
                    break;
                default:
                    await _botInstance.api.sendDocument(_activeChatId, inputFile, { caption });
                    break;
            }

            return JSON.stringify({
                success: true,
                sent: fileName,
                type: category,
                size_kb: Math.round(stats.size / 1024),
            });
        } catch (err) {
            return JSON.stringify({ error: `Failed to send file: ${(err as Error).message}` });
        }
    },
};
