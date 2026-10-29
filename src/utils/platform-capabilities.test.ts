// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import {
    formatCapabilitiesForContext,
    type PlatformCapabilities,
} from "./platform-capabilities.js";

// Skip the async probe path (getPlatformCapabilities) — exercising it needs
// child_process mocking across darwin/win32/linux code paths. Instead, verify
// the pure formatter against hand-crafted capability snapshots.

function capsFor(platform: "darwin" | "win32" | "linux"): PlatformCapabilities {
    return {
        platform,
        arch: "arm64",
        osRelease: "25.4.0",
        shell: { type: "bash", path: "/bin/bash" },
        screenshot: { available: true, engine: "screencapture" },
        clipboard: { available: true, engine: "pbcopy" },
        ocr: { available: true, engine: "swift" },
        appAutomation: {
            applescript: true,
            powershellHelpers: false,
            xdotool: false,
            ydotool: false,
        },
        location: { available: true, engine: "corelocation" },
        browser: { playwright: true, nativeMessaging: false },
        nativeModule: { loaded: true },
        audio: { portaudio: false },
    };
}

describe("formatCapabilitiesForContext", () => {
    it("includes platform, arch, and OS release", () => {
        const out = formatCapabilitiesForContext(capsFor("darwin"));
        expect(out).toContain("Platform: darwin (arm64)");
        expect(out).toContain("OS 25.4.0");
    });

    it("includes shell type and path", () => {
        const out = formatCapabilitiesForContext(capsFor("darwin"));
        expect(out).toContain("Shell: bash (/bin/bash)");
    });

    it("reports screenshot engine when available", () => {
        const out = formatCapabilitiesForContext(capsFor("darwin"));
        expect(out).toContain("Screenshot: screencapture");
    });

    it("reports 'unavailable' when screenshot engine is null", () => {
        const caps = capsFor("linux");
        caps.screenshot = { available: false, engine: null };
        const out = formatCapabilitiesForContext(caps);
        expect(out).toContain("Screenshot: unavailable");
    });

    it("reports clipboard and OCR engines symmetrically", () => {
        const caps = capsFor("linux");
        caps.clipboard = { available: false, engine: null };
        caps.ocr = { available: false, engine: null };
        const out = formatCapabilitiesForContext(caps);
        expect(out).toContain("Clipboard: unavailable");
        expect(out).toContain("OCR: unavailable");
    });

    it("app automation list shows only TRUE flags, joined by commas", () => {
        const caps = capsFor("linux");
        caps.appAutomation = {
            applescript: false,
            powershellHelpers: false,
            xdotool: true,
            ydotool: true,
        };
        const out = formatCapabilitiesForContext(caps);
        expect(out).toContain("App automation: xdotool, ydotool");
    });

    it("app automation list shows 'none' when no automation available", () => {
        const caps = capsFor("darwin");
        caps.appAutomation = {
            applescript: false,
            powershellHelpers: false,
            xdotool: false,
            ydotool: false,
        };
        const out = formatCapabilitiesForContext(caps);
        expect(out).toContain("App automation: none");
    });

    it("browser line reports playwright + native-messaging booleans", () => {
        const out = formatCapabilitiesForContext(capsFor("darwin"));
        expect(out).toContain("Browser: playwright=true native-messaging=false");
    });

    it("native module loaded shows 'loaded (SIMD-accelerated)'", () => {
        const out = formatCapabilitiesForContext(capsFor("darwin"));
        expect(out).toContain("Native module: loaded (SIMD-accelerated)");
    });

    it("native module not loaded shows 'JS fallback'", () => {
        const caps = capsFor("linux");
        caps.nativeModule.loaded = false;
        const out = formatCapabilitiesForContext(caps);
        expect(out).toContain("Native module: JS fallback");
    });

    it("output is line-separated (multi-line summary, one field per line)", () => {
        const out = formatCapabilitiesForContext(capsFor("darwin"));
        const lines = out.split("\n");
        expect(lines.length).toBeGreaterThanOrEqual(8);
        // Sanity: every line starts with a capitalized label + colon
        for (const line of lines) {
            expect(line).toMatch(/^[A-Z][A-Za-z ]+:/);
        }
    });

    it("darwin happy path (pbcopy + swift OCR + corelocation)", () => {
        const out = formatCapabilitiesForContext(capsFor("darwin"));
        expect(out).toContain("Clipboard: pbcopy");
        expect(out).toContain("OCR: swift");
    });

    it("windows platform serializes distinct engine names", () => {
        const caps = capsFor("win32");
        caps.shell = { type: "powershell7", path: "pwsh.exe" };
        caps.screenshot = { available: true, engine: "system.drawing" };
        caps.clipboard = { available: true, engine: "clipboardy" };
        caps.ocr = { available: true, engine: "windows.media.ocr" };
        caps.location = { available: true, engine: "windows.geolocation" };
        const out = formatCapabilitiesForContext(caps);
        expect(out).toContain("Platform: win32 (arm64)");
        expect(out).toContain("Shell: powershell7 (pwsh.exe)");
        expect(out).toContain("Screenshot: system.drawing");
        expect(out).toContain("Clipboard: clipboardy");
        expect(out).toContain("OCR: windows.media.ocr");
    });
});
