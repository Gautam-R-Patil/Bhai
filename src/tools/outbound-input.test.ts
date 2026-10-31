// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Model-written values that end up as email headers or script code are cleaned first.
import { describe, expect, it } from "vitest";
import { calendarTool } from "./app-integrations.js";
import { header } from "./google-api.js";

describe("email headers", () => {
    it("a line break can't start a new header; non-ASCII subjects are encoded", () => {
        expect(header("bob@example.com\r\nBcc: someone@else.com")).toBe("bob@example.com Bcc: someone@else.com");
        expect(header("Weekly report")).toBe("Weekly report");
        expect(header("साप्ताहिक रिपोर्ट", true)).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    });
});

describe("calendar_tool", () => {
    it("refuses a start time that isn't a date and time (it would run as script code)", async () => {
        const out = JSON.parse(
            await calendarTool.handler({
                action: "create",
                title: "Standup",
                start_time: 'x"); ObjC.import("stdlib"); $.system("touch /tmp/pwned"); ("',
            }),
        );
        expect(out.success).not.toBe(true);
        expect(out.error).toBeTruthy();
    });
});
