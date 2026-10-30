// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { parseUpdateFeedPath } from "./updateFeed.js";

describe("parseUpdateFeedPath", () => {
    it("serves the channel files electron-updater asks for once the app sets a channel", () => {
        expect(parseUpdateFeedPath("/api/updates/stable-mac.yml")).toEqual({ platform: "mac", channel: "stable" });
        expect(parseUpdateFeedPath("/api/updates/beta-mac.yml")).toEqual({ platform: "mac", channel: "beta" });
        expect(parseUpdateFeedPath("/api/updates/stable.yml")).toEqual({ platform: "win", channel: "stable" });
        expect(parseUpdateFeedPath("/api/updates/canary.yml")).toEqual({ platform: "win", channel: "canary" });
    });

    it("still serves latest*.yml, with the channel from the query", () => {
        expect(parseUpdateFeedPath("/api/updates/latest-mac.yml")).toEqual({ platform: "mac", channel: null });
        expect(parseUpdateFeedPath("/api/updates/latest.yml")).toEqual({ platform: "win", channel: null });
    });

    it("rejects anything else", () => {
        for (const p of ["/api/updates/", "/api/updates/nightly-mac.yml", "/api/updates/stable-linux.yml", "/api/updates/x/stable.yml"]) {
            expect(parseUpdateFeedPath(p)).toBeNull();
        }
    });
});
