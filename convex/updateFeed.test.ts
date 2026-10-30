// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { afterEach, describe, expect, it } from "vitest";
import { parseUpdateFeedPath, updateFeedResponse } from "./updateFeed.js";

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

const get = (file: string) => updateFeedResponse(new Request(`https://x.convex.site/api/updates/${file}`));
const before = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("UPDATE_")));
function publish(vars: Record<string, string | undefined>) {
    for (const k of Object.keys(process.env)) if (k.startsWith("UPDATE_")) delete process.env[k];
    Object.assign(process.env, vars);
}
afterEach(() => publish(before));

describe("updateFeedResponse", () => {
    it("answers 404, not a version 0.0.0 placeholder, while nothing is published", async () => {
        publish({});
        for (const f of ["stable-mac.yml", "stable.yml", "beta-mac.yml?channel=beta", "latest-mac.yml", "latest.yml", "nope.yml"]) {
            const r = get(f);
            expect(r.status, f).toBe(404);
            expect(await r.text()).not.toContain("0.0.0");
        }
    });

    it("serves the published release on the channel files", async () => {
        publish({ UPDATE_VERSION: "0.2.2", UPDATE_URL_WIN: "https://dl/x/Bhai Setup 0.2.2.exe", UPDATE_SHA512_WIN: "w", UPDATE_SIZE_WIN: "9" });
        const r = get("stable.yml");
        expect(r.status).toBe(200);
        expect(await r.text()).toContain("version: 0.2.2\nfiles:\n  - url: https://dl/x/Bhai Setup 0.2.2.exe\n    sha512: w\n    size: 9\n");
        expect(get("stable-mac.yml").status).toBe(404); // no Mac zip published
    });

    it("lists the Intel zip next to the arm64 one, and never offers an arm64-only feed to an Intel Mac", async () => {
        const arm = { UPDATE_VERSION: "0.2.2", UPDATE_URL_MAC: "https://dl/Bhai-0.2.2-arm64-mac.zip", UPDATE_SHA512_MAC: "a" };
        publish(arm);
        expect(get("stable-mac.yml").status).toBe(200);
        expect(get("stable-mac.yml?arch=x64").status).toBe(404);
        publish({ ...arm, UPDATE_URL_MAC_X64: "https://dl/Bhai-0.2.2-mac.zip", UPDATE_SHA512_MAC_X64: "i", UPDATE_SIZE_MAC_X64: "7" });
        for (const f of ["stable-mac.yml", "stable-mac.yml?arch=x64"]) {
            const r = get(f);
            expect(r.status).toBe(200);
            expect(await r.text()).toContain(
                "  - url: https://dl/Bhai-0.2.2-arm64-mac.zip\n    sha512: a\n    size: 0\n  - url: https://dl/Bhai-0.2.2-mac.zip\n    sha512: i\n    size: 7\n",
            );
        }
    });

    it("never pairs a beta arm64 zip with the stable Intel zip", async () => {
        publish({
            UPDATE_VERSION_BETA: "0.3.0-beta.1",
            UPDATE_URL_MAC_BETA: "https://dl/beta/Bhai-0.3.0-beta.1-arm64-mac.zip",
            UPDATE_VERSION: "0.2.2",
            UPDATE_URL_MAC: "https://dl/Bhai-0.2.2-arm64-mac.zip",
            UPDATE_URL_MAC_X64: "https://dl/Bhai-0.2.2-mac.zip",
        });
        const r = get("beta-mac.yml?channel=beta");
        expect(await r.text()).not.toContain("Bhai-0.2.2-mac.zip");
        expect(get("beta-mac.yml?channel=beta&arch=x64").status).toBe(404);
        expect(get("stable-mac.yml?arch=x64").status).toBe(200);
    });
});
