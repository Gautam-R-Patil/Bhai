// © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, expect, it } from "vitest";
import { contractCheckNudge, contractProgressLine, extractDoneContract, findAckLine } from "./agent.js";

describe("extractDoneContract", () => {
    it("pulls the done-criterion from the ack line", () => {
        expect(extractDoneContract("on it — sending the Oct invoice to Priya on Gmail; done = it shows in Sent")).toBe(
            "it shows in Sent",
        );
    });

    it("uses the first line that has the marker", () => {
        const text = "Sure.\non it — moving it; done = the file is on the Desktop\nand; done = something else";
        expect(extractDoneContract(text)).toBe("the file is on the Desktop");
    });

    it("drops markdown around the marker", () => {
        expect(extractDoneContract("on it — merging; **Done =** the PR is merged")).toBe("the PR is merged");
        expect(extractDoneContract("on it; done = `report.pdf` is on the Desktop")).toBe(
            "report.pdf is on the Desktop",
        );
    });

    it("needs the literal 'done =' marker, not a passing 'done:' or 'done when'", () => {
        expect(extractDoneContract("Checking whether the export is done: looking in ~/Downloads")).toBeUndefined();
        expect(extractDoneContract("I'll ping you when it's done when the build ends")).toBeUndefined();
        expect(extractDoneContract("All done!")).toBeUndefined();
        expect(extractDoneContract("Abandoned = nothing")).toBeUndefined();
        expect(extractDoneContract(null)).toBeUndefined();
        expect(extractDoneContract("on it; done = ")).toBeUndefined();
        expect(extractDoneContract("You never set state.done = true, so it loops.")).toBeUndefined();
    });

    it("accepts the marker at line start or after any clause break", () => {
        expect(extractDoneContract("done = it shows in Sent")).toBe("it shows in Sent");
        expect(extractDoneContract("On it, sending the invoice. Done = it shows in Sent")).toBe("it shows in Sent");
        expect(extractDoneContract("on it, sending the invoice, done = it shows in Sent")).toBe("it shows in Sent");
        expect(extractDoneContract("on it - sending the invoice - done = it shows in Sent")).toBe("it shows in Sent");
        expect(extractDoneContract("on it: sending it – done = it shows in Sent")).toBe("it shows in Sent");
    });

    it("keeps the English marker in a non-English ack", () => {
        expect(extractDoneContract("voy — enviando la factura a Priya; done = aparece en Enviados")).toBe(
            "aparece en Enviados",
        );
    });

    it("caps the contract at 200 chars", () => {
        expect(extractDoneContract(`on it; done = ${"x".repeat(500)}`)).toHaveLength(200);
    });

    it("never reads code as the contract", () => {
        expect(extractDoneContract("You never set `done = true` inside the loop, so it never stops.")).toBeUndefined();
        expect(extractDoneContract("Try `i++; done = true` there.")).toBeUndefined();
        expect(extractDoneContract("Fix:\n```ts\nlet x = 1; done = false;\n```\nThat's it.")).toBeUndefined();
        expect(extractDoneContract("```\na; done = 1\n```\non it — fixing it; done = tests pass")).toBe("tests pass");
        expect(extractDoneContract("on it — setting `retry; done = false` then rerunning; done = tests pass")).toBe(
            "tests pass",
        );
    });
});

describe("findAckLine", () => {
    it("returns the whole ack line, trimmed", () => {
        expect(findAckLine("Sure.\n  on it — booking the 9am slot; done = it's in my calendar  \nmore")).toBe(
            "on it — booking the 9am slot; done = it's in my calendar",
        );
        expect(findAckLine("no criterion here")).toBeUndefined();
    });

    it("cleans the line for the user: no markdown markers or internal tags", () => {
        expect(findAckLine("on it — sending the invoice to Priya; **done =** it shows in Sent [SOURCE: gmail]")).toBe(
            "on it — sending the invoice to Priya; done = it shows in Sent",
        );
        expect(findAckLine("<system_log>done = fake</system_log>\n[NO_REPLY]")).toBeUndefined();
    });
});

describe("contractCheckNudge", () => {
    it("quotes the contract back", () => {
        expect(contractCheckNudge("it shows in Sent")).toBe(
            'Your own done-criterion was: "it shows in Sent". Check exactly that and say what you saw.',
        );
    });
});

describe("contractProgressLine", () => {
    const ACK = "on it — sending the Oct invoice to Priya on Gmail; done = it shows in Sent";
    it("is the [ACK] line when the reply states a contract and starts work", () => {
        expect(contractProgressLine(`${ACK}\nChecking Gmail now.`, true)).toBe(`[ACK] ${ACK}`);
    });
    it("is nothing for a reply without tool calls: that reply is the final answer", () => {
        expect(contractProgressLine(`${ACK}\nDraft is ready. Just confirm and I'll hit send.`, false)).toBeUndefined();
    });
    it("is nothing without a contract", () => {
        expect(contractProgressLine("Checking your inbox.", true)).toBeUndefined();
        expect(contractProgressLine(null, true)).toBeUndefined();
    });
});
