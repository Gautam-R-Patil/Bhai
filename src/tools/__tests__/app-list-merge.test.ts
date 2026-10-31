// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { mergeAppsByName } from "../app-integrations.js";

describe("app_manager list", () => {
    it("lists an app once even when two processes share its name", () => {
        const apps = mergeAppsByName([
            { name: "Google Chrome", frontmost: true, visible: true },
            { name: "Finder", frontmost: false, visible: true },
            { name: "Google Chrome", frontmost: false, visible: false },
        ]);
        expect(apps).toEqual([
            { name: "Google Chrome", frontmost: true, visible: true },
            { name: "Finder", frontmost: false, visible: true },
        ]);
    });
});
