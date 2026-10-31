// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import OpenAI from "openai";
import { elevenLabsTTS } from "./elevenlabs.js";

export type TtsProvider = "elevenlabs" | "openai" | "none";

export type OpenAIVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
    if (!openaiClient) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error("OPENAI_API_KEY not configured for TTS");
        openaiClient = new OpenAI({ apiKey });
    }
    return openaiClient;
}

// Choose provider in this order: explicit BHAI_TTS_PROVIDER override →
// ELEVENLABS_API_KEY → OPENAI_API_KEY → none. Keeping the order deterministic
// lets users pin provider without touching code while still getting graceful
// fallback when the preferred key is missing.
function pickProvider(): TtsProvider {
    const override = (process.env.BHAI_TTS_PROVIDER || "").toLowerCase();
    if (override === "openai" || override === "elevenlabs") return override;
    if (process.env.ELEVENLABS_API_KEY) return "elevenlabs";
    if (process.env.OPENAI_API_KEY) return "openai";
    return "none";
}

export function _pickProviderForTests(): TtsProvider {
    return pickProvider();
}

/**
 * Strip markup that the LLM sometimes leaks into text-mode responses even in
 * voice mode — HTML comments, widget markers, overlay directives, code fences,
 * markdown links, headings, bullet-list prefixes. TTS reads these literally
 * ("widget type colon clock"), which is terrible UX. The voice system prompt
 * already forbids them but LLMs violate it; strip as belt-and-braces. Used by
 * live voice and by every textToSpeech call (WhatsApp voice replies).
 */
export function stripTtsMarkup(text: string): string {
    return text
        // HTML comments (widget markers, collapse/quick_actions, etc)
        .replace(/<!--[\s\S]*?-->/g, "")
        // Code fences — keep the inner text, drop the backticks + language tag
        .replace(/```[a-zA-Z0-9]*\n?/g, "")
        .replace(/```/g, "")
        // Inline code backticks — TTS reads them as "backtick"
        .replace(/`([^`]*)`/g, "$1")
        // Markdown links: [text](url) → text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        // Bold/italic asterisks around words — keep the word
        .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
        // Heading hashes
        .replace(/^\s*#{1,6}\s+/gm, "")
        // Leading bullet markers on a line (*, -, •, numbered)
        .replace(/^\s*[-*•]\s+/gm, "")
        .replace(/^\s*\d+\.\s+/gm, "")
        // Trailing whitespace cleanup
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** Speech for `text`, markup stripped. `mimetype` is what the bytes really are. */
export async function textToSpeech(
    text: string,
    voice: OpenAIVoice = "onyx", // male: Bhai is a "he"
    speed = 1.0,
): Promise<{ audio: Buffer; mimetype: string }> {
    text = stripTtsMarkup(text);
    const provider = pickProvider();
    if (provider === "elevenlabs") {
        return { audio: await elevenLabsTTS(text), mimetype: "audio/mpeg" };
    }
    if (provider === "openai") {
        const client = getOpenAI();
        const response = await client.audio.speech.create({
            model: "tts-1",
            voice,
            input: text,
            speed,
            response_format: "opus",
        });
        return { audio: Buffer.from(await response.arrayBuffer()), mimetype: "audio/ogg; codecs=opus" };
    }
    // No key of the user's own: the server's voice (Azure), then the Mac's built-in one.
    const served = await speakViaServer(text).catch((err: Error) => {
        console.log(`[TTS] server voice unavailable: ${err.message}`);
        return null;
    });
    if (served) return served;
    if (process.platform === "darwin") return { audio: await macSay(text), mimetype: "audio/ogg; codecs=opus" };
    throw new Error(
        "No TTS provider configured — set ELEVENLABS_API_KEY or OPENAI_API_KEY",
    );
}

/** /api/tts (convex/tts.ts): null when the server has no voice configured. */
async function speakViaServer(text: string): Promise<{ audio: Buffer; mimetype: string } | null> {
    const { getSessionToken } = await import("../session.js");
    const { getConvexSiteUrl } = await import("../config/keys.js");
    const { encryptedFetch } = await import("../crypto-transport.js");
    const token = await getSessionToken();
    const site = getConvexSiteUrl();
    if (!token || !site) return null;
    const res = await encryptedFetch(`${site}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: text.slice(0, 4000) }),
        signal: AbortSignal.timeout(90_000),
    });
    // 503: no provider on the server; 404: a backend without /api/tts yet.
    if (res.status === 503 || res.status === 404) return null;
    const data = (await res.json().catch(() => ({}))) as { audio?: string; mimeType?: string; error?: string };
    if (!res.ok || !data.audio) throw new Error(`${res.status} ${data.error ?? ""}`.trim());
    return { audio: Buffer.from(data.audio, "base64"), mimetype: data.mimeType || "audio/ogg; codecs=opus" };
}

/** macOS `say`, as Ogg/Opus (what a WhatsApp voice note is). */
async function macSay(text: string): Promise<Buffer> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const os = await import("node:os");
    const path = await import("node:path");
    const fsp = await import("node:fs/promises");
    const run = promisify(execFile);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bhai-say-"));
    try {
        const aiff = path.join(dir, "say.aiff");
        const ogg = path.join(dir, "say.ogg");
        // Rishi: the Mac's Indian-English male voice; the system voice if it isn't installed.
        await run("/usr/bin/say", ["-v", "Rishi", "-o", aiff, "--", text], { timeout: 60_000 }).catch(() =>
            run("/usr/bin/say", ["-o", aiff, "--", text], { timeout: 60_000 }),
        );
        const { ffmpegPath } = await import("../video-studio/util/ffmpeg-bin.js");
        await run(ffmpegPath(), ["-y", "-i", aiff, "-ac", "1", "-c:a", "libopus", "-b:a", "32k", ogg], { timeout: 60_000 });
        return await fsp.readFile(ogg);
    } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}
