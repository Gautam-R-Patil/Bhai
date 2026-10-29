// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../tools/google-api.js", () => ({
    listStaleEmailsRaw: vi.fn(async () => [
        {
            id: "msg1",
            from: "Alice <alice@example.com>",
            subject: "Action needed",
            received_ms: 1746700000000,
            is_important: true,
            thread_msg_count: 3,
        },
        {
            id: "msg2",
            from: "newsletter@promo.com",
            subject: "Deals of the week",
            received_ms: 1746600000000,
            is_important: false,
            thread_msg_count: 1,
        },
    ]),
    getEngagedSenders: vi.fn(async () => ["alice@example.com", "bob@work.org"]),
}));

import { fetchStaleEmails, _resetGmailStaleCache } from "./gmail-stale-fetch.js";
import { listStaleEmailsRaw, getEngagedSenders } from "../../../tools/google-api.js";

describe("gmail-stale-fetch", () => {
    beforeEach(() => {
        _resetGmailStaleCache();
        vi.mocked(listStaleEmailsRaw).mockClear();
        vi.mocked(getEngagedSenders).mockClear();
    });

    it("returns stale emails with Rust-shaped fields", async () => {
        const { stale } = await fetchStaleEmails();
        expect(stale).toHaveLength(2);
        expect(stale[0].id).toBe("msg1");
        expect(stale[0].from).toBe("Alice <alice@example.com>");
        expect(stale[0].subject).toBe("Action needed");
        expect(stale[0].receivedMs).toBe(1746700000000);
        expect(stale[0].isImportant).toBe(true);
        expect(stale[0].threadMsgCount).toBe(3);
    });

    it("returns engaged senders list", async () => {
        const { engaged_senders } = await fetchStaleEmails();
        expect(engaged_senders).toContain("alice@example.com");
        expect(engaged_senders).toContain("bob@work.org");
    });

    it("caches within TTL — only one API call", async () => {
        await fetchStaleEmails();
        await fetchStaleEmails();
        expect(listStaleEmailsRaw).toHaveBeenCalledTimes(1);
        expect(getEngagedSenders).toHaveBeenCalledTimes(1);
    });

    it("maps snake_case API fields to camelCase Rust fields", async () => {
        const { stale } = await fetchStaleEmails();
        expect(stale[1].isImportant).toBe(false);
        expect(stale[1].threadMsgCount).toBe(1);
        expect(stale[1].receivedMs).toBe(1746600000000);
    });

    it("graceful-empty when APIs return nothing", async () => {
        vi.mocked(listStaleEmailsRaw).mockResolvedValueOnce([]);
        vi.mocked(getEngagedSenders).mockResolvedValueOnce([]);
        const result = await fetchStaleEmails();
        expect(result.stale).toHaveLength(0);
        expect(result.engaged_senders).toHaveLength(0);
    });
});
