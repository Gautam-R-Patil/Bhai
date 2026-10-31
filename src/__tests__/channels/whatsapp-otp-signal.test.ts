// © 2024-2026 XAGI Labs Private Limited
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("WhatsApp OTP from the desktop's New Code button", () => {
    it("accepts the desktop's code once, rejects bad or expired ones", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-otp-"));
        process.env.BHAI_DATA_DIR = dir;
        const users = await import("../../whatsapp-users.js");
        const signal = path.join(dir, "whatsapp-otp-signal.json");

        users.generateOTP();
        fs.writeFileSync(signal, JSON.stringify({ code: "123456", expiresAt: Date.now() + 60_000 }));
        expect(users.getActiveOTP()).toBe("123456");
        expect(fs.existsSync(signal)).toBe(false);
        expect(users.verifyOTP("911234567890@s.whatsapp.net", "123456")).toBe(true);
        expect(users.isOwner("911234567890@s.whatsapp.net")).toBe(true);

        fs.writeFileSync(signal, JSON.stringify({ code: "654321", expiresAt: Date.now() - 1 }));
        expect(users.getActiveOTP()).toBe(null);
        fs.writeFileSync(signal, JSON.stringify({ code: "12ab56", expiresAt: Date.now() + 60_000 }));
        expect(users.getActiveOTP()).toBe(null);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
