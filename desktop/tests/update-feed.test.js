// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { updateFeedUrl } from "../update-feed.js";

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
