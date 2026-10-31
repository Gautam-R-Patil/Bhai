// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Mac builds are re-signed with the stable local identity after electron-builder
// signs them and before it makes the zip and DMG, so Squirrel.Mac accepts the
// next update (an ad-hoc signature's requirement is its cdhash, new every build).
import path from "node:path";
import { describe, expect, it } from "vitest";

const afterSign = require("../build/after-sign.js").default;

const context = (platform, mac = { identity: "-" }) => ({
    electronPlatformName: platform,
    appOutDir: "/out/mac-arm64",
    packager: { appInfo: { productFilename: "Bhai" }, platformSpecificBuildOptions: mac },
});

describe("afterSign", () => {
    it("re-signs the Mac app with resign-local.sh", async () => {
        const calls = [];
        await afterSign(context("darwin"), (...args) => calls.push(args));
        expect(calls).toHaveLength(1);
        const [cmd, args, opts] = calls[0];
        expect(cmd).toBe("bash");
        expect(args).toEqual([path.join(__dirname, "..", "build", "resign-local.sh"), "/out/mac-arm64/Bhai.app"]);
        expect(opts.cwd).toBe(path.join(__dirname, ".."));
    });

    it("leaves a Developer ID (or keychain-picked) signature and its notarization alone", async () => {
        const calls = [];
        const record = (...args) => calls.push(args);
        await afterSign(context("darwin", { identity: "Developer ID Application: TRUSCOR Private Limited (TEAMID)", notarize: true }), record);
        await afterSign(context("darwin", {}), record); // electron-builder picks the keychain's identity
        await afterSign(context("darwin", { identity: null }), record); // not signed at all
        expect(calls).toHaveLength(0);
    });

    it("does nothing on other platforms", async () => {
        const calls = [];
        await afterSign(context("win32"), (...args) => calls.push(args));
        expect(calls).toHaveLength(0);
    });
});
