// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { Bot } from "grammy";
import type { LLMClient } from "../llm.js";
import { transcribeBuffer } from "./transcribe.js";
import { runAgent, type MediaAttachment } from "../agent.js";
import { setTelegramContext } from "../tools/send-file.js";
import { getVoiceStagePhrase, getErrorMessage, categorizeError } from "../alive-ux.js";

// ── Wire Voice Handlers ───────────────────────
// Handles voice messages and audio files from Telegram.
// Dual-path: transcribes via Whisper AND sends raw audio to Pro model
// so it can understand songs, background sounds, tone, etc.

export function setupTelegramVoice(
    bot: Bot,
    llm: LLMClient,
): void {
    // Handle voice messages (recorded in Telegram)
    bot.on("message:voice", async (ctx) => {
        const userName = ctx.from.first_name || "User";
        const chatId = ctx.chat.id;
        console.log(`\n🎙️ ${userName}: [voice message]`);

        await ctx.replyWithChatAction("typing");

        try {
            // Download voice file
            const file = await ctx.getFile();
            const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
            const response = await fetch(fileUrl);
            const buffer = Buffer.from(await response.arrayBuffer());
            const base64 = buffer.toString("base64");
            const duration = ctx.message.voice.duration || 0;

            console.log(`  📥 Downloaded voice: ${Math.round(buffer.length / 1024)}KB, ${duration}s`);

            // ── Dual-path: transcribe + send raw audio to Pro model ──

            // 1. Transcribe for display (errors are non-fatal)
            let transcription = "";
            try {
                const transcribeStatus = getVoiceStagePhrase("transcribing");
                console.log(`  📝 ${transcribeStatus}`);
                transcription = await transcribeBuffer(buffer, "voice.ogg");
                console.log(`  📝 Transcribed: "${transcription}"`);
                // Show transcription to user
                if (transcription.trim()) {
                    await ctx.reply(`🎙️ _"${transcription}"_`, { parse_mode: "Markdown" });
                }
            } catch (err) {
                console.warn("  ⚠️ Transcription failed (non-fatal):", err);
                // Silently continue — we'll still process the raw audio
            }

            // 2. Build context message for the agent
            const contextParts: string[] = [];
            if (transcription.trim()) {
                contextParts.push(`[Voice message transcription: "${transcription}"]`);
            } else {
                contextParts.push(`[Voice message — transcription unavailable]`);
            }
            contextParts.push(`[The raw audio is attached. Listen to it to understand tone, emotion, background sounds, music, or anything beyond the words. If you notice interesting sounds in the background (like a dog barking, music playing, traffic, etc.), feel free to casually mention it — but only if it's genuinely interesting and the conversation isn't serious/focused.]`);

            const agentMessage = contextParts.join("\n");

            // 3. Send to agent with raw audio attached
            const media: MediaAttachment[] = [{
                type: "audio",
                base64,
                mimeType: "audio/ogg",
            }];

            setTelegramContext(bot, chatId);
            await ctx.replyWithChatAction("typing");

            const result = await runAgent(llm, agentMessage, undefined, media);
            console.log(`  🤖 Response: ${result.text.substring(0, 200)}`);

            // Send text reply
            await ctx.reply(result.text);
        } catch (err) {
            console.error("❌ Voice processing error:", err);
            const errorType = categorizeError(err as Error);
            await ctx.reply(getErrorMessage(errorType));
        }
    });

    // Handle audio files (songs, recordings shared as files)
    bot.on("message:audio", async (ctx) => {
        const userName = ctx.from.first_name || "User";
        const chatId = ctx.chat.id;
        const audioTitle = ctx.message.audio.title || "untitled";
        const audioPerformer = ctx.message.audio.performer || "";
        const caption = ctx.message.caption || "";
        const mimeType = ctx.message.audio.mime_type || "audio/mpeg";

        console.log(`\n🎵 ${userName}: [audio file: ${audioPerformer ? audioPerformer + " - " : ""}${audioTitle}]`);

        await ctx.replyWithChatAction("typing");

        try {
            // Download audio file
            const file = await ctx.getFile();
            const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
            const response = await fetch(fileUrl);
            const buffer = Buffer.from(await response.arrayBuffer());
            const base64 = buffer.toString("base64");

            console.log(`  📥 Downloaded audio: ${Math.round(buffer.length / 1024)}KB`);

            // Check file size — Pro model has limits (~20MB for inline audio)
            const MAX_AUDIO_SIZE = 20 * 1024 * 1024; // 20MB
            if (buffer.length > MAX_AUDIO_SIZE) {
                await ctx.reply("that file's too big — try a shorter clip?");
                return;
            }

            // Build context
            const contextParts: string[] = [];
            if (audioTitle && audioTitle !== "untitled") {
                contextParts.push(`[Audio file received: "${audioPerformer ? audioPerformer + " - " : ""}${audioTitle}"]`);
            } else {
                contextParts.push(`[Audio file received]`);
            }
            if (caption) {
                contextParts.push(`[User's message: "${caption}"]`);
            }
            contextParts.push(`[The raw audio is attached. Listen to it — identify the song, describe the music, analyze the audio, or do whatever the user is asking for.]`);

            const agentMessage = contextParts.join("\n");

            // Determine format from mime type
            const media: MediaAttachment[] = [{
                type: "audio",
                base64,
                mimeType,
            }];

            setTelegramContext(bot, chatId);
            await ctx.replyWithChatAction("typing");

            const result = await runAgent(llm, agentMessage, undefined, media);
            console.log(`  🤖 Response: ${result.text.substring(0, 200)}`);

            await ctx.reply(result.text);
        } catch (err) {
            console.error("❌ Audio processing error:", err);
            const errorType = categorizeError(err as Error);
            await ctx.reply(getErrorMessage(errorType));
        }
    });
}
