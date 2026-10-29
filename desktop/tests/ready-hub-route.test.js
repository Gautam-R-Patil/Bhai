// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Ready Hub Settings-subsection tiles must land on the Settings tab, not
// Dashboard. The panel hash router (panel.html _applyHashTab) resolves the
// FIRST [:?/] segment of the hash to a tab id, so the hash must keep the
// "settings:" prefix — stripping it produced e.g. "#hotkey" with no matching
// tab, silently leaving the panel on the default Dashboard tab.
import { describe, it, expect } from "vitest";
import ReadyHubBody from "../components/ready-hub-body.js";

const { tileRouteHref } = ReadyHubBody;

// Mirrors panel.html _applyHashTab: first segment of the hash is the tab id.
function tabFromHref(href) {
    const hash = (href.split("#")[1] || "");
    return hash.split(/[:?/]/)[0];
}

describe("tileRouteHref — settings subsections resolve to the Settings tab", () => {
    for (const section of ["hotkey", "workspace", "voice", "theme", "google", "wake"]) {
        it(`settings:${section} → #settings:${section} (tab "settings")`, () => {
            const href = tileRouteHref("settings:" + section);
            expect(href).toBe("panel.html#settings:" + section);
            expect(tabFromHref(href)).toBe("settings");
        });
    }

    it("channels route goes to channels.html", () => {
        expect(tileRouteHref("channels")).toBe("channels.html");
    });

    it("wizard routes go to wizard.html", () => {
        expect(tileRouteHref("wizard:permissions")).toBe("wizard.html");
    });

    it("returns null for unknown / empty routes", () => {
        expect(tileRouteHref("")).toBeNull();
        expect(tileRouteHref(null)).toBeNull();
        expect(tileRouteHref("nope")).toBeNull();
    });
});
