// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { Channel, ProactiveMode } from "./intent.js";
import { getToneReminder } from "../setup/personality-sync.js";
import { getChannelSender, type ProactiveButton } from "../tools/channel-send.js";
import { isProactiveDisabled, isChannelDisabled, isShadowMode, debugProactive, isQuietNow } from "./kill-switches.js";

// Fatigue-check hook: true after two unanswered sends (notification-tracker's
// isFatigued). Default = null (no check), registered at boot.
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
 * While the owner leaves nudges unanswered, only FYIs and `bypassFatigue` sends
 * (deadlines, reminders they asked for) go out; while they've said "not now" or
 * it's a serious moment, only `bypassFatigue` ones.
 */
export async function dispatchProactiveMessage(
    channel: Channel,
    text: string,
    mode: ProactiveMode,
    buttons?: ProactiveButton[],
    ownerOnly = false,
    /** A deadline or a reminder the owner asked for: never held back for "too many unanswered nudges". */
    bypassFatigue = false,
): Promise<boolean> {
    if (isProactiveDisabled()) {
        debugProactive("suppressed_global", { channel, mode });
        return false;
    }
    if (isChannelDisabled(channel)) {
        debugProactive("suppressed_channel", { channel, mode });
        return false;
    }
    if (isQuietNow() && !bypassFatigue) {
        debugProactive("suppressed_quiet", { channel, mode }); // "not now", a serious moment
        return false;
    }
    if (_fatigueCheck !== null && !bypassFatigue && mode !== "fyi") {
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
    // Never for owner-only text: push subscriptions aren't owner-gated (the web widget can subscribe).
    if (channel === "overlay" && !ownerOnly) {
        import("../notifications/push.js")
            .then(({ getSubscriptionCount, sendPushNotification }) =>
                getSubscriptionCount() > 0 ? sendPushNotification("Bhai", text.slice(0, 180)) : undefined,
            )
            .catch(() => {});
    }
    return true;
}
