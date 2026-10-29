// © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import {
    contractCheckNudge,
    contractProgressLine,
    extractDoneContract,
    findAckLine,
    stuckExitText,
    stuckNote,
    verifyGateFires,
} from "./agent.js";
import { newVerifyGateState } from "./agents/verify-before-done.js";
import { playbookTaskText } from "./memory/playbooks.js";

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

describe("stuck exits", () => {
    const ack = "on it — sending the Oct invoice to Priya on Gmail; done = it shows in Sent";
    const toolMsg = (content: string | null): ChatCompletionMessageParam => ({
        role: "assistant",
        content,
        tool_calls: [{ id: "1", type: "function", function: { name: "os_smart_click", arguments: "{}" } }],
    });

    it("never returns the ack: falls back to an honest stuck note", () => {
        const messages: ChatCompletionMessageParam[] = [
            { role: "assistant", content: "last turn's answer" },
            { role: "user", content: "send the Oct invoice to Priya on Gmail" },
            toolMsg(ack),
            toolMsg(null),
            { role: "tool", tool_call_id: "1", content: "error" },
        ];
        const text = stuckExitText(
            messages,
            "the same steps kept failing",
            ["os_smart_click", "os_smart_click", "os_type"],
            "it shows in Sent",
        );
        expect(text).not.toContain("on it");
        expect(text).not.toContain("last turn's answer");
        expect(text).toBe(
            "I got stuck and stopped: the same steps kept failing. I tried os_smart_click, os_type. It isn't done yet (done = it shows in Sent). I can retry with a different approach, or you can take over from here.",
        );
    });

    it("keeps the latest real text the model wrote this turn", () => {
        const messages: ChatCompletionMessageParam[] = [
            { role: "user", content: "x" },
            toolMsg(ack),
            toolMsg("The Send button is greyed out; the attachment is still uploading."),
        ];
        expect(stuckExitText(messages, "x", [])).toBe(
            "The Send button is greyed out; the attachment is still uploading.",
        );
    });

    it("a note with nothing tried and no contract", () => {
        expect(stuckNote("I hit the 60-step limit without finishing", [])).toBe(
            "I got stuck and stopped: I hit the 60-step limit without finishing. It isn't done yet. I can retry with a different approach, or you can take over from here.",
        );
    });

    it("a Retry on a templated stuck note keys the playbook by its contract, not the boilerplate", () => {
        const retry = "Try that again, with a different approach this time.";
        const reply = (note: string) => `[Replying to Bhai's message: "${note}"]\n\n${retry}`;
        const tried = ["browser_navigate", "browser_click"];
        const withContract = stuckNote("the same steps kept failing", tried, "the photo is on my Instagram profile");
        expect(playbookTaskText(reply(withContract), retry)).toBe("the photo is on my Instagram profile");
        expect(playbookTaskText(reply(stuckNote("the same steps kept failing", tried)), retry)).toBeUndefined();
    });

    it("a swipe-reply to the channel's own handoff line keys nothing", () => {
        for (const line of [
            "Reply: retry it · skip it · I'll take over",
            "@mention me with: retry it · skip it · I'll take over",
        ]) {
            expect(
                playbookTaskText(`[Replying to Bhai (you)'s message: "${line}"]\n\nretry it`, "retry it"),
            ).toBeUndefined();
        }
    });

    it("the verify gate never forces another iteration over a [[STUCK]] report", () => {
        const gate = newVerifyGateState();
        gate.osStateMutated = true;
        expect(verifyGateFires(gate, "Sent it.")).toBe(true);
        expect(verifyGateFires(gate, "The bank wants an OTP. Send me the code. [[STUCK]]")).toBe(false);
    });
});
