// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { deviceLabel, newDeviceSecret, noteDevice, sha256Hex } from "./devices";

describe("device names from session fingerprints", () => {
    it("shows the computer's name and OS", () => {
        expect(deviceLabel("darwin:Dheerajs-MacBook-Pro.local:dheeraj")).toEqual({ name: "Dheerajs-MacBook-Pro", platform: "macOS" });
        expect(deviceLabel("win32:DESKTOP-7Q2:priya")).toEqual({ name: "DESKTOP-7Q2", platform: "Windows" });
        expect(deviceLabel("linux:devbox:root")).toEqual({ name: "devbox", platform: "Linux" });
        expect(deviceLabel("")).toEqual({ name: "Unknown device", platform: "Unknown" });
    });
});

// The one devices row noteDevice looks up, behind just enough of ctx.db.
function fakeCtx() {
    let row: Record<string, unknown> | null = null;
    const db = {
        query: () => ({ withIndex: () => ({ unique: async () => row }) }),
        insert: async (_t: string, doc: Record<string, unknown>) => {
            row = { _id: "d1", ...doc };
        },
        patch: async (_id: string, fields: Record<string, unknown>) => {
            row = { ...row, ...fields };
        },
    };
    return { ctx: { db } as never, db, row: () => row };
}

describe("a session needs the device's sign-in secret", () => {
    const fp = "darwin:mac:me";

    it("a user id alone gets no session, on a new or a pre-secret device", async () => {
        const { ctx } = fakeCtx();
        expect(await noteDevice(ctx, "u1", fp, false, undefined)).toBe("sign_in_required");
        expect(await noteDevice(ctx, "u1", fp, false, await sha256Hex("guess"))).toBe("sign_in_required");
        // Signed in before secrets existed: the row is there, without a secret.
        const old = fakeCtx();
        await noteDevice(old.ctx, "u1", fp, true, undefined);
        expect(await noteDevice(old.ctx, "u1", fp, false, await sha256Hex("anything"))).toBe("sign_in_required");
    });

    it("the secret from the verified sign-in works; a wrong or old one doesn't", async () => {
        const { ctx, row } = fakeCtx();
        const first = newDeviceSecret();
        expect(first).toMatch(/^[0-9a-f]{64}$/);
        await noteDevice(ctx, "u1", fp, true, await sha256Hex(first));
        expect(row()?.secretHash).not.toBe(first); // only the hash is stored
        expect(await noteDevice(ctx, "u1", fp, false, await sha256Hex(first))).toBe("ok");
        expect(await noteDevice(ctx, "u1", fp, false, await sha256Hex("wrong"))).toBe("sign_in_required");

        const second = newDeviceSecret();
        await noteDevice(ctx, "u1", fp, true, await sha256Hex(second)); // signing in again replaces it
        expect(await noteDevice(ctx, "u1", fp, false, await sha256Hex(first))).toBe("sign_in_required");
        expect(await noteDevice(ctx, "u1", fp, false, await sha256Hex(second))).toBe("ok");
    });

    it("a removed device stays out even with its secret, until it signs in again", async () => {
        const { ctx, db } = fakeCtx();
        const secret = newDeviceSecret();
        await noteDevice(ctx, "u1", fp, true, await sha256Hex(secret));
        await db.patch("d1", { removedAt: 1 });
        expect(await noteDevice(ctx, "u1", fp, false, await sha256Hex(secret))).toBe("device_removed");
        await noteDevice(ctx, "u1", fp, true, await sha256Hex(secret));
        expect(await noteDevice(ctx, "u1", fp, false, await sha256Hex(secret))).toBe("ok");
    });
});
