// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, afterEach } from "vitest";
import { getVoiceToolNames } from "./types.js";

const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: p, configurable: true });
}

describe("getVoiceToolNames — platform-gated voice tool list", () => {
    afterEach(() => setPlatform(originalPlatform));

    it("includes browser_navigate so 'open YouTube' doesn't fall back to shell_exec", () => {
        const names = getVoiceToolNames();
        expect(names).toContain("browser_navigate");
    });

    it("includes open_in_app as a cross-platform app launcher", () => {
        const names = getVoiceToolNames();
        expect(names).toContain("open_in_app");
    });

    it("includes apple_script on macOS", () => {
        setPlatform("darwin");
        const names = getVoiceToolNames();
        expect(names).toContain("apple_script");
    });

    it("excludes apple_script on linux", () => {
        setPlatform("linux");
        const names = getVoiceToolNames();
        expect(names).not.toContain("apple_script");
    });

    it("excludes apple_script on win32", () => {
        setPlatform("win32");
        const names = getVoiceToolNames();
        expect(names).not.toContain("apple_script");
    });

    it("keeps the media + core tool set intact", () => {
        const names = getVoiceToolNames();
        for (const expected of [
            "spotify", "music_control", "set_volume",
            "web_search", "get_current_time",
            "memory_store", "memory_search",
            "read", "write",
        ]) {
            expect(names).toContain(expected);
        }
    });
});
