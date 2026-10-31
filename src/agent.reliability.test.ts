// © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import {
    antiGivingUpFailures,
    ackWithoutAction,
    asksLeaveToLook,
    finalReplyText,
    isDeferrable,
    planAskQuestion,
    planToolsBlock,
    toolFailed,
} from "./agent.js";

const msg = (content: string): ChatCompletionMessageParam => ({ role: "user", content });

describe("toolFailed", () => {
    it("uses the result flags, not the word error", () => {
        expect(toolFailed({ isError: false })).toBe(false);
        expect(toolFailed({ isError: true })).toBe(true);
        expect(toolFailed({ isError: false, reportedFailure: true })).toBe(true);
    });
});

describe("isDeferrable", () => {
    const call = (name: string, args: object) => ({ function: { name, arguments: JSON.stringify(args) } });
    it("runs pins and supersedes in the foreground so a refusal reaches the model", () => {
        expect(isDeferrable(call("memory_store", { content: "x" }))).toBe(true);
        expect(isDeferrable(call("memory_store", { content: "x", pin_id: 42 }))).toBe(false);
        expect(isDeferrable(call("memory_store", { content: "x", supersedes: 7 }))).toBe(false);
        expect(isDeferrable(call("memory_store", { content: "x", pin: true }))).toBe(false);
        expect(isDeferrable(call("memory_search", { query: "x" }))).toBe(false);
    });
});

describe("planToolsBlock", () => {
    it("lists only the given tools with their first sentence", () => {
        const block = planToolsBlock([
            { function: { name: "whatsapp_send", description: "Send a WhatsApp message. Long details here." } },
            { function: { name: "os_type" } },
        ]);
        expect(block).toBe("- whatsapp_send: Send a WhatsApp message.\n- os_type: ");
    });
});

describe("finalReplyText", () => {
    const tg = { channel: "telegram", userId: "1", isOwner: true };
    it("keeps an exact [NO_REPLY] for channels that stay silent", () => {
        for (const channel of ["telegram", "whatsapp", "discord", "slack", "matrix"]) {
            expect(finalReplyText(" [NO_REPLY]\n", { ...tg, channel })).toBe("[NO_REPLY]");
        }
    });
    it("strips it everywhere else, so the overlay and autonomous runs still answer", () => {
        expect(finalReplyText("[NO_REPLY]", { ...tg, channel: "overlay" })).toBe("");
        expect(finalReplyText("[NO_REPLY]", { ...tg, autonomous: true })).toBe("");
        expect(finalReplyText("[NO_REPLY]")).toBe("");
        expect(finalReplyText("ok [NO_REPLY]", tg)).toBe("ok");
    });
    it("keeps overlay markers only on the overlay", () => {
        const raw = 'Delete it?<!--QUICK_ACTIONS:["a"]-->';
        expect(finalReplyText(raw, tg)).toBe("Delete it?");
        expect(finalReplyText(raw, { ...tg, channel: "overlay" })).toBe(raw);
        expect(finalReplyText("<!--COLLAPSE:Code-->x<!--/COLLAPSE--> ok", tg)).toBe("x ok");
    });
    it("keeps other HTML comments, e.g. in code", () => {
        const raw = "Use `<!-- note -->` then A --> B";
        expect(finalReplyText(raw, tg)).toBe(raw);
    });
});

describe("antiGivingUpFailures", () => {
    const ownerNeeded: ChatCompletionMessageParam = {
        role: "tool",
        tool_call_id: "t1",
        content: JSON.stringify({
            error: "This page is waiting on the owner.",
            owner_needed: "This page has a step only the owner can finish.",
        }),
    };
    const history = [msg("open my bank site and download the statement"), ownerNeeded];
    const handoff = "You need to finish the check in the browser window.";

    it("forces a retry on a short hand-off after a failure", () => {
        expect(antiGivingUpFailures(history, "open my bank site and download the statement", handoff, 2)).toBe(1);
    });
    it("never retries an owner_needed result followed by a stuck report", () => {
        expect(
            antiGivingUpFailures(history, "open my bank site and download the statement", `${handoff}\n[[STUCK]]`, 2),
        ).toBe(0);
    });
    it("leaves an honest 'not available' answer to a plain question alone", () => {
        const search: ChatCompletionMessageParam = {
            role: "tool",
            tool_call_id: "t2",
            content: JSON.stringify({ success: true, error: null, results: [{ title: "Pixel 10 Pro Fold" }] }),
        };
        const q = "is the pixel 10 pro fold out in india yet?";
        const reply = "The Pixel 10 Pro Fold is not available in India yet.";
        expect(antiGivingUpFailures([msg(q), search], q, reply, 1)).toBe(0);
        // "error":null is not a failure even on an action task
        expect(antiGivingUpFailures([msg("find the fold"), search], "find the fold", reply, 1)).toBe(0);
        // nor is a pretty-printed one ('"error": null', as JSON.stringify(x, null, 2) writes it)
        const pretty: ChatCompletionMessageParam = { ...search, content: JSON.stringify({ success: true, error: null }, null, 2) };
        expect(antiGivingUpFailures([msg("find the fold"), pretty], "find the fold", reply, 1)).toBe(0);
    });
});

describe("planAskQuestion", () => {
    it("asks only on the ASK_USER marker, not on ordinary 'which' steps", () => {
        expect(
            planAskQuestion(
                "1. app_manager action='list' to see which apps are running.\n2. app_manager activate WhatsApp\n3. os_type the message",
            ),
        ).toBeNull();
        expect(planAskQuestion('1. ASK_USER "Which song did you mean: Pink Floyd or NF?"\n2. spotify play')).toBe(
            "Which song did you mean: Pink Floyd or NF?",
        );
        // a quote or apostrophe inside the question doesn't cut it short
        expect(planAskQuestion(`1. ASK_USER "Which 'Time'? Some options: Pink Floyd, MKJ, NF"\n2. spotify play`)).toBe(
            "Which 'Time'? Some options: Pink Floyd, MKJ, NF",
        );
        expect(planAskQuestion("ASK_USER: What's the file called?")).toBe("What's the file called?");
    });
});

describe("asksLeaveToLook", () => {
    it("catches an unfinished task that stops to ask about a look-only step", () => {
        expect(
            asksLeaveToLook(
                "Downloads shows as the active location. I haven’t read the first three file names yet, so the task isn't finished. Want me to take a screenshot and read them?",
            ),
        ).toBe(true);
    });
    it("leaves real questions alone: outward actions, finished tasks, stuck reports", () => {
        expect(asksLeaveToLook("The draft is ready but not sent yet. Want me to send it to Priya?")).toBe(false);
        expect(asksLeaveToLook("Done — Downloads has a.pdf, b.png and c.zip. Want me to open one?")).toBe(false);
        expect(asksLeaveToLook("I haven't found it yet. Want me to check again?\n[[STUCK]]")).toBe(false);
    });
    it("catches handing the looking to the owner, but only when Bhai can see the screen itself", () => {
        const reply =
            "I still can't name the network: the SSID is redacted. If you can see it in the Wi-Fi menu, tell me and I'll take it from there.";
        expect(asksLeaveToLook(reply, true)).toBe(true);
        expect(asksLeaveToLook(reply, false)).toBe(false);
        expect(
            asksLeaveToLook(
                "I still can't name the network: the output redacts the SSID. If you check the Wi-Fi menu bar icon, the name will be there.",
                true,
            ),
        ).toBe(true);
        expect(
            asksLeaveToLook(
                "macOS is hiding the SSID from me, so I don't have it. Tell me the name from the Wi-Fi menu and I'll use it.",
                true,
            ),
        ).toBe(true);
        expect(asksLeaveToLook("Done. If you can see any typo, tell me.", true)).toBe(false);
    });
});

// From the model-ladder eval: gpt-5-nano answered "on it — playing Levitating by Dua Lipa
// on Spotify; done = it shows as now_playing" and made no tool call.
describe("ackWithoutAction", () => {
    const ack = "on it — playing Levitating by Dua Lipa on Spotify; done = it shows as now_playing";
    it("an ack with no tool call yet is not an answer", () => {
        expect(ackWithoutAction(ack, 0)).toBe(true);
    });
    it("is fine once work has started, for plain answers, and for stuck reports", () => {
        expect(ackWithoutAction(ack, 2)).toBe(false);
        expect(ackWithoutAction("Playing Levitating by Dua Lipa now.", 0)).toBe(false);
        expect(ackWithoutAction(`${ack}\nSpotify needs you to sign in.\n[[STUCK]]`, 0)).toBe(false);
    });
});
