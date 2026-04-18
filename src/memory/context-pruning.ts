// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import { remember } from "./sqlite.js";

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

// ── Auto-Flush: Save Key Facts Before Pruning ─

/**
 * Extract significant content from messages about to be pruned and
 * persist them as memories. Prevents information loss during long
 * conversations when older messages are removed.
 *
 * Non-blocking: fires remember() calls without awaiting, using .catch()
 * to swallow errors silently.
 */
function flushToMemory(messages: ChatCompletionMessageParam[]): void {
    try {
        let flushed = 0;
        for (const msg of messages) {
            // Only flush user messages and tool results with substantive content
            if (msg.role !== "user" && msg.role !== "tool") continue;

            const text = typeof msg.content === "string"
                ? msg.content
                : (Array.isArray(msg.content)
                    ? msg.content.filter((p) => typeof p === "object" && p !== null && "type" in p && (p as any).type === "text").map(p => (p as any).text as string).join(" ")
                    : JSON.stringify(msg.content));

            // Skip short/trivial content (greetings, acknowledgements, etc.)
            if (!text || text.length < 50) continue;

            // Skip content that looks like pure tool JSON or system noise
            if (text.startsWith("{") && text.endsWith("}")) continue;
            if (text.startsWith("<tool_log") || text.startsWith("<system_log")) continue;

            // Truncate very long content to a reasonable summary length
            const content = text.length > 500
                ? text.substring(0, 497) + "..."
                : text;

            const prefix = msg.role === "tool" ? "[tool result] " : "";

            // Non-blocking fire-and-forget
            try {
                remember(
                    `${prefix}${content}`,
                    "auto_flush",
                    "context_pruning,auto",
                    5,  // moderate importance
                    "tool"
                );
                flushed++;
            } catch { /* remember() failure non-fatal */ }
        }

        if (flushed > 0) {
            console.log(`  [AUTO_FLUSH] Saved ${flushed} facts from pruned messages to memory`);
        }
    } catch (err) {
        // Entire flush pipeline failed — pruning proceeds regardless
        console.warn("[AUTO_FLUSH] Failed (non-fatal):", (err as Error).message);
    }
}

// ── Prune Context ─────────────────────────────

export async function pruneContext(
    messages: ChatCompletionMessageParam[],
    llm: LLMClient
): Promise<PruneResult> {
    if (messages.length <= MAX_MESSAGES) {
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

    // Split into old messages (to summarize) and recent (to keep)
    const oldMessages = messages.slice(0, safeSplit);
    let recentMessages = messages.slice(safeSplit);

    // ── Auto-flush key facts from messages about to be pruned ──
    // Non-blocking: runs synchronously but remember() itself is fire-and-forget for embeddings
    flushToMemory(oldMessages);

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
                    content: `Summarize this conversation concisely, preserving key facts, decisions, and context:\n\n${summaryText}`,
                },
            ],
            systemPrompt: "You are a conversation summarizer. Be concise but preserve all important details, decisions, and facts.",
        });

        const summary = summaryResponse.choices[0]?.message?.content || "Previous conversation context.";

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
    llm: LLMClient
): Promise<PruneResult> {
    if (messages.length <= 4) {
        return { messages, pruned: 0 };
    }

    // Force prune even if under limit
    let safeSplit = messages.length - Math.min(6, Math.floor(messages.length / 2));
    while (safeSplit > 0 && messages[safeSplit].role !== "user") safeSplit--;
    if (safeSplit === 0) safeSplit = 1; // At least keep 1

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
            messages: [
                { role: "system" as const, content: `[Compacted context]\n${summary}` },
                ...recentMessages,
            ],
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

    // Only compress up to the 2nd most recent user message's block.
    // Keep the absolute latest user turn untouched.
    let lastUserIndex = messages.length - 1;
    while (lastUserIndex >= 0 && messages[lastUserIndex].role !== "user") lastUserIndex--;

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        // Reached the active turn? Just copy everything verbatim from here on
        if (i >= lastUserIndex) {
            compressed.push(msg);
            continue;
        }

        // If it's an assistant message with tool calls, compress it into a system message
        // (role:system is never echoed back by the LLM in its reply, preventing leakage)
        if (msg.role === "assistant" && msg.tool_calls) {
            let toolSummary = (msg.content ? msg.content + "\n\n" : "") + "[Tools Used]:\n";
            msg.tool_calls.forEach(tc => {
                toolSummary += `- ${tc.function.name}(${tc.function.arguments})\n`;
            });
            compressed.push({ role: "system", content: toolSummary.trim() });
            continue;
        }

        // If it's a tool response, compress it severely into a system message
        // Use <tool_log> tags so sanitizeReply strips them if echoed back
        if (msg.role === "tool") {
            const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            compressed.push({ role: "system", content: `<tool_log call_id="${msg.tool_call_id}">${content.substring(0, 500)}${content.length > 500 ? "...(truncated)" : ""}</tool_log>` });
            continue;
        }

        compressed.push(msg);
    }

    // Merge consecutive system messages created by tool compression
    const merged: ChatCompletionMessageParam[] = [];
    for (const msg of compressed) {
        const last = merged[merged.length - 1];
        if (last && last.role === "system" && msg.role === "system" &&
            typeof last.content === "string" && typeof msg.content === "string") {
            last.content = last.content + "\n" + msg.content;
        } else {
            merged.push(msg);
        }
    }

    return merged;
}
