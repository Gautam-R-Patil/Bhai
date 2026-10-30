// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import { panelLinkTarget } from "../panel-links.js";

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
});
