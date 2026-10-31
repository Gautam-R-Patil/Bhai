// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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
            "spotify", "set_volume",
            "web_search", "get_current_time",
            "memory_store", "memory_search",
        ]) {
            expect(names).toContain(expected);
        }
    });

    it("exposes delegation surfaces so Gemini can hand complex work to the agent swarm", () => {
        const names = getVoiceToolNames();
        // The core delegation pattern — "swarm_task" for multi-step work,
        // "start_long_task" for background, "deep_research" for research.
        for (const expected of [
            "swarm_task",
            "start_long_task", "check_long_task",
            "deep_research", "check_deep_research",
        ]) {
            expect(names).toContain(expected);
        }
    });

    it("exposes OS-control so 'click that', 'open Bluetooth settings' work with screen share", () => {
        const names = getVoiceToolNames();
        for (const expected of [
            "os_click_element", "os_type",
            "os_multi_action",
            "bluetooth_control", "wifi_control",
        ]) {
            expect(names).toContain(expected);
        }
    });

    it("exposes productivity tools so 'email X', 'remind me', 'message Y' all work", () => {
        const names = getVoiceToolNames();
        for (const expected of [
            "gmail", "calendar_tool", "reminders_tool",
            "whatsapp_send", "contact_lookup",
            "set_reminder",
        ]) {
            expect(names).toContain(expected);
        }
    });

    it("leaves image generation to the agent, which can deliver it", () => {
        expect(getVoiceToolNames()).not.toContain("generate_image");
    });

    it("keeps the tool count tight for Gemini Live latency", () => {
        // If this grows past ~40 we'll regress response audio generation
        // (we learned this the hard way at 113 tools).
        const names = getVoiceToolNames();
        expect(names.length).toBeLessThan(45);
    });
});
