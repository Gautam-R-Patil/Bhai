// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Pre-build script: Patches electron-builder's NSIS template to show
// file extraction details during installation instead of a blank log.

const fs = require("fs");
const path = require("path");

const templatePath = path.join(
    __dirname,
    "..",
    "node_modules",
    "app-builder-lib",
    "templates",
    "nsis",
    "installSection.nsh"
);

console.log("[NSIS Patch] Patching installSection.nsh to show install details...");

let content = fs.readFileSync(templatePath, "utf-8");

// Replace "SetDetailsPrint none" with "SetDetailsPrint textonly"
// This makes NSIS log each file being extracted, so the installer
// doesn't look stuck during the ~200MB extraction.
if (content.includes("SetDetailsPrint none")) {
    content = content.replace("SetDetailsPrint none", "SetDetailsPrint textonly");
    fs.writeFileSync(templatePath, content);
    console.log("[NSIS Patch] ✓ Changed SetDetailsPrint from 'none' to 'textonly'");
} else if (content.includes("SetDetailsPrint textonly")) {
    console.log("[NSIS Patch] Already patched — skipping.");
} else {
    console.log("[NSIS Patch] ⚠ Could not find SetDetailsPrint directive. Template may have changed.");
}
