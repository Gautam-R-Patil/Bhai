// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { listStaleEmailsRaw, getEngagedSenders } from "../../../tools/google-api.js";
import type { EmailSummary } from "../../../../native/index.js";

const TTL_MS = 30 * 60_000;

export type StaleEmailFetchResult = {
    stale: EmailSummary[];
    engaged_senders: string[];
};

let cache: { result: StaleEmailFetchResult; expires: number } | null = null;

export async function fetchStaleEmails(): Promise<StaleEmailFetchResult> {
    if (cache && cache.expires > Date.now()) return cache.result;
    const [rawStale, engaged] = await Promise.all([
        listStaleEmailsRaw(),
        getEngagedSenders(),
    ]);
    const stale: EmailSummary[] = rawStale.map(e => ({
        id: e.id,
        from: e.from,
        subject: e.subject,
        receivedMs: e.received_ms,
        isImportant: e.is_important,
        threadMsgCount: e.thread_msg_count,
    }));
    const result: StaleEmailFetchResult = { stale, engaged_senders: engaged };
    cache = { result, expires: Date.now() + TTL_MS };
    return result;
}

export function _resetGmailStaleCache(): void {
    cache = null;
}
