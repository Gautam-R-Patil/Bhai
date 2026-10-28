// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Saved chat-bar transcript: one JSON line per message in
// <data>/chat-history.jsonl ({ chat, ts, role, text, source }). The desktop
// dashboard's Chats page reads it, and on boot the last few turns are put back
// into the agent's context so Bhai remembers the conversation after a restart.

import { protect } from "../security/pii-vault.js";
import fs from "node:fs";
import path from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { sanitizeUntrustedContent } from "../agent/system-reminders.js";
import { getDataDir } from "../config/paths.js";

export type ChatRole = "user" | "assistant";

export interface ChatLogEntry {
    chat: string;
    ts: number;
    role: ChatRole;
    text: string;
    source: string;
}

export function chatLogPath(): string {
    return path.join(getDataDir(), "chat-history.jsonl");
}

// ponytail: append-only, never rotated; trim it if files over a few MB show up.
export function logChatMessage(chat: string, role: ChatRole, text: string, source = "overlay"): void {
    const clean = protect(text.trim()); // no card numbers, OTPs etc. on disk
    if (!clean) return;
    try {
        fs.mkdirSync(getDataDir(), { recursive: true });
        fs.appendFileSync(chatLogPath(), `${JSON.stringify({ chat, ts: Date.now(), role, text: clean, source })}\n`);
    } catch (err) {
        console.warn("[chat-log] write failed:", (err as Error).message);
    }
}

/** Mark that the user cleared the conversation (/new): nothing before it is restored. */
export function markChatReset(): void {
    // Only an existing log can bring old context back, so don't create one.
    if (!fs.existsSync(chatLogPath())) return;
    try {
        fs.appendFileSync(chatLogPath(), `${JSON.stringify({ role: "reset", ts: Date.now() })}\n`);
    } catch {
        /* best effort */
    }
}

function readLines(): Array<Record<string, unknown>> {
    let raw: string;
    try {
        raw = fs.readFileSync(chatLogPath(), "utf8");
    } catch {
        return [];
    }
    const out: Array<Record<string, unknown>> = [];
    for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
            const e = JSON.parse(line);
            if (e && typeof e === "object") out.push(e);
        } catch {
            /* skip a torn line */
        }
    }
    return out;
}

const isMessage = (e: Record<string, unknown>): e is ChatLogEntry & Record<string, unknown> =>
    typeof e.text === "string" && (e.role === "user" || e.role === "assistant");

export function readChatLog(): ChatLogEntry[] {
    return readLines().filter(isMessage);
}

/**
 * The last `limit` owner messages from the past `maxAgeMs` (and since the last
 * /new), as agent context. Web-widget visitors aren't the owner, and restored
 * text goes through the same sanitizer as any incoming message.
 */
export function recentChatContext(maxAgeMs: number, limit: number, now = Date.now()): ChatCompletionMessageParam[] {
    const lines = readLines();
    let start = 0; // after the last /new marker (append-only, so file order is time order)
    lines.forEach((e, i) => {
        if (e.role === "reset") start = i + 1;
    });
    const afterReset = lines.slice(start);
    return afterReset
        .filter(isMessage)
        .filter((e) => now - e.ts <= maxAgeMs && e.source !== "web-widget")
        .slice(-limit)
        .map((e) => ({ role: e.role, content: sanitizeUntrustedContent(e.text) }));
}
