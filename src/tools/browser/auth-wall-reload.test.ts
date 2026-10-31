// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The Chrome-session import must never re-POST a form (second OTP SMS) and asks
// the extension for the page URL's cookies (Chrome's PSL scoping), not a domain.
import { describe, expect, it, vi } from "vitest";

const getExtensionCookies = vi.fn(async (_url: string) => [
    { name: "sid", value: "1", domain: "t.test", path: "/", httpOnly: true, secure: false },
]);
vi.mock("./core.js", () => ({ waitForPageReady: vi.fn() }));
vi.mock("./chrome-bridge.js", () => ({ getExtensionCookies, isExtensionConnected: () => true }));
vi.mock("./browser-backend.js", () => ({ getCurrentMode: () => "playwright" }));

const { checkAuthWall } = await import("./auth-wall.js");

describe("checkAuthWall cookie import", () => {
    it("reloads a GET wall with the URL's cookies, never a POSTed OTP page", async (ctx) => {
        // biome-ignore lint/suspicious/noExplicitAny: optional playwright
        let browser: any = null;
        try {
            browser = await (await import("playwright-core")).chromium.launch({ headless: true });
        } catch {
            return ctx.skip();
        }
        const page = await browser.newPage();
        let posts = 0;
        let gets = 0;
        await page.route("http://t.test/**", (r: { request: () => { method: () => string }; fulfill: (o: object) => void }) => {
            const post = r.request().method() === "POST";
            if (post) posts++;
            else gets++;
            const body = r.request().method() === "POST"
                ? `<input autocomplete=one-time-code>`
                : `<form method=post action=/verify><input name=phone><button>Continue</button></form><input autocomplete=one-time-code>`;
            r.fulfill({ contentType: "text/html", body });
        });

        await page.goto("http://t.test/start");
        expect((await checkAuthWall(page)).auth_required).toBe("otp");
        expect(getExtensionCookies).toHaveBeenCalledWith("http://t.test/start");
        expect(gets).toBe(2); // imported + reloaded

        await page.click("button");
        await page.waitForURL("http://t.test/verify");
        getExtensionCookies.mockClear();
        expect((await checkAuthWall(page)).auth_required).toBe("otp");
        expect(posts).toBe(1); // not re-POSTed
        expect(getExtensionCookies).not.toHaveBeenCalled();
        await browser.close();
    }, 30_000);
});
