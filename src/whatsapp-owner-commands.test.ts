// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The owner's "allow"/"block" and group commands act on the one they mean, not on
// whoever wrote last or whatever group a stranger named alike.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-wa-cmds-"));
const users = await import("./whatsapp-users.js");

describe("allow / block", () => {
    it("acts on the only request, or the one whose number the owner gives", () => {
        const owner = "910000000000@s.whatsapp.net";
        users.createContactRequest("919811111111@s.whatsapp.net", "hi it's Riya", owner);
        expect(users.pickPendingRequest("my cousin")?.request.jid).toBe("919811111111@s.whatsapp.net");
        users.createContactRequest("447700900123@s.whatsapp.net", "win a prize", owner); // a stranger, just after
        expect(users.pickPendingRequest("my cousin")).toBeNull(); // ambiguous: ask, don't guess
        const picked = users.pickPendingRequest("+91 98111 11111 my cousin, I call her Riya");
        expect(picked?.request.jid).toBe("919811111111@s.whatsapp.net");
        expect(picked?.rest).toBe("my cousin, I call her Riya");
        expect(users.pendingRequestFrom("447700900123@s.whatsapp.net")?.firstMessage).toBe("win a prize");
    });
});

describe("group names", () => {
    const groups = [{ name: "Family" }, { name: "Family chat free crypto" }, { name: "Work" }];
    it("an exact name wins; a partial one only when it is the only match", () => {
        expect(users.findGroupByName(groups, "family")?.name).toBe("Family");
        expect(users.findGroupByName(groups, "wor")?.name).toBe("Work");
        expect(users.findGroupByName(groups, "fam")).toBeUndefined(); // two candidates
        expect(users.findGroupByName(groups, "")).toBeUndefined();
    });
});

describe("LID addresses", () => {
    it("uses the phone JID Baileys passes alongside a LID", () => {
        expect(users.phoneJidOf("123456789012345@lid", "919811111111@s.whatsapp.net")).toBe("919811111111@s.whatsapp.net");
        expect(users.phoneJidOf("919811111111@s.whatsapp.net", undefined)).toBe("919811111111@s.whatsapp.net");
        expect(users.phoneJidOf("123456789012345@lid", undefined)).toBe("123456789012345@lid");
        expect(users.phoneJidOf("1203630@g.us", "x@lid")).toBe("1203630@g.us");
    });
});

describe("waiting contacts survive a restart", () => {
    it("keeps the request, what they added and their WhatsApp name on disk", () => {
        const owner = "910000000000@s.whatsapp.net";
        const jid = "917050525092@s.whatsapp.net";
        const req = users.createContactRequest(jid, "yo boi", owner, "Kunal Kumar Mehta");
        users.addToPendingRequest(req, "you there?");
        users.initWhatsAppUsers(); // what the app does after a restart
        const back = users.pendingRequestFrom(jid);
        expect(back?.firstMessage).toBe("yo boi\nyou there?");
        expect(back?.pushName).toBe("Kunal Kumar Mehta");
        users.resolveContactRequest(back!.id, "allowed");
        expect(users.getContactProfile(jid)?.displayName).toBe("Kunal Kumar Mehta");
        users.initWhatsAppUsers();
        expect(users.pendingRequestFrom(jid)).toBeUndefined();
    });
});

describe("owner questions survive a restart", () => {
    it("files a contact's question on disk and removes it once answered", async () => {
        const ask = await import("./tools/ask-owner.js");
        const sent: string[] = [];
        ask.registerOwnerRelaySender(async (_jid, text) => {
            sent.push(text);
        });
        const owner = "910000000000@s.whatsapp.net";
        const out = await ask.withRelayContact(
            { contactJid: "917050525092@s.whatsapp.net", contactName: "Kunal", ownerJid: owner },
            async () => {
                expect(ask.inContactRun()).toBe(true);
                return ask.askOwnerTool.handler({ question: "Can Kunal borrow the car Sunday?", contact_reply: "Checking!" });
            },
        );
        expect(JSON.parse(out as string).success).toBe(true);
        expect(ask.inContactRun()).toBe(false);
        expect(sent[0]).toContain('"Can Kunal borrow the car Sunday?"');
        const file = path.join(process.env.ATLAS_DATA_DIR!, "whatsapp-owner-questions.json");
        expect(JSON.parse(fs.readFileSync(file, "utf-8"))[0].contactName).toBe("Kunal");
        const q = ask.resolveLatestQueryForOwner(owner);
        expect(q?.question).toBe("Can Kunal borrow the car Sunday?");
        expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual([]);
    });
});

describe("swipe-reply on a request notice", () => {
    it("finds the request the notice was about and reads yes / no / neither", () => {
        const owner = "910000000000@s.whatsapp.net";
        users.createContactRequest("917050525092@s.whatsapp.net", "yo boi", owner, "Kunal Kumar Mehta");
        users.createContactRequest("447700900123@s.whatsapp.net", "win a prize", owner);
        const notice = 'New message from Kunal Kumar Mehta:\n"yo boi"\n\nSwipe-reply to this message (or just send):';
        expect(users.requestForNotice(notice)?.jid).toBe("917050525092@s.whatsapp.net");
        expect(users.requestForNotice('New message from 447700900123:\n"win a prize"')?.jid).toBe(
            "447700900123@s.whatsapp.net",
        );
        expect(users.requestForNotice("❓ *Kunal* wants to know")).toBeUndefined();

        // The exact reply from the chat that went to the agent instead of approving Kunal.
        expect(users.noticeVerdict("Allow he is my collage friend and his name is Kunal he is also my roommate")).toEqual({
            allow: true,
            context: "he is my collage friend and his name is Kunal he is also my roommate",
        });
        expect(users.noticeVerdict("yes, my roommate")).toEqual({ allow: true, context: "my roommate" });
        expect(users.noticeVerdict("block")).toEqual({ allow: false, context: "" });
        expect(users.noticeVerdict("nah ignore")?.allow).toBe(false);
        expect(users.noticeVerdict("who is this?")).toBeNull();
        expect(users.noticeVerdict("okay")).toEqual({ allow: true, context: "" });
        expect(users.noticeVerdict("hahaha")).toBeNull(); // "ha" must be a whole word
    });
});
