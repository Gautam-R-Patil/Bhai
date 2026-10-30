// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stuckActionButtons } from "./channel-text.js";
import { closeDesktopNotification, LONG_TURN_MS, notifyDesktop, notifyTurnEnd, plainNotifyText } from "./desktop-notify.js";
import { _resetConsent, checkConsent, consentAskedSince } from "./security/consent.js";

describe("desktop notifications", () => {
    let lines: string[];
    beforeEach(() => {
        lines = [];
        vi.spyOn(process.stdout, "write").mockImplementation((s) => (lines.push(String(s)), true));
        process.env.ATLAS_DESKTOP_NOTIFY = "1";
    });
    afterEach(() => {
        vi.restoreAllMocks();
        delete process.env.ATLAS_DESKTOP_NOTIFY;
    });
    const sent = () => lines.map((l) => JSON.parse(l.replace("##BHAI_NOTIFY##", "")));
    const long = () => Date.now() - LONG_TURN_MS;

    it("turns markdown into one plain line", () => {
        expect(plainNotifyText("## Done\n- **Booked** the [table](https://x.y) for `8pm`")).toBe("Done Booked the table for 8pm");
        expect(plainNotifyText("a".repeat(300))).toHaveLength(200);
    });

    it("notifies done only for long turns or a notification reply; stuck and waiting always", () => {
        notifyTurnEnd("quick", Date.now());
        expect(lines).toHaveLength(0);
        notifyTurnEnd("long", long());
        notifyTurnEnd("help", Date.now(), { stuck: true, stuckActions: stuckActionButtons() });
        notifyTurnEnd("Delete 3 files?", Date.now(), { waiting: true });
        notifyTurnEnd("answer", Date.now(), { fromNotification: true });
        expect(sent().map((n) => n.kind)).toEqual(["done", "stuck", "waiting", "done"]);
        expect(sent()[1].actions.map((a: { label: string }) => a.label)).toEqual(["I'll take over", "Retry", "Skip"]);
        expect(sent()[2].actions[0].message).toMatch(/^Yes/);
    });

    it("titles a failed turn and a question, tags by chat, and closes by tag", () => {
        notifyTurnEnd("timed out", long(), { failed: true, chat: "c1" });
        notifyTurnEnd("Which one do you want?", long());
        expect(sent().map((n) => n.title)).toEqual(["Bhai hit a snag", "Bhai has a question"]);
        expect(sent()[0].tag).toBe("turn:c1");
        closeDesktopNotification("turn:c1");
        expect(sent()[2]).toEqual({ close: "turn:c1" });
    });

    it("says false without the desktop app, so callers fall back", () => {
        delete process.env.ATLAS_DESKTOP_NOTIFY;
        expect(notifyDesktop("handoff", "Bhai", "tap")).toBe(false);
        closeDesktopNotification("x");
        expect(lines).toHaveLength(0);
    });

    it("knows when a turn ended asking for consent", () => {
        _resetConsent();
        const start = Date.now();
        expect(consentAskedSince(start)).toBe(false);
        checkConsent("delete_file:/tmp/x", false);
        expect(consentAskedSince(start)).toBe(true);
        expect(consentAskedSince(Date.now() + 1)).toBe(false);
    });
});
