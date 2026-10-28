// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import "./index.js"; // load the registry first, as the app does (macos.ts is in an import cycle with it)
import { _findBestMatchForTest as findBestMatch } from "./macos.js";

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
