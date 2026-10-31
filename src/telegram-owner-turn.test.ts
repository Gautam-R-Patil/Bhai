// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The owner's private conversation stays in the owner's private chat: a group or guest turn
// never runs on it, even when it starts while another turn is still running.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

process.env.BHAI_DATA_DIR = mkdtempSync(join(tmpdir(), "tg-owner-turn-"));
const { getConversationHistory } = await import("./agent.js");
const { historyForCaller } = await import("./guest-history.js");
const { concurrentHistoryFork, isOwnerPrivateChat } = await import("./telegram.js");

it("overnight results go only to the owner's private chat", () => {
    const owners = new Set([111]);
    expect(isOwnerPrivateChat(owners, 111, "private")).toBe(true);
    expect(isOwnerPrivateChat(owners, 111, "group")).toBe(false);
    expect(isOwnerPrivateChat(owners, 222, "private")).toBe(false);
    expect(isOwnerPrivateChat(owners, undefined, "private")).toBe(false);
});

it("a concurrent guest or group turn does not get the owner's history", () => {
    getConversationHistory().push({ role: "user", content: "my bank PIN reminder is in the blue notebook" });
    const guest = historyForCaller(concurrentHistoryFork(true, false), {
        isOwner: false,
        channel: "telegram",
        userId: "222",
    });
    expect(JSON.stringify(guest)).not.toContain("blue notebook");
    expect(JSON.stringify(concurrentHistoryFork(true, true))).toContain("blue notebook");
    expect(concurrentHistoryFork(false, true)).toBeUndefined();
});
