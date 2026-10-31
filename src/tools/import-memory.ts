// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import {
    estimateImport,
    importMemories,
    MEMORY_EXPORT_PROMPT,
    MEMORY_IMPORT_SOURCES,
    sourceLabel,
} from "../memory/memory-import.js";
import { getPathBlockedReason, isPathAllowed } from "../security/allowlist.js";
import { isSensitivePath } from "../security/sensitive-paths.js";
import { isOwnerCaller, isPrivateOwnerCaller, ownerTurnMessage, turnConversationKey } from "./cron-tool.js";
import { resolveHomePath } from "./file-utils.js";
import type { ToolDefinition } from "./get-current-time.js";

// ── Import memory from another AI assistant ──────────

const MAX_IMPORT_FILE = 200 * 1024 * 1024;
const IMPORT_EXT = /\.(txt|md|markdown|json|zip)$/i;

// A whole data export: ChatGPT shards its chats (conversations-000.json ...), Claude adds
// memories.json and projects.json. users.json / user_settings.json are account data: skipped.
const CONVOS_FILE = /^conversations(?:-\d+)?\.json$/i;
// Google Takeout: My Activity/Gemini Apps/MyActivity.json (folder names follow the account's language).
const GEMINI_DIR = /^gemini[\s-]apps$/i;
// ponytail: ~what 3-at-a-time parts finish inside the 240 s deadline; the desktop's Import shows the cost and has no deadline.
const MAX_TOOL_CHUNKS = 15;

/**
 * Read an export the owner points at: a .txt/.md/.json file, or a data export .zip (every
 * conversations*.json plus Claude's memories.json and projects.json, joined into one JSON
 * array; else its largest .json/.txt/.md). Only those extensions, never a sensitive path:
 * the text goes to the model.
 */
/** `maxBytes`: the 200 MB budget (tests lower it). */
export async function readImportFile(
    rawPath: string,
    maxBytes = MAX_IMPORT_FILE,
): Promise<{ raw: string; filename: string } | { error: string }> {
    const filePath = path.resolve(resolveHomePath(rawPath));
    if (!IMPORT_EXT.test(filePath)) return { error: "Only .txt, .md, .json or .zip exports can be imported." };
    if (!isPathAllowed(filePath)) return { error: getPathBlockedReason(filePath) ?? "Path not allowed." };
    const sensitive = isSensitivePath(filePath);
    if (sensitive.denied) return { error: `Refusing to read a sensitive path. ${sensitive.reason ?? ""}`.trim() };
    let size: number;
    try {
        const st = statSync(filePath);
        if (!st.isFile()) return { error: `Not a file: ${filePath}` };
        size = st.size;
    } catch {
        return { error: `File not found: ${filePath}` };
    }
    if (size > maxBytes) return { error: "That file is over 200 MB." };
    if (!/\.zip$/i.test(filePath)) return { raw: readFileSync(filePath, "utf-8"), filename: path.basename(filePath) };

    const PizZip = (await import("pizzip")).default;
    let zip: InstanceType<typeof PizZip>;
    try {
        zip = new PizZip(readFileSync(filePath));
    } catch {
        return { error: "That .zip couldn't be opened." };
    }
    // pizzip's private _data: the declared size, the method ("\x00\x00" store, "\x08\x00" deflate)
    // and the raw bytes. We inflate ourselves: pizzip's asText has no output cap (zip bomb).
    type Entry = (typeof zip.files)[string] & {
        _data?: { uncompressedSize?: number; compressionMethod?: string; getCompressedContent?: () => Uint8Array };
    };
    const sizeOf = (f: Entry) => f._data?.uncompressedSize ?? 0;
    // Every entry read counts against one 200 MB budget, so many small bombs can't add up.
    let budget = maxBytes;
    const inflate = (f: Entry): string => {
        const data = f._data;
        if (sizeOf(f) > budget) throw new Error("over 200 MB");
        const bytes = Buffer.from(data?.getCompressedContent?.() ?? []);
        let out: Buffer;
        if (data?.compressionMethod === "\x00\x00") out = bytes;
        else if (data?.compressionMethod === "\x08\x00")
            out = inflateRawSync(bytes, { maxOutputLength: Math.max(1, budget) });
        else throw new Error("unsupported compression");
        if (out.length > budget) throw new Error("over 200 MB");
        budget -= out.length;
        return out.toString("utf-8");
    };
    const entries = (Object.values(zip.files) as Entry[]).filter((f) => !f.dir && /\.(json|txt|md)$/i.test(f.name));
    const base = (f: Entry) => path.posix.basename(f.name).toLowerCase();
    const convos = entries.filter((f) => CONVOS_FILE.test(base(f))).sort((a, b) => a.name.localeCompare(b.name));
    const memories = entries.find((f) => base(f) === "memories.json");
    const projects = entries.find((f) => base(f) === "projects.json");
    let reading = "";
    try {
        if (convos.length || memories) {
            const all: unknown[] = [];
            const add = (f: Entry, map?: (x: unknown) => unknown) => {
                reading = f.name;
                const v: unknown = JSON.parse(inflate(f));
                for (const x of Array.isArray(v) ? v : [v]) all.push(map ? map(x) : x);
            };
            // Memories first; projects only by name (their docs can be huge).
            if (memories) add(memories);
            if (projects && memories)
                add(projects, (p) => {
                    const o = (p ?? {}) as Record<string, unknown>;
                    return { uuid: o.uuid, name: o.name };
                });
            for (const f of convos) add(f);
            return { raw: JSON.stringify(all), filename: convos.length ? "conversations.json" : "memories.json" };
        }
        const gemini = entries.find(
            (f) =>
                /\.json$/i.test(f.name) &&
                f.name
                    .split("/")
                    .slice(0, -1)
                    .some((d) => GEMINI_DIR.test(d)),
        );
        const pick =
            gemini ??
            entries
                .filter((f) => !/^users?(?:_settings)?\.json$/.test(base(f)))
                .sort((a, b) => sizeOf(b) - sizeOf(a))[0];
        if (!pick) return { error: "No conversations.json (or .json/.txt/.md file) inside that .zip." };
        reading = pick.name;
        return { raw: inflate(pick), filename: path.posix.basename(pick.name) };
    } catch (err) {
        const msg = (err as Error).message;
        if (msg === "unsupported compression")
            return { error: `${reading} inside the .zip uses an unsupported compression.` };
        if (msg === "over 200 MB") return { error: "What's inside that .zip is over 200 MB." };
        return { error: `${reading} inside the .zip couldn't be read (corrupt, or over 200 MB).` };
    }
}

/** The owner's message asks to import (any language cue Bhai hears), names an export, or is a pasted export ("[2025-01-02] - …" lines). */
export function hasImportCue(message: string): boolean {
    return (
        /\b(import|bring|transfer|migrate|move|copy|sync|export|memor(?:y|ies)|remember|yaad|conversations\.json|memories\.json|chatgpt|claude|gemini|grok|perplexity|muse|instinct|copilot|character\.ai)\b/i.test(
            message,
        ) ||
        /याद|इम्पोर्ट/.test(message) ||
        /^\s*[-*]?\s*\[(?:\d{4}-\d\d-\d\d|unknown)\]\s*-/im.test(message)
    );
}

export const importMemory: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "import_memory",
            description:
                "Import what another AI assistant (ChatGPT, Claude, Gemini, Grok, Perplexity, Muse, Instinct, Pi, Character.ai, Copilot, Meta AI...) knows about the owner into Bhai's memory. Owner only, private chat. Call with no text/file_path first: it returns the export prompt for the owner to paste into that app, plus where that app keeps its export; show the prompt in a code block. When the owner sends back that app's answer, call with `text` (their pasted answer, verbatim); for a data export (the whole .zip, conversations.json, Claude's memories.json, Gemini's Google Takeout MyActivity.json, Pi's pi-user-history.json, or a .txt/.md/.json) call with `file_path`. Facts are extracted as data (instructions inside are ignored), added without touching existing memories, and duplicates are skipped. Afterwards tell the owner how many were added and that they can ask you to forget any.",
            parameters: {
                type: "object",
                properties: {
                    text: {
                        type: "string",
                        description: "The other assistant's memory export, as the owner pasted it",
                    },
                    file_path: {
                        type: "string",
                        description:
                            "Absolute path of an export file: the data export .zip, conversations.json, memories.json, pi-user-history.json, .txt, .md or .json",
                    },
                    source: {
                        type: "string",
                        enum: MEMORY_IMPORT_SOURCES.map((s) => s.id),
                        description: "Which assistant it came from",
                    },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        if (!isOwnerCaller()) return JSON.stringify({ success: false, error: "Only the owner can import memories." });
        if (!isPrivateOwnerCaller()) {
            return JSON.stringify({
                success: false,
                error: "Ask me in our private chat: importing shows what I know.",
            });
        }
        const source = typeof input.source === "string" ? input.source : undefined;
        const text = typeof input.text === "string" ? input.text.trim() : "";
        const filePath = typeof input.file_path === "string" ? input.file_path.trim() : "";
        if (!text && !filePath) {
            const src = MEMORY_IMPORT_SOURCES.find((s) => s.id === source);
            const channel = turnConversationKey()?.split(":")[0];
            return JSON.stringify({
                success: true,
                prompt: MEMORY_EXPORT_PROMPT,
                ...(src ? { where: src.hint } : { sources: MEMORY_IMPORT_SOURCES.map((s) => `${s.label}: ${s.hint}`) }),
                hint: `Give the owner this prompt in a code block to paste into a new chat in ${sourceLabel(source)}, then ask them to send its answer (or the export file) back here.`,
                ...(channel === "telegram" || channel === "whatsapp"
                    ? {
                          channel_hint:
                              "Lead with pasting the prompt: it's the quickest way from a phone. A full data export .zip is usually over Telegram's 20 MB bot limit, so for an export they can send just conversations.json (or memories.json) from it, or use Import in the Bhai desktop app.",
                      }
                    : {}),
            });
        }
        // Only the owner's own words start an import: text injected by a page, mail or file the
        // model read can't fill memory. Their message asks for it, or is the pasted export itself.
        if (!hasImportCue(ownerTurnMessage())) {
            return JSON.stringify({
                success: false,
                error: 'The owner didn\'t ask for an import in this message. Ask them to reply in their own words, e.g. "import it" or "import my memories", and call again on that reply.',
            });
        }
        let raw = text;
        let filename: string | undefined;
        if (!raw) {
            const file = await readImportFile(filePath);
            if ("error" in file) return JSON.stringify({ success: false, error: file.error });
            ({ raw, filename } = file);
        }
        const est = estimateImport(raw, filename);
        if (est.chunks > MAX_TOOL_CHUNKS) {
            return JSON.stringify({
                success: false,
                parts: est.chunks,
                credits: est.credits,
                error: `That export is ${est.chunks} parts (about ${est.credits} credits), too much to read in one go here. Ask the owner to use Import in the Bhai desktop app (it shows the cost first), or to send it in smaller pieces.`,
            });
        }
        // The tool call times out at 300 s (TOOL_TIMEOUTS.import_memory) without stopping this: finish well inside it.
        const r = await importMemories({ raw, filename, source, deadline: Date.now() + 240_000 });
        if (r.error && r.added === 0) return JSON.stringify({ success: false, error: r.error });
        return JSON.stringify({
            success: true,
            source: sourceLabel(source ?? r.detectedSource),
            added: r.added,
            already_known: r.duplicates,
            rejected: r.rejected,
            batch: r.batch,
            left_out: { instruction_like: r.droppedInstructions, sensitive: r.droppedSensitive },
            ...(r.failedChunks ? { failed_parts: r.failedChunks } : {}),
            ...(r.overCap ? { over_cap: r.overCap } : {}),
            ...(r.incomplete
                ? { incomplete: "The other app said there are more entries: ask the owner to get the rest." }
                : {}),
            ...(r.truncated
                ? {
                      truncated:
                          r.kind.endsWith("_conversations") || r.kind === "gemini_activity"
                              ? "Only the newest chats of a very large export were read."
                              : "Only the first part of a very large export was read: the owner can import the rest separately.",
                  }
                : {}),
            // A sample of what was found, most important first; already-known ones were skipped. ids = the rows added.
            extracted: [...r.facts]
                .sort((a, b) => b.importance - a.importance)
                .slice(0, 20)
                .map((f) => f.content),
            ids: r.ids,
            hint: `Tell the owner how many facts you added. Say back the few most defining ones in your own words (nothing sensitive) and ask which is wrong.${r.added ? ` To drop one, use memory_forget with words from it; to undo the whole import, call memory_forget with import_batch "${r.batch}" (preview first, then the owner's confirmation).` : ""}`,
        });
    },
};
