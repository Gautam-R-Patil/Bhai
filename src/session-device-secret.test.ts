// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The bot proves its device with the secret the desktop app got at sign-in, and stops
// retrying when the server says this device has to sign in again.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config/keys.js", () => ({ getConvexSiteUrl: () => "https://convex.test" }));

const { initSession, sessionNeedsSignIn } = await import("./session.js");

afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ATLAS_OTPLESS_USER_ID;
    delete process.env.ATLAS_DEVICE_SECRET;
});

describe("bot session and the device secret", () => {
    it("sends the secret, and a sign_in_required refusal means sign in again, not retry", async () => {
        process.env.ATLAS_OTPLESS_USER_ID = "u1";
        process.env.ATLAS_DEVICE_SECRET = "s3cret";
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "sign_in_required" }), { status: 401 }));
        vi.stubGlobal("fetch", fetchMock);

        expect(await initSession()).toBe(false);
        expect(sessionNeedsSignIn()).toBe(true);
        const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
        expect(body).toMatchObject({ otplessUserId: "u1", deviceSecret: "s3cret" });
    });

    it("a server error is not a sign-in problem", async () => {
        process.env.ATLAS_OTPLESS_USER_ID = "u1";
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Session creation failed" }), { status: 403 })));
        expect(await initSession()).toBe(false);
        expect(sessionNeedsSignIn()).toBe(false);
    });
});
