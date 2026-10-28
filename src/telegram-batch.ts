// © 2024-2026 XAGI Labs Private Limited. All rights reserved.

/**
 * Debounce-buffer key for Telegram. One batch per (chat, sender): in a group,
 * merging senders would run everyone's text under whoever spoke last — a
 * non-owner's message could execute with owner privileges.
 */
export function batchKey(chatId: number, userId: number | undefined): string {
    return `${chatId}:${userId ?? 0}`;
}
