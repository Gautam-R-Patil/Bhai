// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { assembleToolNames } from "./tool-router.js";

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

    it("never exceeds the total cap", () => {
        const got = assembleToolNames(["os_control", "communication"], [...OS, ...COMM], ALL, 8);
        expect(got.size).toBe(8);
    });
});
