// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const html = readFileSync(join(process.cwd(), "wizard.html"), "utf8");

describe("wizard.html shell", () => {
    beforeAll(() => { document.documentElement.innerHTML = html; });
    it("has the four required containers", () => {
        expect(document.getElementById("wizard-header")).toBeTruthy();
        expect(document.getElementById("step-dots")).toBeTruthy();
        expect(document.getElementById("already-set-strip")).toBeTruthy();
        expect(document.getElementById("current-step")).toBeTruthy();
    });
    it("loads all required component + step scripts", () => {
        const srcs = Array.from(document.querySelectorAll("script[src]")).map((s) => s.getAttribute("src"));
        [
            "wizard/router.js",
            "components/status-tile.js",
            "components/permissions-grid.js",
            "components/hotkey-picker.js",
            "components/channel-card.js",
            "components/voice-picker.js",
            "components/theme-switch.js",
            "components/install-log.js",
            "wizard/chips.js",
            "wizard/steps/welcome.js",
            "wizard/steps/signin.js",
            "wizard/steps/profile.js",
            "wizard/steps/personalize.js",
            "wizard/steps/permissions.js",
            "wizard/steps/install.js",
            "wizard/boot.js",
        ].forEach((src) => expect(srcs).toContain(src));
    });
    it("links components.css AND styles.css", () => {
        const hrefs = Array.from(document.querySelectorAll("link[rel='stylesheet']")).map((l) => l.getAttribute("href"));
        expect(hrefs).toContain("styles.css");
        expect(hrefs).toContain("components/components.css");
    });
});
