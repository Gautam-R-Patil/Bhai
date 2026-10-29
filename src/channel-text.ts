// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Pure text helpers shared by the chat channels: Markdown → Telegram HTML,
 * HTML-length-aware chunking, and stop-command matching.
 */

import { smartChunkMessage } from "./alive-ux.js";

export const TELEGRAM_MAX_MESSAGE = 4096;

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Replace fenced code (```lang\ncode```) via `render`. An unclosed fence runs to
 * the end only when its opener sits on its own line (what the chunker emits when
 * it splits a block); a stray ``` in prose ("wrap it in ``` fences") stays literal.
 */
function replaceFences(text: string, render: (code: string, lang?: string) => string): string {
    return text.replace(
        /```(?:([\w+#.-]+)[^\S\n]*(\n)|[^\S\n]*(\n)?)([\s\S]*?)(```|$)/g,
        (m, lang: string | undefined, nl1, nl2, code: string, close: string, offset: number, str: string) => {
            const ownLine = (nl1 || nl2) && /(?:^|\n)[^\S\n]*$/.test(str.slice(0, offset));
            if (!close && !ownLine) return m;
            return render(code.replace(/\n$/, ""), lang);
        },
    );
}

/**
 * Convert the model's Markdown into the HTML subset Telegram accepts.
 * Code (fenced and inline) is pulled out into placeholders first so the inline
 * rules (bold, underline, headings, bullets…) never touch it, then restored
 * HTML-escaped.
 */
export function markdownToTelegramHtml(text: string): string {
    const slots: string[] = [];
    const stash = (html: string) => `\uE000${slots.push(html) - 1}\uE000`;

    // A private-use char never appears in real replies; dropping it keeps placeholders unforgeable.
    let html = text.replace(/\uE000/g, "");

    html = replaceFences(html, (code, lang) => {
        const body = escapeHtml(code);
        return stash(lang ? `<pre><code class="language-${lang}">${body}</code></pre>` : `<pre>${body}</pre>`);
    });

    // Inline code: `code`
    html = html.replace(/`([^`\n]+)`/g, (_m, code: string) => stash(`<code>${escapeHtml(code)}</code>`));

    html = escapeHtml(html);

    // Bold: **text** → <b>text</b>
    html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

    // Italic: *text* → <i>text</i> (but not inside bold)
    html = html.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, "<i>$1</i>");

    // Strikethrough: ~~text~~ → <s>text</s>
    html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

    // Underline: __text__ → <u>text</u>
    html = html.replace(/__(.+?)__/g, "<u>$1</u>");

    // Headings: # text → <b>text</b> (Telegram has no heading tags)
    html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

    // Horizontal rules: --- or *** or ___ → ———
    html = html.replace(/^[\s]*([-*_]){3,}[\s]*$/gm, "———");

    // Links: [text](url) → <a href="url">text</a>
    html = html.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_m, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`,
    );

    // Numbered lists: normalise spacing after the number
    html = html.replace(/^(\d+)\.\s+/gm, "$1. ");

    // Bullet points: * item or - item → • item
    html = html.replace(/^[\s]*[*-]\s+/gm, "• ");

    // Simple tables: | a | b | → a  │  b (separator rows dropped)
    const tableMatch = html.match(/^\|.+\|$/gm);
    if (tableMatch && tableMatch.length >= 2) {
        html = html.replace(/^\|(.+)\|$/gm, (_, content: string) => {
            if (/^[\s\-:|]+$/.test(content)) return "";
            return content
                .split("|")
                .map((c) => c.trim())
                .filter(Boolean)
                .join("  │  ");
        });
        html = html.replace(/\n{2,}/g, "\n");
    }

    return html.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => slots[Number(i)] ?? "");
}

/** Strip Markdown markers for the plain-text fallback when Telegram rejects the HTML. */
export function markdownToPlainText(text: string): string {
    return replaceFences(text, (code) => code)
        .replace(/`([^`\n]+)`/g, "$1")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, "$1")
        .replace(/__(.+?)__/g, "$1");
}

export interface TelegramChunk {
    /** Markdown source of this chunk (for the plain-text fallback / later edits). */
    md: string;
    /** Telegram HTML, at most `limit` characters. */
    html: string;
}

// Below this the worst case (every char escaped to &amp;, 5×) still fits 4096.
const MIN_CHUNK_BUDGET = 600;

/**
 * Split Markdown so every chunk's FINAL HTML fits Telegram's limit. HTML
 * escaping and tags grow the text, so a chunk that is too big after conversion
 * is re-split with a proportionally smaller source budget.
 */
export function chunkMarkdownForTelegram(md: string, limit = TELEGRAM_MAX_MESSAGE): TelegramChunk[] {
    const out: TelegramChunk[] = [];
    const walk = (text: string, budget: number) => {
        for (const piece of smartChunkMessage(text, budget)) {
            const html = markdownToTelegramHtml(piece);
            if (html.length <= limit || budget <= MIN_CHUNK_BUDGET) {
                out.push({ md: piece, html });
            } else {
                const next = Math.floor(((piece.length * limit) / html.length) * 0.9);
                walk(piece, Math.max(MIN_CHUNK_BUDGET, Math.min(next, budget - 1)));
            }
        }
    };
    walk(md, limit);
    return out;
}

// ── Stop commands ─────────────────────────────

const STOP_COMMANDS = new Set([
    "stop",
    "cancel",
    "abort",
    "quit",
    "quit it",
    "stop it",
    "stop that",
    "stop now",
    "please stop",
    "stop please",
    "yes stop",
    "no stop",
    "ok stop",
    "wait stop",
    "never mind",
    "nevermind",
    "leave it",
    "dont continue",
    "ruk",
    "ruko",
    "ruk ja",
    "ruk jao",
    "bas",
    "bas karo",
    "bas kar",
    "rehne do",
]);

// Dropped from short messages before the lookup: "stop bhai", "leave it yaar".
const STOP_ADDRESS = new Set(["bhai", "bot", "bro", "please", "pls", "plz", "yaar"]);
// Also dropped on a second pass: "cancel it", "stop the task".
const STOP_FILLER = new Set([...STOP_ADDRESS, "it", "that", "this", "everything", "all", "the", "task", "tasks"]);

/**
 * True when the whole message IS a stop command ("stop", "/stop", "Stop!!",
 * "ruk jao", or a short "stop bhai" / "cancel it") — not when it merely contains
 * one ("can't stop laughing", "quite", "don't stop").
 */
export function isStopCommand(text: string): boolean {
    const normalized = text
        .toLowerCase()
        .trim()
        .replace(/^\/(\w+)@\w+/, "$1") // "/stop@MyBot" in Telegram groups
        .replace(/['’]/g, "")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (STOP_COMMANDS.has(normalized)) return true;
    const words = normalized.split(" ");
    if (words.length > 4) return false;
    return [STOP_ADDRESS, STOP_FILLER].some((drop) => STOP_COMMANDS.has(words.filter((w) => !drop.has(w)).join(" ")));
}
