// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    validateTelegramToken,
    validateDiscordToken,
    validateMatrixHomeserver,
    validateEmailConfig,
    canSaveWithTestId,
    ChannelCard,
} from "../../components/channel-card.js";

describe("validateTelegramToken", () => {
    it("accepts well-formed tokens", () => {
        expect(validateTelegramToken("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk")).toBe(true);
    });
    it("rejects malformed", () => {
        expect(validateTelegramToken("nope")).toBe(false);
        expect(validateTelegramToken("12345:short")).toBe(false);
        expect(validateTelegramToken("")).toBe(false);
        expect(validateTelegramToken(null)).toBe(false);
    });
});

describe("validateDiscordToken", () => {
    it("accepts 50+ char base64-ish", () => {
        expect(validateDiscordToken("A".repeat(55) + "._-")).toBe(true);
    });
    it("rejects short/empty", () => {
        expect(validateDiscordToken("short")).toBe(false);
        expect(validateDiscordToken("")).toBe(false);
        expect(validateDiscordToken(null)).toBe(false);
    });
});

describe("validateMatrixHomeserver", () => {
    it("accepts https/http", () => {
        expect(validateMatrixHomeserver("https://matrix.org")).toBe(true);
        expect(validateMatrixHomeserver("http://localhost:8008")).toBe(true);
    });
    it("rejects bad", () => {
        expect(validateMatrixHomeserver("matrix.org")).toBe(false);
        expect(validateMatrixHomeserver("ftp://x")).toBe(false);
        expect(validateMatrixHomeserver("")).toBe(false);
        expect(validateMatrixHomeserver(null)).toBe(false);
    });
});

describe("validateEmailConfig", () => {
    const good = { imapHost: "imap.gmail.com", imapPort: 993, imapTls: true, smtpHost: "smtp.gmail.com", smtpPort: 587, smtpTls: true, user: "a@b.co", password: "x" };
    it("passes with all fields and numeric ports", () => {
        expect(validateEmailConfig(good)).toBe(true);
    });
    it("fails when missing", () => {
        expect(validateEmailConfig({ imapHost: "a" })).toBe(false);
        expect(validateEmailConfig(null)).toBe(false);
    });
    it("fails on non-numeric ports", () => {
        const c = Object.assign({}, good, { imapPort: "x" });
        expect(validateEmailConfig(c)).toBe(false);
    });
});

describe("canSaveWithTestId", () => {
    const now = 1000000;
    it("matches pending id within 60s", () => {
        expect(canSaveWithTestId("abc", { abc: now - 30000 }, now)).toBe(true);
    });
    it("rejects missing id", () => {
        expect(canSaveWithTestId("xyz", {}, now)).toBe(false);
    });
    it("rejects expired (>60s)", () => {
        expect(canSaveWithTestId("abc", { abc: now - 61000 }, now)).toBe(false);
    });
    it("rejects nullish id", () => {
        expect(canSaveWithTestId(null, { abc: now }, now)).toBe(false);
        expect(canSaveWithTestId("abc", null, now)).toBe(false);
    });
});

describe("ChannelCard DOM", () => {
    let atlasCalls;
    beforeEach(() => {
        atlasCalls = { tests: [], saves: [], slackStarts: 0, whatsAppHandlers: [] };
        window.atlas = {
            setupTestChannel: async (type, creds) => {
                atlasCalls.tests.push({ type, creds });
                return { ok: true, testId: "test-" + Date.now() };
            },
            setupSaveChannel: async (type, creds, testId) => {
                atlasCalls.saves.push({ type, creds, testId });
                return { ok: true };
            },
            setupSlackOAuthStart: () => { atlasCalls.slackStarts += 1; return Promise.resolve({ ok: true }); },
            onWhatsAppQR: (handler) => { atlasCalls.whatsAppHandlers.push(handler); },
            waGenerateOTP: () => Promise.resolve({}),
            setupWaPairStart: async () => { atlasCalls.waPairStarts = (atlasCalls.waPairStarts || 0) + 1; return { ok: true }; },
        };
    });
    afterEach(() => { delete window.atlas; });

    it("mount throws on falsy container", () => {
        const cc = new ChannelCard({ type: "telegram" });
        expect(() => cc.mount(null)).toThrow(/container is required/);
    });

    it("telegram: renders token + allowedIds fields and Test/Save buttons with Save disabled", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        new ChannelCard({ type: "telegram" }).mount(c);
        expect(c.querySelector("[data-sp-field='token']")).toBeTruthy();
        expect(c.querySelector("[data-sp-field='allowedIds']")).toBeTruthy();
        const test = c.querySelector("button.sp-btn.sp-btn--ghost");
        const save = c.querySelector("button.sp-btn:not(.sp-btn--ghost)");
        expect(test.textContent).toBe("Test");
        expect(save.textContent).toBe("Save");
        expect(save.disabled).toBe(true);
    });

    it("telegram: invalid creds → Test fails with status + save stays disabled", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        new ChannelCard({ type: "telegram" }).mount(c);
        c.querySelector("[data-sp-field='token']").value = "bad";
        c.querySelector("[data-sp-field='allowedIds']").value = "123";
        c.querySelector("button.sp-btn.sp-btn--ghost").click();
        await Promise.resolve();
        expect(atlasCalls.tests).toEqual([]);
        const status = c.querySelector("[data-sp-status]");
        expect(status.className).toMatch(/sp-channel__status--bad/);
        expect(status.style.display).toBe("block");
        const save = c.querySelector("button.sp-btn:not(.sp-btn--ghost)");
        expect(save.disabled).toBe(true);
    });

    it("telegram: valid creds → Test passes, Save enabled, Save fires setupSaveChannel with testId", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const onSaved = [];
        new ChannelCard({ type: "telegram", onSaved: (t) => onSaved.push(t) }).mount(c);
        c.querySelector("[data-sp-field='token']").value = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk";
        c.querySelector("[data-sp-field='allowedIds']").value = "12345";
        c.querySelector("button.sp-btn.sp-btn--ghost").click();
        // Let test IPC resolve
        await Promise.resolve(); await Promise.resolve();
        const save = c.querySelector("button.sp-btn:not(.sp-btn--ghost)");
        expect(save.disabled).toBe(false);
        expect(atlasCalls.tests.length).toBe(1);
        expect(atlasCalls.tests[0].type).toBe("telegram");
        save.click();
        await Promise.resolve(); await Promise.resolve();
        expect(atlasCalls.saves.length).toBe(1);
        expect(atlasCalls.saves[0].type).toBe("telegram");
        expect(atlasCalls.saves[0].testId).toMatch(/^test-\d+$/);
        expect(onSaved).toEqual(["telegram"]);
    });

    it("email: Gmail preset auto-fills hosts and ports", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        new ChannelCard({ type: "email" }).mount(c);
        const preset = c.querySelector("[data-sp-field='preset']");
        preset.value = "gmail";
        preset.dispatchEvent(new Event("change"));
        expect(c.querySelector("[data-sp-field='imapHost']").value).toBe("imap.gmail.com");
        expect(c.querySelector("[data-sp-field='smtpHost']").value).toBe("smtp.gmail.com");
        expect(c.querySelector("[data-sp-field='imapPort']").value).toBe("993");
        expect(c.querySelector("[data-sp-field='smtpPort']").value).toBe("587");
    });

    it("email: Outlook preset auto-fills hosts and ports", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        new ChannelCard({ type: "email" }).mount(c);
        const preset = c.querySelector("[data-sp-field='preset']");
        preset.value = "outlook";
        preset.dispatchEvent(new Event("change"));
        expect(c.querySelector("[data-sp-field='imapHost']").value).toBe("outlook.office365.com");
        expect(c.querySelector("[data-sp-field='smtpHost']").value).toBe("smtp.office365.com");
    });

    it("slack: renders Install button that calls setupSlackOAuthStart", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        new ChannelCard({ type: "slack" }).mount(c);
        const btn = c.querySelector("button.sp-btn");
        expect(btn.textContent).toBe("Install to workspace");
        btn.click();
        expect(atlasCalls.slackStarts).toBe(1);
    });

    it("whatsapp: renders Generate QR button that subscribes to onWhatsAppQR", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        new ChannelCard({ type: "whatsapp" }).mount(c);
        const btn = c.querySelector("button.sp-btn");
        expect(btn.textContent).toBe("Generate QR");
        btn.click();
        expect(atlasCalls.whatsAppHandlers.length).toBe(1);
    });

    it("whatsapp: Generate QR also invokes setupWaPairStart", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        new ChannelCard({ type: "whatsapp" }).mount(c);
        c.querySelector("button.sp-btn").click();
        await Promise.resolve(); await Promise.resolve();
        expect(atlasCalls.waPairStarts).toBe(1);
    });

    it("discord: renders only a token field + Test/Save", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        new ChannelCard({ type: "discord" }).mount(c);
        expect(c.querySelector("[data-sp-field='token']")).toBeTruthy();
        expect(c.querySelector("[data-sp-field='allowedIds']")).toBeNull();
    });

    it("matrix: renders homeserver + token fields", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        new ChannelCard({ type: "matrix" }).mount(c);
        expect(c.querySelector("[data-sp-field='homeserver']")).toBeTruthy();
        expect(c.querySelector("[data-sp-field='token']")).toBeTruthy();
    });
});
