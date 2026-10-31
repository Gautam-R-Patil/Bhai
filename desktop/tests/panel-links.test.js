// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { chatLinkTarget, panelLinkTarget } from "../panel-links.js";

describe("panel links", () => {
    it("opens the sites the panel links to", () => {
        expect(panelLinkTarget("https://github.com/settings/tokens/new?description=Bhai")).toBe("https://github.com/settings/tokens/new?description=Bhai");
        expect(panelLinkTarget("https://t.me/BotFather")).toBe("https://t.me/BotFather");
        expect(panelLinkTarget("mailto:dheeraj.bhai@xagilab.com")).toBe("mailto:dheeraj.bhai@xagilab.com");
    });
    it("refuses anything else", () => {
        expect(panelLinkTarget("http://github.com/")).toBeNull();
        expect(panelLinkTarget("https://evil.com/")).toBeNull();
        expect(panelLinkTarget("https://github.com.evil.com/")).toBeNull();
        expect(panelLinkTarget("https://user@github.com/")).toBeNull();
        expect(panelLinkTarget("file:///etc/passwd")).toBeNull();
        expect(panelLinkTarget("javascript:alert(1)")).toBeNull();
        expect(panelLinkTarget("not a url")).toBeNull();
    });
    it("chat bar replies open any web link, and nothing else", () => {
        expect(chatLinkTarget("https://nodejs.org/en/blog/release/v22.0.0")).toBe("https://nodejs.org/en/blog/release/v22.0.0");
        expect(chatLinkTarget("http://example.com/a?b=1")).toBe("http://example.com/a?b=1");
        expect(chatLinkTarget("https://user:pw@example.com/")).toBeNull();
        expect(chatLinkTarget("file:///etc/passwd")).toBeNull();
        expect(chatLinkTarget("javascript:alert(1)")).toBeNull();
        expect(chatLinkTarget("not a url")).toBeNull();
        const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
        expect(main).toContain("hardenBrowserWindow(overlayWindow, { webLinks: true });");
    });
});
