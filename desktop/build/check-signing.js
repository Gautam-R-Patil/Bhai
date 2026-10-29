// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// F6: fail the build in CI when signing isn't configured.
//
// In CI (CI=true) producing an unsigned artifact is wrong — both Gatekeeper
// (macOS) and SmartScreen (Windows) will reject it. We'd rather fail loudly
// at build time than ship something users can't open without right-click +
// Open or "More info → Run anyway".
//
// Configure by setting these env vars before `electron-builder`:
//   macOS:  CSC_LINK=/abs/path/to/cert.p12, CSC_KEY_PASSWORD=...,
//           APPLE_ID=..., APPLE_APP_SPECIFIC_PASSWORD=..., APPLE_TEAM_ID=...
//   Windows: CSC_LINK=/abs/path/to/cert.pfx, CSC_KEY_PASSWORD=...
//   Skip the check (local dev unsigned builds): SKIP_SIGNING_CHECK=true.
//
// Run via electron-builder's `beforeBuild` hook (wired in package.json) or
// directly: `node desktop/build/check-signing.js darwin`.

const platform = process.argv[2] || process.platform;

const isCI = process.env.CI === "true" || process.env.CI === "1";
const skip = process.env.SKIP_SIGNING_CHECK === "true";

if (skip) {
    console.log("[check-signing] SKIP_SIGNING_CHECK=true — skipping");
    process.exit(0);
}

let missing = [];

if (platform === "darwin" || platform === "mac") {
    if (!process.env.CSC_LINK && !process.env.CSC_NAME) {
        missing.push("CSC_LINK (path to .p12) or CSC_NAME (Keychain identity)");
    }
    if (process.env.CSC_LINK && !process.env.CSC_KEY_PASSWORD) {
        missing.push("CSC_KEY_PASSWORD (cert password)");
    }
    // Notarization is required for distribution outside the App Store on
    // macOS 10.15+. Only enforce in CI.
    if (isCI) {
        if (!process.env.APPLE_ID) missing.push("APPLE_ID (notarization)");
        if (!process.env.APPLE_APP_SPECIFIC_PASSWORD) {
            missing.push("APPLE_APP_SPECIFIC_PASSWORD (notarization)");
        }
        if (!process.env.APPLE_TEAM_ID) missing.push("APPLE_TEAM_ID (notarization)");
    }
} else if (platform === "win32" || platform === "win") {
    if (!process.env.CSC_LINK && !process.env.WIN_CSC_LINK) {
        missing.push("CSC_LINK or WIN_CSC_LINK (path to .pfx)");
    }
    if (!process.env.CSC_KEY_PASSWORD && !process.env.WIN_CSC_KEY_PASSWORD) {
        missing.push("CSC_KEY_PASSWORD (cert password)");
    }
}

if (missing.length > 0) {
    const msg = `[check-signing] Missing signing config for ${platform}:\n  - ${missing.join("\n  - ")}`;
    if (isCI) {
        console.error(msg);
        console.error("[check-signing] Refusing to produce an unsigned artifact in CI. Set SKIP_SIGNING_CHECK=true to override.");
        process.exit(1);
    } else {
        console.warn(msg);
        console.warn("[check-signing] Producing UNSIGNED build (local dev). In CI this would fail.");
    }
}

console.log(`[check-signing] OK (platform=${platform})`);
process.exit(0);
