// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveSettingsUrl } from "../system-controls.js";

// Reads the panes this Mac ships, so it only runs where they exist.
describe.skipIf(!existsSync("/System/Library/ExtensionKit/Extensions"))("resolveSettingsUrl", () => {
    it.each([
        ["Wi-Fi settings", "wifi-settings-extension"],
        ["bluetooth", "BluetoothSettings"],
        ["dark mode", "Appearance-Settings"],
        ["software update", "Software-Update-Settings"],
        ["accessibility", "Accessibility-Settings"],
        ["accessibility access", "PrivacySecurity.extension?Privacy_Accessibility"],
        ["camera", "PrivacySecurity.extension?Privacy_Camera"],
        ["full disk access", "PrivacySecurity.extension?Privacy_AllFiles"],
    ])("%s", async (pane, expected) => {
        expect(await resolveSettingsUrl(pane)).toContain(expected);
    });

    it("returns null for an unknown pane", async () => {
        expect(await resolveSettingsUrl("bogusxyz")).toBeNull();
    });
});
