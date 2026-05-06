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

    it("exposes delegation surfaces so Gemini can hand complex work to the agent swarm", () => {
        const names = getVoiceToolNames();
        for (const expected of [
            "swarm_task",
            "start_long_task", "check_long_task", "cancel_long_task",
            "deep_research", "check_deep_research",
        ]) {
            expect(names).toContain(expected);
        }
    });

    it("exposes OS-control so 'click that', 'open Bluetooth settings' work with screen share", () => {
        const names = getVoiceToolNames();
        for (const expected of [
            "os_screenshot", "os_click_element", "os_type",
            "os_scan", "os_multi_action", "os_accessibility_tree",
        ]) {
            expect(names).toContain(expected);
        }
    });

    it("exposes productivity tools so 'make a PPT', 'email X', 'remind me' all work", () => {
        const names = getVoiceToolNames();
        for (const expected of [
            "create_presentation", "modify_presentation",
            "create_document", "gmail", "email_send",
            "calendar_tool", "reminders_tool",
            "whatsapp_send",
        ]) {
            expect(names).toContain(expected);
        }
    });
});
