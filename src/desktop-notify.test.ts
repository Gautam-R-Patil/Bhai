// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_TURN_MS, notifyDesktop, notifyTurnEnd, plainNotifyText } from "./desktop-notify.js";

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

    it("turns markdown into one plain line", () => {
        expect(plainNotifyText("## Done\n- **Booked** the [table](https://x.y) for `8pm`")).toBe("Done Booked the table for 8pm");
        expect(plainNotifyText("a".repeat(300))).toHaveLength(200);
    });

    it("notifies done only for long turns, stuck always", () => {
        notifyTurnEnd("quick", Date.now());
        expect(lines).toHaveLength(0);
        notifyTurnEnd("long", Date.now() - LONG_TURN_MS);
        notifyTurnEnd("help", Date.now(), true);
        expect(sent().map((n) => n.kind)).toEqual(["done", "stuck"]);
    });

    it("says false without the desktop app, so callers fall back", () => {
        delete process.env.ATLAS_DESKTOP_NOTIFY;
        expect(notifyDesktop("handoff", "Bhai", "tap")).toBe(false);
        expect(lines).toHaveLength(0);
    });
});
