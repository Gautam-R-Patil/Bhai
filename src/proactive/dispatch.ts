// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { Channel, ProactiveMode } from "./intent.js";
import { getChannelSender } from "../tools/channel-send.js";
import { isProactiveDisabled, isChannelDisabled, isShadowMode, debugProactive } from "./kill-switches.js";

const EMOJI: Record<ProactiveMode, string> = {
    fyi: "💡",
    question: "❓",
    review: "✅",
};

// Channels that receive a mode-emoji prefix (chat channels only — not overlay or email)
const PREFIXED_CHANNELS: Channel[] = ["whatsapp", "telegram", "discord", "slack", "matrix"];

/**
 * Single exit point for all proactive message sends.
 *
 * Applies kill-switch gates (global, per-channel, shadow mode), prepends a
 * mode emoji for chat channels (💡/❓/✅), and delegates to the sender
 * registered in the existing getChannelSender registry (tools/channel-send.ts).
 *
 * No separate registry — reuses what is already wired at boot.
 */
export async function dispatchProactiveMessage(
    channel: Channel,
    text: string,
    mode: ProactiveMode,
): Promise<void> {
    if (isProactiveDisabled()) {
        debugProactive("suppressed_global", { channel, mode });
        return;
    }
    if (isChannelDisabled(channel)) {
        debugProactive("suppressed_channel", { channel, mode });
        return;
    }
    const sender = getChannelSender(channel);
    if (!sender) {
        throw new Error(`no sender registered for channel: ${channel}`);
    }
    const prefixed = PREFIXED_CHANNELS.includes(channel)
        ? `${EMOJI[mode]} ${text}`
        : text;
    if (isShadowMode()) {
        debugProactive("shadow_dispatch", { channel, mode, preview: prefixed.slice(0, 80) });
        return;
    }
    await sender(prefixed);
    debugProactive("dispatched", { channel, mode, preview: prefixed.slice(0, 80) });
}
