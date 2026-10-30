// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The owner's one-to-one chat with Bhai counts as private on every channel (memory_forget,
// pins, "Forget that", corrections gate on it); groups, channels, CCs and guests never do.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bhaiMailContext } from "./bhai-mail.js";
import { discordChannelContext } from "./discord.js";
import { emailChannelContext } from "./email.js";
import { matrixChannelContext } from "./matrix.js";
import { slackChannelContext } from "./slack.js";

const ENV = ["OWNER_DISCORD_IDS", "OWNER_SLACK_IDS", "OWNER_MATRIX_IDS", "OWNER_EMAIL_ADDRESSES"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.OWNER_DISCORD_IDS = "111";
    process.env.OWNER_SLACK_IDS = "UOWNER";
    process.env.OWNER_MATRIX_IDS = "@me:hs.org";
    process.env.OWNER_EMAIL_ADDRESSES = "me@x.com";
});
afterEach(() => {
    for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

describe("owner DMs count as private", () => {
    it("Discord: only the owner in a DM with Bhai", () => {
        const owner = { id: "111", username: "me" };
        expect(discordChannelContext(owner, true)).toMatchObject({ isOwner: true, isPrivate: true });
        expect(discordChannelContext(owner, false)).toMatchObject({ isOwner: false, isPrivate: false });
        expect(discordChannelContext({ id: "222", username: "pal" }, true)).toMatchObject({
            isOwner: false,
            isPrivate: false,
        });
    });

    it("Slack: only the owner in an IM (D…) channel", () => {
        expect(slackChannelContext("D123", "UOWNER")).toMatchObject({ isOwner: true, isPrivate: true });
        expect(slackChannelContext("C123", "UOWNER")).toMatchObject({ isOwner: false, isPrivate: false });
        expect(slackChannelContext("G123", "UOWNER")).toMatchObject({ isOwner: false, isPrivate: false });
        expect(slackChannelContext("D123", "UPAL")).toMatchObject({ isOwner: false, isPrivate: false });
    });

    it("Matrix: only the owner in a room of exactly the owner and Bhai", () => {
        const bot = "@bhai:hs.org";
        expect(matrixChannelContext("@me:hs.org", ["@me:hs.org", bot], bot)).toMatchObject({
            isOwner: true,
            isPrivate: true,
        });
        expect(matrixChannelContext("@me:hs.org", ["@me:hs.org", bot, "@pal:hs.org"], bot)).toMatchObject({
            isOwner: false,
            isPrivate: false,
        });
        expect(matrixChannelContext("@pal:hs.org", ["@pal:hs.org", bot], bot)).toMatchObject({
            isOwner: false,
            isPrivate: false,
        });
        // Unknown bot id or unreadable members: not private.
        expect(matrixChannelContext("@me:hs.org", ["@me:hs.org", bot], null).isPrivate).toBe(false);
        expect(matrixChannelContext("@me:hs.org", [], bot).isPrivate).toBe(false);
    });

    it("Email: only the owner writing to Bhai alone", () => {
        const me = { email: "me@x.com", name: "Me" };
        expect(emailChannelContext(me, ["Bhai@Box.com"], "bhai@box.com")).toMatchObject({
            isOwner: true,
            isPrivate: true,
        });
        // Owner mail with someone else on To/Cc stays owner mail, but not private.
        expect(emailChannelContext(me, ["bhai@box.com", "pal@y.com"], "bhai@box.com")).toMatchObject({
            isOwner: true,
            isPrivate: false,
        });
        // Bhai only Bcc'd (not on To/Cc at all): not private.
        expect(emailChannelContext(me, ["pal@y.com"], "bhai@box.com").isPrivate).toBe(false);
        expect(emailChannelContext(me, [], "bhai@box.com").isPrivate).toBe(false);
        expect(
            emailChannelContext({ email: "pal@y.com", name: "Pal" }, ["bhai@box.com"], "bhai@box.com"),
        ).toMatchObject({
            isOwner: false,
            isPrivate: false,
        });
    });

    it("Bhai's own email: only owner mail the server marked as sent to Bhai alone", () => {
        const mail = { from: "me@x.com", fromName: "Me", fromOwner: true, direct: true };
        expect(bhaiMailContext("me@x.com", mail)).toMatchObject({ isOwner: true, isPrivate: true });
        expect(bhaiMailContext("me@x.com", { ...mail, direct: false })).toMatchObject({
            isOwner: true,
            isPrivate: false,
        });
        // An older server that doesn't say: not private.
        expect(bhaiMailContext("me@x.com", { ...mail, direct: undefined }).isPrivate).toBe(false);
        expect(bhaiMailContext("me@x.com", { ...mail, from: "pal@y.com", fromOwner: false })).toMatchObject({
            isOwner: false,
            isPrivate: false,
            userId: "pal@y.com",
        });
    });
});
