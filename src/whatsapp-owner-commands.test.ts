// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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
