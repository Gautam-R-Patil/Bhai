// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createHash } from "node:crypto";
import { pruneJsonValues, smartTruncate } from "../agents/smart-truncate.js";
import type { ChatCompletionMessageParam, LLMClient } from "../llm.js";
import { sanitizeSecrets } from "../security/secrets-sanitizer.js";
import { buildCompressionUserPrompt, COMPRESSION_SYSTEM_PROMPT } from "./compression-template.js";
import { getLastCompressionSummary, getSessionState, setLastCompressionSummary } from "./session.js";
import { keywordSearch, remember } from "./sqlite.js";

// ── Types ─────────────────────────────────────

interface PruneResult {
    messages: ChatCompletionMessageParam[];
    pruned: number;
    summary?: string;
}

// ── Constants ─────────────────────────────────

const MAX_MESSAGES = 60;
const PRUNE_KEEP_RECENT = 20;

// ── Rough Token Counter ───────────────────────

export function estimateTokens(text: string): number {
    // ~4 chars per token is a rough estimate
    return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: ChatCompletionMessageParam[]): number {
    return messages.reduce((sum, m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return sum + estimateTokens(content || "");
    }, 0);
}

/**
 * Nudge a split index off an orphaned tool response. When the `recent` half
 * (messages.slice(split)) begins with `tool` messages whose assistant
 * `tool_calls` are in the old half, the API rejects the request (a tool result
 * with no preceding tool_calls). The no-user fallbacks in pruneContext and
 * compactConversation can land the split exactly there. Advancing past the
 * leading tool responses keeps them with their assistant in the old (summarized)
 * half, so `recent` always starts on a non-tool message.
 */
export function avoidToolOrphan(messages: ChatCompletionMessageParam[], split: number): number {
    let s = split;
    while (s < messages.length && messages[s].role === "tool") s++;
    return s;
}

// ── Auto-Flush: Save Key Facts Before Pruning ─

/**
 * Extract durable facts from messages about to be pruned and persist
 * them as memories. Replaces the previous per-message length/JSON filter
 * which leaked tool results and screenshot blobs into the memory DB.
 *
 * Runs one Haiku extraction call over the full window; emitted facts go
 * through remember() with source="reflection" (auto-allowed by the gate).
 */
const normFact = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Near-exact (case/punctuation-insensitive) duplicate check against stored memories via FTS. */
function alreadyKnown(fact: string): boolean {
    const n = normFact(fact);
    return keywordSearch(fact, 5).some((m) => normFact(m.content) === n);
}

async function flushToMemory(messages: ChatCompletionMessageParam[], llm: LLMClient): Promise<void> {
    try {
        if (messages.length === 0) return;

        const transcript = messages
            .map((m) => {
                const role = m.role;
                const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
                return `${role}: ${content.slice(0, 800)}`;
            })
            .join("\n");

        if (transcript.length < 200) return;

        const response = await llm.chat({
            messages: [
                {
                    role: "user",
                    content:
                        "Read this conversation excerpt. Extract any durable facts about the user, their projects, decisions, or preferences. Skip tool calls, errors, system noise, screenshots, and execution telemetry. Return a JSON array of short fact strings (each under 200 chars), or [] if nothing durable.\n\nExcerpt:\n" +
                        transcript,
                },
            ],
            systemPrompt:
                "You are a memory extractor. Output ONLY a JSON array of fact strings. No prose, no markdown, no explanations.",
            modelOverride: "openai/gpt-4.1-nano",
        });

        const raw = response.choices[0]?.message?.content;
        if (typeof raw !== "string") return;

        let facts: unknown;
        try {
            const stripped = raw
                .trim()
                .replace(/^```(?:json)?/i, "")
                .replace(/```$/i, "")
                .trim();
            facts = JSON.parse(stripped);
        } catch {
            return;
        }

        if (!Array.isArray(facts)) return;

        let flushed = 0;
        const seen = new Set<string>();
        for (const fact of facts) {
            if (typeof fact !== "string") continue;
            const trimmed = fact.trim();
            if (trimmed.length < 10 || trimmed.length > 200) continue;
            const key = normFact(trimmed);
            if (seen.has(key)) continue;
            seen.add(key);
            try {
                if (alreadyKnown(trimmed)) continue;
                await remember(trimmed, "session_summary", "context_pruning,auto", 5, "reflection");
                flushed++;
            } catch {
                /* remember() failure non-fatal */
            }
        }

        if (flushed > 0) {
            console.log(`  [AUTO_FLUSH] Saved ${flushed} extracted facts from pruned messages`);
        }
    } catch (err) {
        console.warn("[AUTO_FLUSH] Extractor failed (non-fatal):", (err as Error).message);
    }
}

// ── Prune Context ─────────────────────────────

export async function pruneContext(messages: ChatCompletionMessageParam[], llm: LLMClient): Promise<PruneResult> {
    // Window-aware trigger (opt-in): prune when estimated tokens exceed ~70% of
    // the last model's context window OR the legacy count cap. The token
    // estimate is pure char arithmetic — zero LLM cost. Fail-open to count-only.
    if (process.env.ATLAS_WINDOW_AWARE_PRUNE === "true") {
        try {
            const { getContextWindow, getConversationContext } = await import("../model-router.js");
            const lastModel = getConversationContext().lastModelUsed ?? "anthropic/claude-sonnet-4.6";
            const win = getContextWindow(lastModel);
            const est = estimateMessagesTokens(messages);
            if (est <= win * 0.7 && messages.length <= MAX_MESSAGES) {
                return { messages, pruned: 0 };
            }
        } catch {
            if (messages.length <= MAX_MESSAGES) return { messages, pruned: 0 };
        }
    } else if (messages.length <= MAX_MESSAGES) {
        return { messages, pruned: 0 };
    }

    // Find a safe split index (must be a user message to avoid splitting tool calls/responses)
    const targetSplit = messages.length - PRUNE_KEEP_RECENT;
    let safeSplit = targetSplit;

    // Look backwards for the nearest user message to split at
    while (safeSplit > 0 && messages[safeSplit].role !== "user") {
        safeSplit--;
    }

    // If no user message was found backwards, look forwards (fallback)
    if (safeSplit === 0) {
        safeSplit = targetSplit;
        while (safeSplit < messages.length && messages[safeSplit].role !== "user") {
            safeSplit++;
        }
        if (safeSplit === messages.length) {
            safeSplit = targetSplit; // Complete fallback
        }
    }

    // Walk forward past any orphaned assistant+tool_calls block and its tool responses.
    // Splitting inside a tool exchange causes API rejections (tool_calls without responses).
    while (safeSplit < messages.length) {
        const msg = messages[safeSplit];
        if (msg.role === "assistant" && (msg as { tool_calls?: unknown[] }).tool_calls) {
            // Skip this assistant message and all following tool responses
            safeSplit++;
            while (safeSplit < messages.length && messages[safeSplit].role === "tool") {
                safeSplit++;
            }
        } else {
            break;
        }
    }
    // The no-user fallback above can leave the split on an orphaned tool response.
    safeSplit = avoidToolOrphan(messages, safeSplit);

    // Split into old messages (to summarize) and recent (to keep)
    const oldMessages = messages.slice(0, safeSplit);
    let recentMessages = messages.slice(safeSplit);

    // ── Auto-flush key facts from messages about to be pruned ──
    // One Haiku extraction call over the full window; fire-and-forget so its
    // latency doesn't stall the summary (and the turn waiting on it).
    flushToMemory(oldMessages, llm).catch((err) =>
        console.warn("[AUTO_FLUSH] failed (non-fatal):", (err as Error).message),
    );

    // Compress old tool outputs in the recent messages array
    recentMessages = compressToolHistory(recentMessages);

    // Summarize old messages via LLM
    const summaryText = oldMessages
        .map((m) => {
            const role = m.role;
            if (role === "tool") {
                const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
                return `tool (${m.tool_call_id}): ${content.substring(0, 100)}...`;
            }
            const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            return `${role}: ${content}`;
        })
        .join("\n");

    try {
        const summaryResponse = await llm.chat({
            messages: [
                {
                    role: "user",
                    content: buildCompressionUserPrompt(
                        summaryText,
                        getLastCompressionSummary(),
                        getSessionState()?.current_goal || undefined,
                    ),
                },
            ],
            systemPrompt: COMPRESSION_SYSTEM_PROMPT,
        });

        // Sanitize before this summary re-enters context as a system message —
        // the model may echo secrets from the transcript into the summary.
        const rawSummary = summaryResponse.choices[0]?.message?.content || "Previous conversation context.";
        const summary = sanitizeSecrets(rawSummary).sanitized;

        // Persist for the NEXT prune so numbering continues instead of cold-restarting.
        setLastCompressionSummary(summary);

        // Replace old messages with summary
        const prunedMessages: ChatCompletionMessageParam[] = [
            {
                role: "system" as const,
                content: `[Previous conversation summary]\n${summary}`,
            },
            ...recentMessages,
        ];

        return {
            messages: prunedMessages,
            pruned: oldMessages.length,
            summary,
        };
    } catch (err) {
        console.error("Context pruning failed:", err);
        // Fallback: just truncate
        return {
            messages: recentMessages,
            pruned: oldMessages.length,
        };
    }
}

// ── Compact (manual trigger) ──────────────────

export async function compactConversation(
    messages: ChatCompletionMessageParam[],
    llm: LLMClient,
): Promise<PruneResult> {
    if (messages.length <= 4) {
        return { messages, pruned: 0 };
    }

    // Force prune even if under limit
    let safeSplit = messages.length - Math.min(6, Math.floor(messages.length / 2));
    while (safeSplit > 0 && messages[safeSplit].role !== "user") safeSplit--;
    if (safeSplit === 0) safeSplit = 1; // At least keep 1
    safeSplit = avoidToolOrphan(messages, safeSplit); // never start `recent` on an orphaned tool response

    const oldMessages = messages.slice(0, safeSplit);
    let recentMessages = messages.slice(safeSplit);

    recentMessages = compressToolHistory(recentMessages);

    const summaryText = oldMessages
        .map((m) => {
            const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            return `${m.role}: ${content}`;
        })
        .join("\n");

    try {
        const summaryResponse = await llm.chat({
            messages: [
                {
                    role: "user",
                    content: `Summarize this conversation very concisely:\n\n${summaryText}`,
                },
            ],
            systemPrompt: "Summarize preserving key facts. Be very brief.",
        });

        const summary = summaryResponse.choices[0]?.message?.content || "Previous context.";

        return {
            messages: [{ role: "system" as const, content: `[Compacted context]\n${summary}` }, ...recentMessages],
            pruned: oldMessages.length,
            summary,
        };
    } catch {
        return { messages: recentMessages, pruned: oldMessages.length };
    }
}

// ── Compress Tool History ─────────────────────

/**
 * Converts old assistant tool_calls + tool responses into plain text
 * to save massive amounts of tokens while preserving context history.
 */
export function compressToolHistory(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
    const compressed: ChatCompletionMessageParam[] = [];

    // Free (zero-LLM) pre-pass: dedup identical tool results, truncate tool-call
    // args to valid JSON, smart-cut oversized tool results, and (opt-in) strip
    // historical image base64. Master gate for emergency rollback.
    const prepass = process.env.ATLAS_NO_HISTORY_PREPASS !== "true";
    const stripMedia = process.env.ATLAS_HISTORY_STRIP_MEDIA === "true";

    // Only compress up to the 2nd most recent user message's block.
    // Keep the absolute latest user turn untouched.
    let lastUserIndex = messages.length - 1;
    while (lastUserIndex >= 0 && messages[lastUserIndex].role !== "user") lastUserIndex--;

    // Build a tool_call_id → tool name map from every assistant tool_calls block
    // so each tool response can pick its tool-specific truncation strategy.
    const idToName = new Map<string, string>();
    for (const m of messages) {
        const calls = (m as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> })
            .tool_calls;
        if (calls) {
            for (const tc of calls) idToName.set(tc.id, tc.function.name);
        }
    }

    // Dedup state: sha256(content).slice(0,12) → first tool_call_id that produced it.
    const seenHashes = new Map<string, string>();

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        // Reached the active turn? Just copy everything verbatim from here on
        if (i >= lastUserIndex) {
            compressed.push(msg);
            continue;
        }

        // Media strip (opt-in, default-OFF): replace historical image_url base64
        // parts with a text placeholder. Tail messages are never reached here, so
        // the active turn's images survive.
        if (prepass && stripMedia && Array.isArray(msg.content)) {
            const parts = msg.content as unknown as Array<Record<string, unknown>>;
            const rewritten = parts.map((part) =>
                part && part.type === "image_url" ? { type: "text", text: "[image omitted from history]" } : part,
            );
            compressed.push({ ...msg, content: rewritten as unknown as string });
            continue;
        }

        // If it's an assistant message with tool calls, compress it into a system message
        // (role:system is never echoed back by the LLM in its reply, preventing leakage)
        if (msg.role === "assistant" && msg.tool_calls) {
            let toolSummary = (msg.content ? msg.content + "\n\n" : "") + "[Tools Used]:\n";
            msg.tool_calls.forEach((tc) => {
                let argStr = tc.function.arguments;
                if (prepass) {
                    // Parse → prune long string values → re-stringify so args stay
                    // valid JSON (providers 400 on malformed tool_call arguments).
                    // Fail-open: unparseable args fall back to a strategy char-cut.
                    try {
                        argStr = JSON.stringify(pruneJsonValues(JSON.parse(tc.function.arguments), 200));
                    } catch {
                        argStr = smartTruncate(tc.function.name, tc.function.arguments, 500);
                    }
                }
                toolSummary += `- ${tc.function.name}(${argStr})\n`;
            });
            compressed.push({ role: "system", content: toolSummary.trim() });
            continue;
        }

        // If it's a tool response, compress it severely into a system message
        // Use <tool_log> tags so sanitizeReply strips them if echoed back
        if (msg.role === "tool") {
            const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            const callId = msg.tool_call_id ?? "";

            if (prepass) {
                // Dedup: identical results back-reference the first occurrence.
                let hash = "";
                try {
                    hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
                } catch {
                    hash = "";
                }
                if (hash) {
                    const firstId = seenHashes.get(hash);
                    if (firstId) {
                        compressed.push({
                            role: "system",
                            content: `<tool_log call_id="${callId}">[duplicate of call ${firstId} — sha256:${hash}]</tool_log>`,
                        });
                        continue;
                    }
                    seenHashes.set(hash, callId);
                }

                // Smart, tool-aware cut (replaces the old flat 500-char head cut).
                // smartTruncate returns content unchanged when <= maxChars, so short
                // results stay byte-identical; unknown tools use the default head cut.
                const toolName = idToName.get(callId) ?? "";
                const cut = smartTruncate(toolName, content, 500);
                compressed.push({
                    role: "system",
                    content: `<tool_log call_id="${callId}">${cut}${cut.length < content.length ? "...(truncated)" : ""}</tool_log>`,
                });
                continue;
            }

            compressed.push({
                role: "system",
                content: `<tool_log call_id="${callId}">${content.substring(0, 500)}${content.length > 500 ? "...(truncated)" : ""}</tool_log>`,
            });
            continue;
        }

        compressed.push(msg);
    }

    // Merge consecutive system messages created by tool compression
    const merged: ChatCompletionMessageParam[] = [];
    for (const msg of compressed) {
        const last = merged[merged.length - 1];
        if (
            last &&
            last.role === "system" &&
            msg.role === "system" &&
            typeof last.content === "string" &&
            typeof msg.content === "string"
        ) {
            last.content = last.content + "\n" + msg.content;
        } else {
            merged.push(msg);
        }
    }

    return merged;
}
