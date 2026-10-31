// © 2024-2026 TRUSCOR Private Limited. All rights reserved.

/**
 * Deliver on the first chat channel that takes it: the primary, then the others in
 * order. Reminders went to every connected channel at once ("backup" sends always
 * fired), so one reminder buzzed Telegram, WhatsApp and Discord together.
 * Returns the channel that delivered, or null when none did.
 */
export async function deliverOnFirst(
    primary: string,
    senders: Record<string, () => Promise<unknown>>,
): Promise<string | null> {
    const order = [primary, ...Object.keys(senders).filter((c) => c !== primary)];
    for (const channel of order) {
        const send = senders[channel];
        if (!send) continue;
        try {
            if ((await send()) !== false) return channel;
        } catch {
            /* try the next one */
        }
    }
    return null;
}

/** Why Telegram polling stopped, in the owner's terms. */
export function telegramStopReason(message: string): string {
    if (/\b401\b|Unauthorized/i.test(message)) return "its bot token no longer works (revoked or replaced) — reconnect it in Channels → Telegram";
    if (/\b409\b|Conflict/i.test(message)) return "another copy of Bhai is already using this Telegram bot";
    return message.slice(0, 160);
}
