// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sendFailed } from "../../tools/send-ledger.js";
import { bhaiDidMemory, didLine } from "../bhai-did.js";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-bhai-did-"));

const owner = { isOwner: true, autonomous: false, stuck: false, secret: false, failed: false };

describe("bhai_did lines", () => {
    it("names the recipient and the thing, never the body or the address", () => {
        const msg = "mail Riya the Q3 deck, tell her the numbers look great";
        const line = didLine(
            "gmail",
            { action: "send", to: "riya.s@acme.com", subject: "Q3 deck", body: "the numbers look great" },
            msg,
        );
        expect(line).toBe('sent an email "Q3 deck" to Riya via Gmail');
        expect(didLine("whatsapp_send", { to: "+91 98200 12345", message: "running late" }, "text him")).toBe(
            "sent a message via WhatsApp",
        );
        expect(didLine("whatsapp_send", { to: "Mom", file_path: "/Users/me/Desktop/Q3-deck.pdf" }, "")).toBe(
            'sent the file "Q3 deck" to Mom via WhatsApp',
        );
        expect(
            didLine("google_calendar", { action: "create", title: "Dentist", start_time: "2026-10-12T15:00:00" }, ""),
        ).toBe('added "Dentist" to the owner\'s calendar for 2026-10-12 15:00');
    });

    it("drops sensitive labels and ignores reads", () => {
        expect(didLine("gmail", { action: "send", subject: "my password is hunter2" }, "")).toBe("sent an email via Gmail");
        expect(didLine("gmail", { action: "search", query: "Q3" }, "")).toBeUndefined();
        expect(didLine("calendar_tool", { action: "today" }, "")).toBeUndefined();
        expect(didLine("web_search", { query: "x" }, "")).toBeUndefined();
    });

    it("writes one dated line, only for the owner's own clean turn", () => {
        const lines = ["sent a message to Mom via WhatsApp", "sent a message to Mom via WhatsApp", "sent the owner a file"];
        expect(bhaiDidMemory(lines, owner, new Date(2026, 9, 12))).toBe(
            "On 12 Oct Bhai sent a message to Mom via WhatsApp; sent the owner a file",
        );
        expect(bhaiDidMemory([], owner)).toBeNull();
        for (const k of ["autonomous", "stuck", "secret", "failed"] as const) {
            expect(bhaiDidMemory(lines, { ...owner, [k]: true })).toBeNull();
        }
        expect(bhaiDidMemory(lines, { ...owner, isOwner: false })).toBeNull();
    });

    it("counts a send as done only when the ledger would", () => {
        expect(sendFailed("whatsapp_send", JSON.stringify({ success: true }))).toBe(false);
        expect(sendFailed("whatsapp_send", JSON.stringify({ error: "not connected" }))).toBe(true);
        expect(sendFailed("cold_outreach", JSON.stringify({ status: "sent", sentCount: 0 }))).toBe(true);
        expect(sendFailed("send_file", "File sent.")).toBe(false);
    });
});

describe("bhai_did rows", () => {
    let sqlite: typeof import("../sqlite.js");
    let cards: typeof import("../cards.js");
    beforeAll(async () => {
        sqlite = await import("../sqlite.js");
        cards = await import("../cards.js");
        await sqlite.initMemoryDB();
    });

    it("are stored low-importance, recallable, and kept out of core memory and cards", async () => {
        const id = await sqlite.remember(
            'On 12 Oct Bhai sent an email "Q3 deck" to Riya via Gmail',
            "bhai_did",
            "",
            3,
            "tool",
        );
        expect(id).toBeGreaterThan(0);
        const raw = sqlite.getRawDb();
        expect(raw?.prepare("SELECT importance FROM memories WHERE id = ?").get(id)).toEqual({ importance: 3 });
        expect(sqlite.getCoreMemory(50).some((m) => m.id === id)).toBe(false);
        const hits = await sqlite.recall("Q3 deck Riya Gmail", 5, undefined, undefined, undefined, undefined, {
            touch: false,
        });
        const hit = hits.find((m) => m.id === id);
        expect(hit).toBeDefined();
        const out = cards.buildMemoryCards("same as the Q3 deck to Riya?", hits);
        expect(out.cards).not.toContain("Q3 deck");
        expect(out.rest.some((m) => m.id === id)).toBe(true);
    });
});
