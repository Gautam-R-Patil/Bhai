// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Two contacts' turns can overlap (separate WhatsApp events): each ask_owner must be filed
// under the contact whose turn asked it.
import { expect, it } from "vitest";
import { askOwnerTool, getPendingQueriesForOwner, registerOwnerRelaySender, withRelayContact } from "./ask-owner.js";

it("files each question under the contact whose turn asked it, even when turns overlap", async () => {
    registerOwnerRelaySender(async () => {});
    const owner = "910000000000@s.whatsapp.net";
    const turn = (contactJid: string, contactName: string, delayMs: number) =>
        withRelayContact({ contactJid, contactName, ownerJid: owner }, async () => {
            await new Promise((r) => setTimeout(r, delayMs)); // the model thinking
            return askOwnerTool.handler({ question: `is ${contactName} invited?`, contact_reply: "checking" });
        });
    // A starts first and asks last; B starts second and asks first.
    await Promise.all([turn("a@s.whatsapp.net", "Asha", 30), turn("b@s.whatsapp.net", "Bilal", 5)]);
    const filed = getPendingQueriesForOwner(owner).map((q) => [q.contactName, q.contactJid, q.question]);
    expect(filed).toContainEqual(["Asha", "a@s.whatsapp.net", "is Asha invited?"]);
    expect(filed).toContainEqual(["Bilal", "b@s.whatsapp.net", "is Bilal invited?"]);
    expect(JSON.parse(await askOwnerTool.handler({ question: "outside a turn" }))).toMatchObject({ error: expect.any(String) });
});
