// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Outside a DM, Slack and Discord only hand Bhai @mentions: the stuck report must ask for one.
import { describe, expect, it } from "vitest";
import { STUCK_REPLY_LINE } from "./channel-text.js";
import { discordStuckReplyText } from "./discord.js";
import { slackStuckReplyText } from "./slack.js";

const stuck = { text: "Hit an OTP.", stuck: true };

describe("stuck reply line by surface", () => {
    it("Slack: a bare reply in a DM, an @mention in a channel thread", () => {
        expect(slackStuckReplyText(stuck, true, "D123")).toBe(`Hit an OTP.\n\n${STUCK_REPLY_LINE}`);
        expect(slackStuckReplyText(stuck, true, "C123")).toBe(
            "Hit an OTP.\n\n@mention me with: retry it · skip it · I'll take over",
        );
        expect(slackStuckReplyText(stuck, false, "C123")).toBe("Hit an OTP.");
        expect(slackStuckReplyText({ text: "Done." }, true, "C123")).toBe("Done.");
    });

    it("Discord: a bare reply in a DM, an @mention in a channel or thread", () => {
        expect(discordStuckReplyText(stuck, true, true)).toBe(`Hit an OTP.\n\n${STUCK_REPLY_LINE}`);
        expect(discordStuckReplyText(stuck, true, false)).toContain("@mention me with: retry it");
        expect(discordStuckReplyText(stuck, false, false)).toBe("Hit an OTP.");
    });
});
