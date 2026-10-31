// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── WhatsApp media and chat actions ─────────────────────────────
// What whatsapp.ts needs beyond text: seeing a video (frames + its sound), votes on
// polls and answers to events (encrypted the way WhatsApp expects), and the reply
// markers Bhai uses to act in a chat ([[voice]], [[vote:…]], [[poll:…]], …).

import { execFile } from "node:child_process";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);

// ── Video ─────────────────────────────────────

/**
 * A few evenly spaced JPEG frames of a video (≤768px wide), so a model that can't
 * watch video can still see it. Empty when ffmpeg can't read it.
 */
export async function videoFrames(file: string, seconds: number | null | undefined, count = 4): Promise<Buffer[]> {
    const { ffmpegPath } = await import("./video-studio/util/ffmpeg-bin.js");
    const ff = ffmpegPath();
    const dur = seconds && seconds > 0 ? seconds : 4;
    const frames: Buffer[] = [];
    for (let i = 0; i < count; i++) {
        const at = ((i + 0.5) * dur) / count;
        try {
            const { stdout } = await run(
                ff,
                [
                    "-ss",
                    at.toFixed(2),
                    "-i",
                    file,
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale='min(768,iw)':-2",
                    "-f",
                    "image2",
                    "-c:v",
                    "mjpeg",
                    "pipe:1",
                ],
                { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
            );
            if (stdout.length > 0) frames.push(stdout);
        } catch {
            // past the end or unreadable: fewer frames
        }
    }
    return frames;
}

/** A video's sound as Ogg/Opus (for transcription), or null when it has none. */
export async function videoSound(file: string): Promise<Buffer | null> {
    const { ffmpegPath } = await import("./video-studio/util/ffmpeg-bin.js");
    try {
        const { stdout } = await run(
            ffmpegPath(),
            ["-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-f", "ogg", "pipe:1"],
            { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
        );
        // An Ogg file with no audio packets is a few hundred bytes of headers.
        return stdout.length > 1000 ? stdout : null;
    } catch {
        return null;
    }
}

/** A .gif as an MP4 WhatsApp plays as a GIF (a .gif sent as an image doesn't move). */
export async function gifToMp4(file: string, out: string): Promise<void> {
    const { ffmpegPath } = await import("./video-studio/util/ffmpeg-bin.js");
    await run(
        ffmpegPath(),
        [
            "-y",
            "-i",
            file,
            "-movflags",
            "faststart",
            "-pix_fmt",
            "yuv420p",
            "-vf",
            "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:v",
            "libx264",
            out,
        ],
        { timeout: 60_000 },
    );
}

// ── Poll votes and event answers ───────────────
// WhatsApp encrypts a vote (and an RSVP) with a key derived from the poll's (event's)
// messageSecret and the ids involved; this mirrors Baileys' decryptPollVote /
// decryptEventResponse. All JIDs are phone JIDs (…@s.whatsapp.net), not LIDs.

export interface EncryptContext {
    /** messageContextInfo.messageSecret of the poll or event message */
    secret: Uint8Array;
    /** id of the poll or event message */
    msgId: string;
    /** who sent the poll or event */
    creatorJid: string;
    /** who votes or answers (Bhai) */
    actorJid: string;
}

export function encryptAddOn(
    plaintext: Uint8Array,
    kind: "Poll Vote" | "Event Response",
    ctx: EncryptContext,
): { encPayload: Buffer; encIv: Buffer } {
    const sign = Buffer.concat([
        Buffer.from(ctx.msgId),
        Buffer.from(ctx.creatorJid),
        Buffer.from(ctx.actorJid),
        Buffer.from(kind),
        Buffer.from([1]),
    ]);
    const key0 = createHmac("sha256", new Uint8Array(32)).update(ctx.secret).digest();
    const key = createHmac("sha256", key0).update(sign).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`${ctx.msgId}\u0000${ctx.actorJid}`));
    const encPayload = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return { encPayload, encIv: iv };
}

/** A vote names options by the SHA-256 of their text. */
export function optionHash(name: string): Buffer {
    return createHash("sha256").update(Buffer.from(name)).digest();
}

/** The poll's options that `wanted` names: exact text, then a unique partial, then a 1-based number. */
export function pickPollOptions(options: string[], wanted: string[]): string[] {
    const picked = new Set<string>();
    for (const w of wanted.map((x) => x.trim().toLowerCase()).filter(Boolean)) {
        const exact = options.find((o) => o.trim().toLowerCase() === w);
        const partial = options.filter((o) => o.toLowerCase().includes(w));
        const n = /^\d+$/.test(w) ? options[Number(w) - 1] : undefined;
        const hit = exact ?? (partial.length === 1 ? partial[0] : undefined) ?? n;
        if (hit) picked.add(hit);
    }
    return [...picked];
}

// ── Reply markers ───────────────────────────────
// A reply can carry markers that act in the chat it answers (the marker text never shows):
//   [[voice]]                            send this reply as a voice note
//   [[vote:Option]] / [[vote:A|B]]       vote on the latest poll here
//   [[rsvp:going|maybe|no]]              answer the latest event here
//   [[poll:Question|Option A|Option B]]  start a poll here
//   [[location:12.97,77.59|Name]]        send a location pin
//   [[event:Name|2026-11-02 19:00|Place]] create an event (WhatsApp events)

export interface ChatActions {
    voice?: boolean;
    vote?: string[];
    rsvp?: "going" | "maybe" | "no";
    poll?: { question: string; options: string[] };
    location?: { lat: number; lng: number; name?: string };
    event?: { name: string; start: Date; place?: string };
}

export function takeChatActions(text: string): { text: string; actions: ChatActions } {
    const actions: ChatActions = {};
    const rest = text.replace(
        /\[\[\s*(voice|vote|rsvp|poll|location|event)\s*(?::([^\]]*))?\]\]/gi,
        (_m, k: string, v = "") => {
            const parts = String(v)
                .split("|")
                .map((p) => p.trim())
                .filter(Boolean);
            switch (k.toLowerCase()) {
                case "voice":
                    actions.voice = true;
                    break;
                case "vote":
                    if (parts.length) actions.vote = parts;
                    break;
                case "rsvp": {
                    const r = parts[0]?.toLowerCase().replace(/[\s_-]+/g, "");
                    if (r === "going" || r === "yes") actions.rsvp = "going";
                    else if (r === "maybe") actions.rsvp = "maybe";
                    else if (r === "no" || r === "notgoing") actions.rsvp = "no";
                    break;
                }
                case "poll":
                    if (parts.length >= 3)
                        actions.poll = { question: parts[0], options: [...new Set(parts.slice(1))].slice(0, 12) };
                    break;
                case "location": {
                    const [lat, lng] = (parts[0] ?? "").split(",").map(Number);
                    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)
                        actions.location = { lat, lng, name: parts[1] };
                    break;
                }
                case "event": {
                    const start = new Date(parts[1] ?? "");
                    if (parts[0] && !Number.isNaN(start.getTime()))
                        actions.event = { name: parts[0], start, place: parts[2] };
                    break;
                }
            }
            return "";
        },
    );
    return { text: rest === text ? text : rest.replace(/[ \t]+\n/g, "\n").trim(), actions };
}
