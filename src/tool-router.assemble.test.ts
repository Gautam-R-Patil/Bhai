// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { assembleToolNames, KEYWORD_BOOSTS } from "./tool-router.js";

const OS = ["os_smart_click", "os_inspect", "os_click_id", "os_type", "os_screenshot", "os_click", "os_visual_verify",
    "os_keyboard_shortcuts", "os_context", "apple_script", "os_computer_action", "os_zoom_region", "os_ocr_click", "os_nav"];
const COMM = ["email_send", "messages_tool", "send_file", "send_message_on_channel", "whatsapp_send", "contact_lookup"];
const MEMORY_REST = ["memory_list", "memory_delete", "identity_view", "core_memory_read"];
const ALL = new Set([...OS, ...COMM, "app_manager", "window_manage", "get_current_time", "create_tool",
    "memory_store", "memory_search", ...MEMORY_REST]);

describe("assembleToolNames", () => {
    it("only memory_store/memory_search are always on", () => {
        const got = assembleToolNames(["core"], [], ALL, 36);
        expect(got.has("memory_store") && got.has("memory_search")).toBe(true);
        for (const t of MEMORY_REST) expect(got.has(t)).toBe(false);
    });

    it("a broad category ranked first can't starve a narrow one", () => {
        // whatsapp_send ranked into communication's floor (as a classifier specific_tool would)
        const candidates = [...OS, "app_manager", "window_manage", "whatsapp_send", ...COMM];
        const got = assembleToolNames(["os_control", "app_management", "communication"], candidates, ALL, 14);
        expect(got.size).toBeLessThanOrEqual(14);
        expect(got.has("whatsapp_send")).toBe(true);
        expect(got.has("email_send")).toBe(true); // primary
        expect(got.has("app_manager")).toBe(true);
        expect(got.has("os_smart_click")).toBe(true);
    });

    it("fills round-robin: a first category's tail can't take a tied one's next tool", () => {
        // "Use Calculator to work out 42×3, copy the result to my clipboard": system_controls'
        // tail took the slots and os_control lost os_type.
        const SYS = ["set_volume", "clipboard", "system_info", "wifi_control", "dark_mode", "lock_screen", "sleep_display"];
        const all = new Set([...ALL, ...SYS]);
        // As in the real list: app_manager second, so os_type is os_control's fifth.
        const os = ["os_smart_click", "app_manager", "os_inspect", "os_click_id", "os_type", "os_screenshot"];
        // 2 always-on + a floor of 4 each + 2 more: one more per category.
        const got = assembleToolNames(["system_controls", "os_control"], [...SYS, ...os], all, 12);
        expect(got.size).toBe(12);
        expect(got.has("os_type")).toBe(true);
    });

    it("never exceeds the total cap", () => {
        const got = assembleToolNames(["os_control", "communication"], [...OS, ...COMM], ALL, 8);
        expect(got.size).toBe(8);
    });

    it("a browser turn also gets web_read: reading a page needs no tab", () => {
        const all = new Set(["browser_navigate", "browser_click", "web_read", "memory_store", "memory_search"]);
        expect(assembleToolNames(["browser"], ["browser_click"], all, 36).has("web_read")).toBe(true);
    });

    it("a question about something that changes brings web search", () => {
        const boosts = (m: string) => KEYWORD_BOOSTS.filter((b) => b.minScore >= 0.7 && b.pattern.test(m)).map((b) => b.category);
        expect(boosts("Has Node.js 26 become an LTS release yet?")).toContain("web_search");
        expect(boosts("what's the latest on the Artemis launch")).toContain("web_search");
        expect(boosts("thanks bhai, good night")).not.toContain("web_search");
    });
});
