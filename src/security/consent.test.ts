// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { beforeEach, describe, expect, it } from "vitest";
import { _resetConsent, checkConsent, noteOwnerMessage, ownerApproved, ownerSaid } from "./consent.js";

const KEY = 'delete_file:{"path":"/Users/me/notes.txt"}';

describe("consent for irreversible actions", () => {
    beforeEach(() => {
        _resetConsent();
        noteOwnerMessage("delete my old notes file");
    });

    it("a confirmed flag the model sets on its own is never enough", () => {
        for (let i = 0; i < 100; i++) expect(checkConsent(KEY, true)).toBe("needs_consent");
    });

    it("granted only after the owner says yes in a new message", () => {
        expect(checkConsent(KEY, false)).toBe("needs_consent"); // asked
        expect(checkConsent(KEY, true)).toBe("needs_consent"); // owner hasn't answered yet
        noteOwnerMessage("yes go ahead");
        expect(checkConsent(KEY, true)).toBe("granted");
        expect(checkConsent(KEY, true)).toBe("needs_consent"); // one use only
    });

    it("a no, or a different action, isn't consent", () => {
        checkConsent(KEY, false);
        noteOwnerMessage("no, don't delete it");
        expect(checkConsent(KEY, true)).toBe("needs_consent");
        checkConsent(KEY, false);
        noteOwnerMessage("yes");
        expect(checkConsent('delete_file:{"path":"/Users/me"}', true)).toBe("needs_consent");
    });

    it("an approval quote must be the owner's words, sent after approval was asked", () => {
        const askedAt = Date.now();
        expect(ownerSaid("delete my old notes file", askedAt + 1)).toBe(false); // said before the ask
        expect(ownerSaid("Looks good, ship the new tool", askedAt)).toBe(false); // model-written
        noteOwnerMessage("Looks good — ship the new tool!");
        expect(ownerSaid("looks good ship the new tool", askedAt)).toBe(true);
    });

    it("a short quote can't ride inside another word, and approval must say yes in the latest message", () => {
        const askedAt = Date.now();
        noteOwnerMessage("this looks wrong, redo the schema");
        expect(ownerSaid("ok", askedAt)).toBe(false); // "ok" inside "looks"
        expect(ownerApproved("ok", askedAt)).toBe(false);
        expect(ownerApproved("redo the schema", askedAt)).toBe(false); // not a yes
        noteOwnerMessage("yes go ahead with it");
        expect(ownerApproved("yes go ahead", askedAt)).toBe(true);
        noteOwnerMessage("wait, change the API first");
        expect(ownerApproved("yes go ahead", askedAt)).toBe(false); // superseded by a later message
        noteOwnerMessage("ok so don't build it yet");
        expect(ownerApproved("ok so", askedAt)).toBe(false); // the rest of the message says no
        noteOwnerMessage("yes");
        expect(ownerApproved("yes", askedAt)).toBe(true); // a plain yes is enough
    });
});
