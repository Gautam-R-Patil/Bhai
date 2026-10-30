// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it, vi } from "vitest";

vi.mock("./core.js", () => ({ waitForPageReady: vi.fn() }));
vi.mock("./chrome-bridge.js", () => ({ getExtensionCookies: vi.fn(), isExtensionConnected: () => false }));
vi.mock("./browser-backend.js", () => ({ getCurrentMode: () => "playwright" }));

const { classifyAuthWall, toPlaywrightCookies } = await import("./auth-wall.js");

const base = { password: false, otp: false, loginField: false, url: "https://x.com/home", title: "Home" };

describe("classifyAuthWall", () => {
    it("flags OTP fields anywhere, a password field only on a login-looking page", () => {
        expect(classifyAuthWall({ ...base, password: true })).toBeNull(); // forum header login box
        expect(classifyAuthWall({ ...base, password: true, url: "https://x.com/ap/signin" })).toBe("password");
        expect(classifyAuthWall({ ...base, password: true, title: "Amazon Sign-In" })).toBe("password");
        expect(classifyAuthWall({ ...base, password: true, title: "Enter your password" })).toBe("password");
        expect(classifyAuthWall({ ...base, otp: true, password: true })).toBe("otp");
    });
    it("needs a login field AND a login-looking page for sign_in", () => {
        expect(classifyAuthWall({ ...base, loginField: true })).toBeNull(); // newsletter email box
        expect(classifyAuthWall({ ...base, loginField: true, url: "https://x.com/login?next=/" })).toBe("sign_in");
        expect(classifyAuthWall({ ...base, loginField: true, title: "Sign in – Google Accounts" })).toBe("sign_in");
        expect(classifyAuthWall({ ...base, url: "https://x.com/signin" })).toBeNull();
    });
});

describe("detectAuthWall (in-page signals)", () => {
    it("sees password, split OTP boxes and nothing on a plain page", async (ctx) => {
        let browser: { newPage: () => Promise<any>; close: () => Promise<void> } | null = null;
        try {
            browser = await (await import("playwright-core")).chromium.launch({ headless: true });
        } catch {
            return ctx.skip();
        }
        const { detectAuthWall } = await import("./auth-wall.js");
        const page = await browser.newPage();
        await page.setContent(`<title>Log in</title><input type=email name=email><input type=password>`);
        expect(await detectAuthWall(page)).toBe("password");
        await page.setContent(`<title>Thread</title><input name=user><input type=password>`);
        expect(await detectAuthWall(page)).toBeNull();
        await page.setContent(`<input autocomplete=cc-number><input autocomplete=cc-csc placeholder="Security code">`);
        expect(await detectAuthWall(page)).toBeNull();
        await page.setContent(`<input placeholder="Card verification code">`);
        expect(await detectAuthWall(page)).toBeNull();
        for (const cvv of [
            `<input name=cvv2 placeholder="Security code">`,
            `<input name=cardCvv placeholder="Security code">`,
            `<input id=card_cvc placeholder="Security code">`,
            `<input autocomplete="billing cc-csc" placeholder="Security code">`,
            `<input name=cardNumber><input name=securityCode autocomplete=off placeholder="Security code">`,
        ]) {
            await page.setContent(cvv);
            expect(await detectAuthWall(page), cvv).toBeNull();
        }
        await page.setContent(`<input name=securityCode placeholder="Security code">`);
        expect(await detectAuthWall(page)).toBe("otp"); // no card fields: a login security code
        await page.setContent(`<input name=code placeholder="Enter verification code">`);
        expect(await detectAuthWall(page)).toBe("otp");
        for (const otp of [
            `<input name=otp placeholder="Enter OTP sent for card ending 4242">`,
            `<input name=code placeholder="Verification code sent to your card ending 1234">`,
            `<input name=code placeholder="Verification code sent to your card number ending 1234">`,
            `<input name=code aria-label="Enter the security code sent to the phone linked to card number ending 1234">`,
            `<input name=cardNumber><input name=otp placeholder="One-time passcode">`,
        ]) {
            await page.setContent(otp);
            expect(await detectAuthWall(page), otp).toBe("otp"); // mentions a card, still an OTP
        }
        for (const cvv of [`<input name=cardCode placeholder="Code">`, `<input autocomplete=cc-csc placeholder="OTP">`]) {
            await page.setContent(cvv);
            expect(await detectAuthWall(page), cvv).toBeNull();
        }
        await page.setContent(`${"<input maxlength=1>".repeat(6)}`);
        expect(await detectAuthWall(page)).toBe("otp");
        await page.setContent(`<input type=email placeholder="Newsletter"><input type=password style="display:none">`);
        expect(await detectAuthWall(page)).toBeNull();
        await browser.close();
    }, 30_000);
});

describe("toPlaywrightCookies", () => {
    it("maps chrome.cookies fields and fixes insecure SameSite=None", () => {
        const [a, b] = toPlaywrightCookies([
            { name: "s", value: "1", domain: ".google.com", path: "/", expirationDate: 99, httpOnly: true, secure: true, sameSite: "no_restriction" },
            { name: "t", value: "2", domain: "x.com", path: "", httpOnly: false, secure: false, sameSite: "no_restriction" },
        ]);
        expect(a).toEqual({ name: "s", value: "1", domain: ".google.com", path: "/", expires: 99, httpOnly: true, secure: true, sameSite: "None" });
        expect(b.sameSite).toBe("Lax");
        expect(b.expires).toBe(-1);
        expect(b.path).toBe("/");
    });
});
