// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { bhaiAddress, handleFromEmail, isEmail, pickBhaiRecipient, stripQuoted } from "./bhaiMailHelpers";

describe("Bhai's own email", () => {
    it("makes a .bhai address from the owner's email", () => {
        expect(handleFromEmail("Dheeraj.S+x@gmail.com")).toBe("dheerajs");
        expect(handleFromEmail("___@x.com")).toBe("me");
        expect(bhaiAddress("dheerajs", 1, "xagilab.com")).toBe("dheerajs.bhai@xagilab.com");
        expect(bhaiAddress("dheerajs", 3, "xagilab.com")).toBe("dheerajs3.bhai@xagilab.com");
    });

    it("routes only <name>.bhai@ the domain, never staff or other domains", () => {
        expect(pickBhaiRecipient(["hello@xagilab.com", "Dheerajs.Bhai@XAGILAB.com"], "xagilab.com")).toBe("dheerajs.bhai@xagilab.com");
        expect(pickBhaiRecipient(["hello@xagilab.com"], "xagilab.com")).toBe(null);
        expect(pickBhaiRecipient(["x.bhai@xagilabxcom.evil"], "xagilab.com")).toBe(null);
        expect(pickBhaiRecipient(["a.b.bhai@xagilab.com"], "xagilab.com")).toBe(null);
    });

    it("keeps what the owner wrote, drops the quoted thread", () => {
        expect(stripQuoted("Book a table for 2\r\n\r\nOn Tue, 29 Oct 2026, Bhai <b@x.com> wrote:\r\n> earlier")).toBe("Book a table for 2");
        expect(stripQuoted("hi\n> quoted\nthere")).toBe("hi\nthere");
    });

    it("checks email shape", () => {
        expect(isEmail("me@example.com")).toBe(true);
        expect(isEmail("me@example")).toBe(false);
        expect(isEmail("a b@example.com")).toBe(false);
    });
});

describe("Bhai's email with everyone", () => {
    it("parses recipient lists and refuses junk", async () => {
        const { parseRecipients } = await import("./bhaiMailHelpers");
        expect(parseRecipients("A@x.com, Bee <b@y.com>, a@x.com")).toEqual(["a@x.com", "b@y.com"]);
        expect(parseRecipients("")).toEqual([]);
        expect(parseRecipients(undefined)).toEqual([]);
        expect(parseRecipients("a@x.com, not-an-email")).toBe(null);
    });

    it("spots mail Bhai must never answer", async () => {
        const { isAutomatedMail, parseHeaderBlock } = await import("./bhaiMailHelpers");
        const h = (raw: string) => parseHeaderBlock(raw);
        expect(isAutomatedMail("friend@x.com", h("Subject: hi"))).toBe(false);
        expect(isAutomatedMail("friend@x.com", h("Auto-Submitted: auto-replied"))).toBe(true);
        expect(isAutomatedMail("friend@x.com", h("Auto-Submitted: no"))).toBe(false);
        expect(isAutomatedMail("news@x.com", h("List-Unsubscribe:\r\n <mailto:u@x.com>"))).toBe(true);
        expect(isAutomatedMail("x@y.com", h("Precedence: bulk"))).toBe(true);
        expect(isAutomatedMail("MAILER-DAEMON@x.com", {})).toBe(true);
        expect(isAutomatedMail("no-reply@x.com", {})).toBe(true);
        expect(isAutomatedMail("noreen@x.com", {})).toBe(false);
    });
});
