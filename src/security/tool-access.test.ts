// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { isToolAllowed, NON_OWNER_TOOLS } from "./tool-access.js";

describe("tool access", () => {
    it("an owner (no allowlist) gets everything", () => {
        expect(isToolAllowed(undefined, "shell_exec")).toBe(true);
    });
    it("an empty allowlist means no tools, not all tools", () => {
        expect(isToolAllowed([], "shell_exec")).toBe(false);
        expect(isToolAllowed([], "get_current_time")).toBe(true);
    });
    it("the non-owner default has nothing that acts as the owner", () => {
        for (const t of ["shell_exec", "write", "os_type", "browser_navigate", "whatsapp_send", "email_send", "apple_script"]) {
            expect(isToolAllowed(NON_OWNER_TOOLS, t)).toBe(false);
        }
        expect(isToolAllowed(NON_OWNER_TOOLS, "web_search")).toBe(true);
    });
});
