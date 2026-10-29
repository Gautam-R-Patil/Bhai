// © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, expect, it } from "vitest";
import { isAboutBhai } from "./agent.js";

describe("isAboutBhai", () => {
    it("catches the side panel's Summarize page message for Bhai's repo", () => {
        const msg =
            '[From browser: https://github.com/XAGI-Lab/Bhai]\nPage title: "GitHub - XAGI-Lab/Bhai"\n\nPage content:\nBhai is a proactive personal AI agent...\n\nAsk: Summarize this page for me.';
        expect(isAboutBhai(msg)).toBe(true);
    });

    it("catches xagilab.com, Bhai Bridge, and Bhai named with XAGI", () => {
        expect(isAboutBhai("what's on https://xagilab.com")).toBe(true);
        expect(isAboutBhai("the Bhai Bridge popup is blank")).toBe(true);
        expect(isAboutBhai("Bhai, built by XAGI Labs, reviewed")).toBe(true);
        expect(isAboutBhai("Bhai: a proactive personal AI agent with computer use")).toBe(true);
    });

    it("ignores bhai as a word for a person, and Bhai mail addresses", () => {
        expect(isAboutBhai("bhai kal milte hain")).toBe(false);
        expect(isAboutBhai("my brother is my bhai")).toBe(false);
        expect(isAboutBhai("mail priya.bhai@xagilab.com the deck")).toBe(false);
        expect(isAboutBhai("bhai, send the XAGI invoice to Ravi")).toBe(false);
    });
});
