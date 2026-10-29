// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { Channel, ProactiveMode } from "./intent.js";
import { getToneReminder } from "../setup/personality-sync.js";
import { getChannelSender, type ProactiveButton } from "../tools/channel-send.js";
import { isProactiveDisabled, isChannelDisabled, isShadowMode, debugProactive } from "./kill-switches.js";

// Fatigue-check hook. Returns true when the user shows signs of
// notification fatigue (e.g. low engagement rate over recent sends).
// Default = null (no check), set by notification-tracker at boot.
type FatigueCheck = () => boolean;
let _fatigueCheck: FatigueCheck | null = null;

export function registerFatigueCheck(fn: FatigueCheck): void {
    _fatigueCheck = fn;
}

export function _setFatigueCheckForTests(fn: FatigueCheck | null): void {
    _fatigueCheck = fn;
}

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
 * Resolves true only when the message was actually sent. An `ownerOnly` message
 * quotes the owner's memory: owners' private chats only, and no preview in the logs.
 */
export async function dispatchProactiveMessage(
    channel: Channel,
    text: string,
    mode: ProactiveMode,
    buttons?: ProactiveButton[],
    ownerOnly = false,
): Promise<boolean> {
    if (isProactiveDisabled()) {
        debugProactive("suppressed_global", { channel, mode });
        return false;
    }
    if (isChannelDisabled(channel)) {
        debugProactive("suppressed_channel", { channel, mode });
        return false;
    }
    if (_fatigueCheck !== null) {
        try {
            if (_fatigueCheck()) {
                debugProactive("suppressed_fatigue", { channel, mode });
                return false;
            }
        } catch {
            // Fail open — a broken fatigue check should never block sends.
        }
    }
    const sender = getChannelSender(channel);
    if (!sender) {
        throw new Error(`no sender registered for channel: ${channel}`);
    }
    // Professional and Direct presets say "no emoji"; the prefix is one too.
    const plain = /PROFESSIONAL|DIRECT/.test(getToneReminder() ?? "");
    const prefixed = PREFIXED_CHANNELS.includes(channel) && !plain ? `${EMOJI[mode]} ${text}` : text;
    const preview = ownerOnly ? {} : { preview: prefixed.slice(0, 80) };
    if (isShadowMode()) {
        debugProactive("shadow_dispatch", { channel, mode, ...preview });
        return false;
    }
    if ((await sender(prefixed, undefined, buttons, ownerOnly)) === false) {
        debugProactive("suppressed_sender", { channel, mode });
        return false;
    }
    debugProactive("dispatched", { channel, mode, ...preview });
    // Push subscribers follow the overlay. The push mirrors what was delivered — composed, past
    // every gate above — never the raw thought (heartbeat used to push it regardless of
    // "shut up", the kill switches, shadow mode or the night window).
    if (channel === "overlay") {
        import("../notifications/push.js")
            .then(({ getSubscriptionCount, sendPushNotification }) =>
                getSubscriptionCount() > 0 ? sendPushNotification("Bhai", text.slice(0, 180)) : undefined,
            )
            .catch(() => {});
    }
    return true;
}
