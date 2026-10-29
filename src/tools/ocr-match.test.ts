// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import "./index.js"; // load the registry first, as the app does (macos.ts is in an import cycle with it)
import { _findBestMatchForTest as findBestMatch, findVerifyMatch } from "./macos.js";

const el = (text: string, i = 0) => ({ text, cx_norm: 0.5, cy_norm: i / 10, w_norm: 0.1, h_norm: 0.02, cx_screen: 100, cy_screen: i * 20, confidence: 1 });

describe("OCR findBestMatch", () => {
    it("doesn't let a short fragment stand in for the whole query", () => {
        expect(findBestMatch([el("OK"), el("Me")], "Message sent", 0.6)).toBeNull();
    });
    it("finds the query inside a longer line", () => {
        expect(findBestMatch([el("Save As…")], "Save", 0.45)?.element.text).toBe("Save As…");
    });
    it("matches text split across words or wrapped lines, in reading order", () => {
        const words = [el("Inbox", 0), el("Message", 1), el("sent", 2)];
        expect(findBestMatch(words, "Message sent", 0.6)?.element.text).toBe("Message");
        const wrapped = [el("Hey Rahul, are you coming to the office party", 0), el("tomorrow evening? Let me know by 5", 1)];
        expect(findBestMatch(wrapped, "Hey Rahul, are you coming to the office party tomorrow evening? Let me know by 5", 0.6)).not.toBeNull();
    });
});

describe("os_visual_verify: where expected text counts", () => {
    const at = (text: string, x: number, y: number) =>
        ({ text, cx_screen: x, cy_screen: y, cx_norm: 0, cy_norm: 0, w_norm: 0, h_norm: 0, confidence: 1 }) as never;
    const calc = { x: 700, y: 200, w: 240, h: 380 };
    // The live miss: the menu-bar clock and another window's title matched "0" and "7".
    const screen = [at("Fri Oct 30 1:38", 1300, 12), at("Bhai - Q release 7", 300, 60), at("0", 900, 260)];

    it("reads the focused window, never the menu bar, and a short value as a whole word", () => {
        expect(findVerifyMatch(screen, "0", calc, 25)?.element.text).toBe("0");
        expect(findVerifyMatch(screen, "7", calc, 25)).toBeNull(); // only in another window's title
        expect(findVerifyMatch([at("Fri Oct 30 1:38", 1300, 12)], "30", calc, 25)).toBeNull();
    });

    it("still sees a toast outside the window, when it's a strong match", () => {
        const toast = [...screen, at("Message sent", 1200, 90)];
        expect(findVerifyMatch(toast, "Message sent", calc, 25)?.element.text).toBe("Message sent");
        expect(findVerifyMatch(toast, "Message delivered", calc, 25)).toBeNull();
    });
});
