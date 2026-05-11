// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// -- Slack Bot Channel ------------------------------------
// Socket Mode Slack bot (no public URL needed).
// Handles @mentions and DMs, threads long conversations,
// formats with Block Kit, and processes file uploads.

import { App, type SayFn } from "@slack/bolt";
import type { LLMClient } from "./llm.js";
import { runAgent, type MediaAttachment, type ChannelContext } from "./agent.js";
import { classifyQuery } from "./memory/classifier.js";

// -- State ------------------------------------------------

let slackApp: App | null = null;

// Track active threads to avoid duplicate processing
const activeThreads = new Set<string>();

// -- Initialize -------------------------------------------

/**
 * Initialize the Slack bot. Requires SLACK_BOT_TOKEN and SLACK_APP_TOKEN env vars.
 * Uses Socket Mode so no public URL is needed.
 */
function parseSlackAllowedUsers(): Set<string> {
    const raw = process.env.SLACK_ALLOWED_USER_IDS;
    if (!raw) return new Set();
    return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

export async function initSlack(llm: LLMClient): Promise<void> {
    const botToken = process.env.SLACK_BOT_TOKEN;
    const appToken = process.env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
        console.warn("[SLACK] Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN -- Slack disabled");
        return;
    }

    const allowedUsers = parseSlackAllowedUsers();
    if (allowedUsers.size === 0) {
        console.warn("[SLACK] SLACK_ALLOWED_USER_IDS is unset/empty -- Slack will accept NO messages until you populate it. Slack workspaces have hundreds of users; an open whitelist would let any of them drive the agent.");
    }
    const isAllowed = (userId: string | undefined | null) =>
        !!userId && allowedUsers.has(userId);

    slackApp = new App({
        token: botToken,
        appToken: appToken,
        socketMode: true,
    });

    // -- Handle @mentions in channels --
    slackApp.event("app_mention", async ({ event, say }) => {
        if (!isAllowed(event.user)) {
            console.log(`[SLACK] Ignored @mention from non-allowlisted user: ${event.user}`);
            return;
        }
        const text = stripMention(event.text);
        const threadTs = event.thread_ts || event.ts;

        if (!text.trim()) return;
        console.log(`\n[SLACK] @mention from ${event.user}: ${text.substring(0, 120)}`);

        // Check for file attachments
        const media = await extractMedia(event as unknown as Record<string, unknown>);

        await handleSlackMessage(llm, text, say, threadTs, event.channel, media, event.user || "");
    });

    // -- Handle direct messages --
    slackApp.event("message", async ({ event, say }) => {
        // Only handle DMs (channel type "im") and skip bot messages
        const msg = event as unknown as Record<string, unknown>;
        if (msg.channel_type !== "im") return;
        if (msg.bot_id || msg.subtype) return;
        const userId = msg.user as string | undefined;
        if (!isAllowed(userId)) {
            console.log(`[SLACK] Ignored DM from non-allowlisted user: ${userId}`);
            return;
        }

        const text = (msg.text as string) || "";
        const threadTs = (msg.thread_ts as string) || (msg.ts as string);

        if (!text.trim()) return;
        console.log(`\n[SLACK] DM from ${msg.user}: ${text.substring(0, 120)}`);

        const media = await extractMedia(msg);

        await handleSlackMessage(llm, text, say, threadTs, msg.channel as string, media, (msg.user as string) || "");
    });

    // Start the bot
    await slackApp.start();
    console.log("[SLACK] Slack bot connected (Socket Mode)");
}

// -- Core Message Handler ---------------------------------

async function handleSlackMessage(
    llm: LLMClient,
    text: string,
    say: SayFn,
    threadTs: string,
    channel: string,
    media?: MediaAttachment[],
    slackUserId?: string,
): Promise<void> {
    const threadKey = `${channel}:${threadTs}`;

    // Prevent duplicate processing of same thread
    if (activeThreads.has(threadKey)) {
        console.log(`[SLACK] Skipping duplicate for thread ${threadTs}`);
        return;
    }
    activeThreads.add(threadKey);

    try {
        // Send initial typing indicator via a placeholder message
        const modelHint = !media && classifyQuery(text) === "llm_only" ? "simple" as const : undefined;
        const taggedMessage = `${text}\n\n[SOURCE: Slack — respond here. Keep response clear and well-formatted.]`;

        // Progress callback -- update thread with status
        let statusMessageTs: string | null = null;
        const onProgress = async (msg: string) => {
            // Skip internal thinking progress
            if (msg.startsWith("[THINKING] ")) return;

            const progressText = msg.replace(/<[^>]+>/g, "").substring(0, 100);
            if (!progressText) return;

            try {
                if (!statusMessageTs) {
                    const result = await say({
                        text: progressText,
                        thread_ts: threadTs,
                    });
                    statusMessageTs = (result as { ts?: string })?.ts || null;
                } else if (slackApp) {
                    await slackApp.client.chat.update({
                        channel,
                        ts: statusMessageTs,
                        text: progressText,
                    });
                }
            } catch {
                // Status update failed -- non-fatal
            }
        };

        const result = await runAgent(llm, taggedMessage, onProgress, media, undefined, undefined, modelHint, undefined, { channel: "slack", userId: slackUserId || "", userName: undefined, isOwner: true });

        // Clean the response
        const cleanText = result.text
            .replace(/<system_log>[\s\S]*?<\/system_log>/g, "")
            .replace(/<tool_log[\s\S]*?<\/tool_log>/g, "")
            .replace(/\[Tool Result [^\]]+\]:[\s\S]*?(?=\n\n|\n[A-Z]|$)/g, "")
            .replace(/\[SOURCE:.*?\]/gs, "")
            .replace(/\[no_reply\]/gi, "")
            .trim();

        if (!cleanText || cleanText === "[NO_REPLY]") {
            // Delete status message if response is empty
            if (statusMessageTs && slackApp) {
                try {
                    await slackApp.client.chat.delete({ channel, ts: statusMessageTs });
                } catch { /* */ }
            }
            return;
        }

        // Delete progress/status message before sending final response
        if (statusMessageTs && slackApp) {
            try {
                await slackApp.client.chat.delete({ channel, ts: statusMessageTs });
            } catch { /* may already be deleted */ }
        }

        // Format and send response using Block Kit
        const blocks = formatBlockKit(cleanText);

        // Slack has a 3000 char limit per text block -- split if needed
        if (cleanText.length <= 3000) {
            await say({
                blocks,
                text: cleanText, // Fallback for notifications
                thread_ts: threadTs,
            });
        } else {
            // Split into chunks
            const chunks = splitSlackMessage(cleanText, 3000);
            for (const chunk of chunks) {
                await say({
                    blocks: formatBlockKit(chunk),
                    text: chunk,
                    thread_ts: threadTs,
                });
            }
        }

        console.log(`[SLACK] Responded (${result.toolCalls} tool calls, ${cleanText.length} chars)`);
    } catch (err) {
        console.error("[SLACK] Error handling message:", (err as Error).message);
        try {
            await say({
                text: "Sorry, something went wrong processing that. Please try again.",
                thread_ts: threadTs,
            });
        } catch { /* */ }
    } finally {
        activeThreads.delete(threadKey);
    }
}

// -- Block Kit Formatting ---------------------------------

interface SlackBlock {
    type: string;
    text?: { type: string; text: string };
    elements?: Array<{ type: string; text: string }>;
}

/**
 * Convert markdown-ish text to Slack Block Kit blocks.
 * Supports: section text, code blocks, dividers.
 */
function formatBlockKit(text: string): SlackBlock[] {
    const blocks: SlackBlock[] = [];
    const parts = text.split(/(```[\s\S]*?```)/g);

    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        // Code block
        if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
            const code = trimmed.slice(3, -3).replace(/^\w+\n/, ""); // Strip language hint
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "```" + code + "```",
                },
            });
            continue;
        }

        // Check for horizontal rule / divider
        if (/^[-*_]{3,}$/.test(trimmed)) {
            blocks.push({ type: "divider" });
            continue;
        }

        // Regular text section (Slack mrkdwn is close enough to markdown)
        // Split if the section is too long for a single block
        if (trimmed.length <= 3000) {
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: trimmed,
                },
            });
        } else {
            const subParts = splitSlackMessage(trimmed, 3000);
            for (const sub of subParts) {
                blocks.push({
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: sub,
                    },
                });
            }
        }
    }

    // Slack requires at least one block
    if (blocks.length === 0) {
        blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: text.substring(0, 3000) },
        });
    }

    return blocks;
}

// -- Helpers ----------------------------------------------

/**
 * Strip the @mention from the message text.
 * Slack encodes mentions as <@UXXXXXXXX>.
 */
function stripMention(text: string): string {
    return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

/**
 * Extract media attachments from a Slack event.
 * Downloads files and converts to MediaAttachment format.
 */
async function extractMedia(event: Record<string, unknown>): Promise<MediaAttachment[] | undefined> {
    const files = event.files as Array<{
        url_private_download?: string;
        mimetype?: string;
        filetype?: string;
        name?: string;
    }> | undefined;

    if (!files || files.length === 0) return undefined;

    const media: MediaAttachment[] = [];
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) return undefined;

    for (const file of files.slice(0, 3)) { // Limit to 3 files
        const url = file.url_private_download;
        const mimeType = file.mimetype || "";

        if (!url) continue;

        // Only handle images and common document types
        const isImage = mimeType.startsWith("image/");
        const isDocument = mimeType === "application/pdf"
            || mimeType === "text/plain"
            || mimeType.includes("json")
            || mimeType.includes("javascript")
            || mimeType.includes("typescript");

        if (!isImage && !isDocument) continue;

        try {
            const response = await fetch(url, {
                headers: { Authorization: `Bearer ${botToken}` },
                signal: AbortSignal.timeout(30_000),
            });

            if (!response.ok) continue;

            const buffer = Buffer.from(await response.arrayBuffer());
            const base64 = buffer.toString("base64");

            if (isImage) {
                media.push({ type: "image", base64, mimeType });
                console.log(`[SLACK] Downloaded image: ${file.name} (${Math.round(buffer.length / 1024)}KB)`);
            }
            // Documents are handled as text context, not media attachments
            // The content will be included in the message text by the agent
        } catch (err) {
            console.warn(`[SLACK] Failed to download file ${file.name}:`, (err as Error).message);
        }
    }

    return media.length > 0 ? media : undefined;
}

/**
 * Split a long message into chunks at paragraph boundaries.
 */
function splitSlackMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLen) {
        // Try to split at double newline
        let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
        if (splitIdx <= 0) {
            // Try single newline
            splitIdx = remaining.lastIndexOf("\n", maxLen);
        }
        if (splitIdx <= 0) {
            // Force split at maxLen
            splitIdx = maxLen;
        }

        chunks.push(remaining.substring(0, splitIdx).trim());
        remaining = remaining.substring(splitIdx).trim();
    }

    if (remaining) chunks.push(remaining);
    return chunks;
}

// -- Send Proactive Message -------------------------------

/**
 * Send a proactive message to a Slack channel or DM.
 * Used by the heartbeat/notification system.
 */
export async function sendSlackProactiveMessage(message: string): Promise<void> {
    if (!slackApp) return;

    const channelId = process.env.SLACK_DEFAULT_CHANNEL;
    if (!channelId) return;

    try {
        const blocks = formatBlockKit(message);
        await slackApp.client.chat.postMessage({
            channel: channelId,
            blocks,
            text: message,
        });
    } catch (err) {
        console.error("[SLACK] Failed to send proactive message:", (err as Error).message);
    }
}

// -- Cleanup ----------------------------------------------

export function getSlackStatus(): string {
    if (!slackApp) return "disabled";
    return "connected";
}

export function closeSlack(): void {
    if (slackApp) {
        slackApp.stop().catch(() => { /* */ });
        slackApp = null;
        console.log("[SLACK] Slack bot disconnected");
    }
}
