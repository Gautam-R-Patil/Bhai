// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Poll votes / RSVPs Bhai sends must decrypt the way WhatsApp (Baileys) decrypts them,
// and reply markers must act in the chat without ever showing as text.
import { randomBytes } from "node:crypto";
import { decryptEventResponse, decryptPollVote, proto } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import { encryptAddOn, optionHash, pickPollOptions, takeChatActions } from "./whatsapp-media.js";

const ctx = {
    secret: randomBytes(32),
    msgId: "3EB0POLL123",
    creatorJid: "917050525092@s.whatsapp.net",
    actorJid: "917306135940@s.whatsapp.net",
};

describe("poll votes and event answers", () => {
    it("a vote decrypts with Baileys to the chosen options' hashes", () => {
        const plain = proto.Message.PollVoteMessage.encode({ selectedOptions: [optionHash("Pizza")] }).finish();
        const vote = encryptAddOn(plain, "Poll Vote", ctx);
        const back = decryptPollVote(vote, {
            pollEncKey: ctx.secret,
            pollMsgId: ctx.msgId,
            pollCreatorJid: ctx.creatorJid,
            voterJid: ctx.actorJid,
        });
        expect(Buffer.from(back.selectedOptions[0]).equals(optionHash("Pizza"))).toBe(true);
    });

    it("an RSVP decrypts with Baileys to the answer", () => {
        const plain = proto.Message.EventResponseMessage.encode({
            response: proto.Message.EventResponseMessage.EventResponseType.GOING,
            timestampMs: 1,
        }).finish();
        const enc = encryptAddOn(plain, "Event Response", ctx);
        const back = decryptEventResponse(enc, {
            eventEncKey: ctx.secret,
            eventMsgId: ctx.msgId,
            eventCreatorJid: ctx.creatorJid,
            responderJid: ctx.actorJid,
        });
        expect(back.response).toBe(proto.Message.EventResponseMessage.EventResponseType.GOING);
    });

    it("picks options by exact text, a unique partial, or number", () => {
        const opts = ["Pizza", "Biryani", "Burgers"];
        expect(pickPollOptions(opts, ["biryani"])).toEqual(["Biryani"]);
        expect(pickPollOptions(opts, ["Bur"])).toEqual(["Burgers"]);
        expect(pickPollOptions(opts, ["3"])).toEqual(["Burgers"]);
        expect(pickPollOptions(opts, ["B"])).toEqual([]); // Biryani or Burgers: don't guess
        expect(pickPollOptions(opts, ["sushi"])).toEqual([]);
    });
});

describe("reply markers", () => {
    it("pulls every action out and leaves the words", () => {
        const { text, actions } = takeChatActions(
            "[[voice]] Done! [[vote:Biryani]] [[poll:Dinner?|Pizza|Biryani]]\n[[location:12.9716,77.5946|Cubbon Park]]",
        );
        expect(text).toBe("Done!");
        expect(actions.voice).toBe(true);
        expect(actions.vote).toEqual(["Biryani"]);
        expect(actions.poll).toEqual({ question: "Dinner?", options: ["Pizza", "Biryani"] });
        expect(actions.location).toEqual({ lat: 12.9716, lng: 77.5946, name: "Cubbon Park" });
    });

    it("reads RSVPs and events, and drops markers it can't use", () => {
        expect(takeChatActions("[[rsvp:not going]]").actions.rsvp).toBe("no");
        expect(takeChatActions("[[rsvp:Going]] see you").actions.rsvp).toBe("going");
        const ev = takeChatActions("[[event:Movie night|2026-11-02 19:00|PVR]] set!").actions.event;
        expect(ev?.name).toBe("Movie night");
        expect(ev?.start.getHours()).toBe(19);
        expect(ev?.place).toBe("PVR");
        const bad = takeChatActions("[[event:Party|someday]] [[location:999,1]] [[poll:Only one|A]] ok");
        expect(bad).toEqual({ text: "ok", actions: {} });
    });

    it("leaves a reply without markers untouched", () => {
        expect(takeChatActions("  hi [there]  ")).toEqual({ text: "  hi [there]  ", actions: {} });
    });
});
