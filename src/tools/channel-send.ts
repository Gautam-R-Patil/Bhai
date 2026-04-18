// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Cross-Channel Messaging Tool ────────────────
// Lets the agent send messages to the user on ANY active channel.
// Example: User asks on WhatsApp "send me a hi on Telegram" -> agent uses this tool.

import type { ToolDefinition } from "./get-current-time.js";

// ── Channel send function registry (populated at boot by each channel) ──
type ChannelSendFn = (message: string, filePath?: string) => Promise<void>;
const channelSenders = new Map<string, ChannelSendFn>();

/**
 * Register a channel's send function. Called at boot from each channel module.
 */
export function registerChannelSender(channel: string, sendFn: ChannelSendFn): void {
    channelSenders.set(channel, sendFn);
}

/**
 * Get list of channels that have registered senders.
 */
export function getActiveChannelSenders(): string[] {
    return Array.from(channelSenders.keys());
}

// ── Tool Definition ──────────────────────────────

export const channelSendTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "send_message_on_channel",
            description: "Send a message to the user on a specific communication channel (Telegram, WhatsApp, Discord, Slack, Email, Matrix, or Overlay). Use this when the user asks you to message them on a different channel than the one they're currently talking to you on. For example, if the user is on WhatsApp and says 'send me a hi on Telegram', use this tool with channel='telegram'.",
            parameters: {
                type: "object",
                properties: {
                    channel: {
                        type: "string",
                        description: "The channel to send the message on. Options: telegram, whatsapp, discord, slack, email, matrix, overlay",
                        enum: ["telegram", "whatsapp", "discord", "slack", "email", "matrix", "overlay"],
                    },
                    message: {
                        type: "string",
                        description: "The message text to send",
                    },
                    file_path: {
                        type: "string",
                        description: "Optional: path to a file to send along with the message",
                    },
                },
                required: ["channel", "message"],
            },
        },
    },
    handler: async (input: Record<string, unknown>) => {
        const channel = (input.channel as string || "").toLowerCase();
        const message = input.message as string || "";
        const filePath = input.file_path as string | undefined;

        if (!message) {
            return JSON.stringify({ error: "Message text is required" });
        }

        const sender = channelSenders.get(channel);
        if (!sender) {
            const available = getActiveChannelSenders();
            if (available.length === 0) {
                return JSON.stringify({ error: "No channels are currently active" });
            }
            return JSON.stringify({
                error: `Channel "${channel}" is not active or not configured. Available channels: ${available.join(", ")}`,
            });
        }

        try {
            await sender(message, filePath);
            return JSON.stringify({
                success: true,
                channel,
                message: `Message sent on ${channel}`,
            });
        } catch (err) {
            return JSON.stringify({
                error: `Failed to send on ${channel}: ${(err as Error).message}`,
            });
        }
    },
};
