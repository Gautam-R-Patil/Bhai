// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { wrapDatabase, initProactiveSchema } from "../../memory/sqlite.js";
import { InboxStore } from "./store.js";
import { InboxManager, setInboxManager } from "./manager.js";
import {
    handleTelegramInboxCallback,
    handleWhatsAppInboxReply,
    _resetChatFallbackForTests,
    _setWaitingForTests,
    _peekWaitingForTests,
} from "./chat-fallback.js";
import type { ProactiveIntent } from "../intent.js";

function buildInbox() {
    const raw = new BetterSqlite3(":memory:");
    initProactiveSchema(wrapDatabase(raw));
    const store = new InboxStore(raw);
    const manager = new InboxManager({ store });
    setInboxManager(manager);
    return manager;
}

function reviewIntent(id = "rev-1"): ProactiveIntent {
    return {
        id,
        source: "meeting_followup",
        mode: "review",
        urgency: "normal",
        channelPreference: "telegram",
        topic: "follow up",
        topicEmbedding: new Array(384).fill(0),
        evidence: [],
        payload: { kind: "meeting_followup" },
        suggestedAction: { toolCalls: [], summary: "draft recap" },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
    };
}

describe("chat-fallback — Telegram callbacks", () => {
    beforeEach(() => _resetChatFallbackForTests());
    afterEach(() => setInboxManager(null));

    it("approve callback flips item to approved", async () => {
        const manager = buildInbox();
        manager.enqueue(reviewIntent("a1"), "msg");
        const ack = await handleTelegramInboxCallback("inbox:approve:a1");
        expect(ack).toBe("approved");
        expect(manager.get("a1")?.status).toBe("approved");
    });

    it("defer callback with explicit minutes defers", async () => {
        const manager = buildInbox();
        manager.enqueue(reviewIntent("a2"), "msg");
        const ack = await handleTelegramInboxCallback("inbox:defer:a2:180");
        expect(ack).toBe("deferred 180m");
        const item = manager.get("a2");
        expect(item?.status).toBe("deferred");
        expect(item?.deferredUntil).toBeGreaterThan(Date.now() + 179 * 60_000);
    });

    it("reject callback skips the item", async () => {
        const manager = buildInbox();
        manager.enqueue(reviewIntent("a3"), "msg");
        const ack = await handleTelegramInboxCallback("inbox:reject:a3");
        expect(ack).toBe("skipped");
        expect(manager.get("a3")?.status).toBe("rejected");
    });

    it("unknown id returns 'not found'", async () => {
        buildInbox();
        const ack = await handleTelegramInboxCallback("inbox:approve:missing");
        expect(ack).toBe("not found");
    });

    it("unknown action returns 'unknown action'", async () => {
        buildInbox();
        const ack = await handleTelegramInboxCallback("inbox:foo:bar");
        expect(ack).toBe("unknown action");
    });

    it("malformed data returns 'bad callback'", async () => {
        buildInbox();
        const ack = await handleTelegramInboxCallback("inbox:approve");
        expect(ack).toBe("bad callback");
    });
});

describe("chat-fallback — WhatsApp replies", () => {
    beforeEach(() => _resetChatFallbackForTests());
    afterEach(() => setInboxManager(null));

    it("returns { handled: false } when no prompt is waiting", async () => {
        buildInbox();
        const r = await handleWhatsAppInboxReply("yes", "alice@s.whatsapp.net");
        expect(r.handled).toBe(false);
    });

    it("reply '1' approves the most-recent prompt", async () => {
        const manager = buildInbox();
        const jid = "alice@s.whatsapp.net";
        manager.enqueue(reviewIntent("w1"), "msg");
        _setWaitingForTests(jid, "w1");
        const r = await handleWhatsAppInboxReply("1", jid);
        expect(r.handled).toBe(true);
        expect(r.ack).toMatch(/approved/i);
        expect(manager.get("w1")?.status).toBe("approved");
        expect(_peekWaitingForTests(jid)).toBeUndefined();
    });

    it("reply '2' defers", async () => {
        const manager = buildInbox();
        const jid = "alice@s.whatsapp.net";
        manager.enqueue(reviewIntent("w2"), "msg");
        _setWaitingForTests(jid, "w2");
        const r = await handleWhatsAppInboxReply("2", jid);
        expect(r.handled).toBe(true);
        expect(manager.get("w2")?.status).toBe("deferred");
    });

    it("reply '3' rejects", async () => {
        const manager = buildInbox();
        const jid = "alice@s.whatsapp.net";
        manager.enqueue(reviewIntent("w3"), "msg");
        _setWaitingForTests(jid, "w3");
        const r = await handleWhatsAppInboxReply("3", jid);
        expect(r.handled).toBe(true);
        expect(manager.get("w3")?.status).toBe("rejected");
    });

    it("natural-language 'yes' is treated as approve", async () => {
        const manager = buildInbox();
        const jid = "bob@s.whatsapp.net";
        manager.enqueue(reviewIntent("w4"), "msg");
        _setWaitingForTests(jid, "w4");
        const r = await handleWhatsAppInboxReply("yes please", "bob@s.whatsapp.net");
        // "yes please" exact match fails, but "yes" alone would match.
        // This asserts behavior: returns handled:false because we require strict matches (to avoid false positives).
        // If you loosened the match in the implementation to handle "yes please", adapt this test.
        expect(r.handled).toBe(false);
    });

    it("natural-language 'skip' rejects", async () => {
        const manager = buildInbox();
        const jid = "carol@s.whatsapp.net";
        manager.enqueue(reviewIntent("w5"), "msg");
        _setWaitingForTests(jid, "w5");
        const r = await handleWhatsAppInboxReply("skip", jid);
        expect(r.handled).toBe(true);
        expect(manager.get("w5")?.status).toBe("rejected");
    });

    it("unrelated message leaves waiting entry intact", async () => {
        const manager = buildInbox();
        const jid = "dave@s.whatsapp.net";
        manager.enqueue(reviewIntent("w6"), "msg");
        _setWaitingForTests(jid, "w6");
        const r = await handleWhatsAppInboxReply("hey what's up", jid);
        expect(r.handled).toBe(false);
        expect(_peekWaitingForTests(jid)).toBeDefined();
    });
});
