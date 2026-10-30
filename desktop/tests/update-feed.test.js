// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { checkResult, updateFeedUrl } from "../update-feed.js";

const BASE = "https://x.convex.site/api/updates";
const intel = {
    platform: "darwin",
    arch: "x64",
    osVersion: "Darwin Kernel Version 23.0.0; root:xnu-10002/RELEASE_X86_64",
};
const silicon = {
    platform: "darwin",
    arch: "arm64",
    osVersion: "Darwin Kernel Version 23.0.0; root:xnu-10002/RELEASE_ARM64_T6020",
};

describe("update feed URL", () => {
    it("tells the server an Intel Mac can't install an arm64 zip", () => {
        expect(updateFeedUrl(BASE, "stable", intel)).toBe(`${BASE}?arch=x64`);
        expect(updateFeedUrl(BASE, "beta", intel)).toBe(`${BASE}?channel=beta&arch=x64`);
    });

    it("leaves Apple Silicon (also an x64 build under Rosetta), Windows and Linux as they were", () => {
        expect(updateFeedUrl(BASE, "stable", silicon)).toBe(BASE);
        expect(updateFeedUrl(BASE, "alpha", { ...silicon, arch: "x64" })).toBe(`${BASE}?channel=alpha`);
        expect(updateFeedUrl(BASE, "stable", { platform: "win32", arch: "x64", osVersion: "Windows 11 Pro" })).toBe(
            BASE,
        );
        expect(updateFeedUrl(BASE, "beta", { platform: "linux", arch: "x64", osVersion: "#1 SMP" })).toBe(
            `${BASE}?channel=beta`,
        );
    });
});

describe("Check for updates", () => {
    it("reads a feed with nothing published (404) as up to date, not as an error", async () => {
        const missing = Object.assign(
            new Error('Cannot find channel "stable-mac.yml" update info: HttpError: 404 Not Found'),
            {
                code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
            },
        );
        expect(await checkResult(() => Promise.reject(missing))).toEqual({ available: false });
        expect(await checkResult(() => Promise.reject(new Error("net::ERR_INTERNET_DISCONNECTED")))).toEqual({
            error: "net::ERR_INTERNET_DISCONNECTED",
        });
    });

    it("offers a version only when electron-updater says it is an update", async () => {
        const info = { version: "0.2.1" };
        expect(await checkResult(async () => ({ isUpdateAvailable: false, updateInfo: info }))).toEqual({
            available: false,
            version: "0.2.1",
        });
        expect(await checkResult(async () => ({ isUpdateAvailable: true, updateInfo: { version: "0.2.2" } }))).toEqual({
            available: true,
            version: "0.2.2",
        });
        expect(await checkResult(async () => null)).toEqual({ available: false, version: undefined });
    });
});
