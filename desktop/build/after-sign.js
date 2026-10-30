// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// afterSign runs after electron-builder signs the app and before it makes the
// zip and DMG. On a Mac it re-signs with the stable "Bhai Local Signing"
// identity (resign-local.sh; keeps the ad-hoc signature when there is none):
// Squirrel.Mac only installs an update whose signature meets the running app's
// designated requirement, and an ad-hoc one is its cdhash, new every build.
const path = require("node:path");
const { execFileSync } = require("node:child_process");

exports.default = async function afterSign(context, run = execFileSync) {
    if (context.electronPlatformName !== "darwin") return;
    const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    run("bash", [path.join(__dirname, "resign-local.sh"), app], {
        cwd: path.join(__dirname, ".."),
        stdio: "inherit",
    });
};
