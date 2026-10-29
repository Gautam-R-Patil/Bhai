// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { afterEach, describe, expect, it } from "vitest";
import {
    _resetExtensionIdsForTests,
    bhaiExtensionIds,
    isForeignExtensionOrigin,
    unpackedExtensionId,
} from "./extension-origin.js";

afterEach(() => {
    delete process.env.ATLAS_EXTENSION_IDS;
    _resetExtensionIdsForTests();
});

describe("unpackedExtensionId", () => {
    it("matches the ID Chrome gave Bhai's extension loaded from the app bundle", () => {
        // Read from a real Chrome profile that loaded it unpacked from this path.
        expect(unpackedExtensionId("/Applications/Bhai.app/Contents/Resources/chrome-extension")).toBe(
            "pdpbjdgpkfookinmcmnfdalkngonfejg",
        );
    });
});

describe("isForeignExtensionOrigin", () => {
    it("refuses any extension but Bhai's own", () => {
        const ours = unpackedExtensionId("/Applications/Bhai.app/Contents/Resources/chrome-extension");
        process.env.ATLAS_EXTENSION_IDS = ours;
        expect(bhaiExtensionIds()?.has(ours)).toBe(true);
        expect(isForeignExtensionOrigin(`chrome-extension://${ours}`)).toBe(false);
        expect(isForeignExtensionOrigin(`chrome-extension://${"a".repeat(32)}`)).toBe(true);
        expect(isForeignExtensionOrigin("chrome-extension://not-an-id")).toBe(true);
    });

    it("leaves web and no-origin callers to the other checks", () => {
        expect(isForeignExtensionOrigin(undefined)).toBe(false);
        expect(isForeignExtensionOrigin("https://evil.example")).toBe(false);
    });

    it("pins the extension shipped in this checkout without any setting", () => {
        if (process.platform === "win32") return;
        expect(bhaiExtensionIds()?.size).toBeGreaterThan(0); // <repo>/chrome-extension exists here
    });
});
