// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// The owner's devices (Account → Devices). A device is the "platform:host:user"
// fingerprint the bot and the desktop app send when they get a session. Removing a
// device signs it out and stops it getting new sessions until someone signs in on it
// again (/api/otpless/validate-token, which OTPless verifies, reactivates it).

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";

const PLATFORM: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** "darwin:Dheerajs-MacBook-Pro.local:dheeraj" → { name: "Dheerajs-MacBook-Pro", platform: "macOS" } */
export function deviceLabel(fingerprint: string): { name: string; platform: string } {
    const [os = "", host = "", ...rest] = fingerprint.split(":");
    const name = host.replace(/\.local$/i, "") || rest.join(":") || "Unknown device";
    return { name: name.slice(0, 80), platform: PLATFORM[os] ?? (os || "Unknown") };
}

/** Record a sign-in from `fingerprint`; false when the device was removed (and this isn't a fresh, verified sign-in). */
export async function noteDevice(
    ctx: MutationCtx,
    otplessUserId: string,
    fingerprint: string,
    reactivate: boolean,
): Promise<boolean> {
    const fp = fingerprint.slice(0, 300);
    const now = Date.now();
    const existing = await ctx.db
        .query("devices")
        .withIndex("by_user_and_fingerprint", (q) => q.eq("otplessUserId", otplessUserId).eq("fingerprint", fp))
        .unique();
    if (!existing) {
        await ctx.db.insert("devices", { otplessUserId, fingerprint: fp, firstSeen: now, lastSeen: now });
        return true;
    }
    if (existing.removedAt && !reactivate) return false;
    await ctx.db.patch(existing._id, { lastSeen: now, removedAt: undefined });
    return true;
}

export const listDevices = internalQuery({
    args: { otplessUserId: v.string(), currentFingerprint: v.union(v.string(), v.null()) },
    handler: async (ctx, { otplessUserId, currentFingerprint }) => {
        const rows = await ctx.db
            .query("devices")
            .withIndex("by_user", (q) => q.eq("otplessUserId", otplessUserId))
            .take(100);
        return rows
            .filter((d) => !d.removedAt)
            .sort((a, b) => b.lastSeen - a.lastSeen)
            .map((d) => ({
                id: d._id,
                ...deviceLabel(d.fingerprint),
                firstSeen: d.firstSeen,
                lastSeen: d.lastSeen,
                current: d.fingerprint === currentFingerprint,
            }));
    },
});

export const removeDevice = internalMutation({
    args: { otplessUserId: v.string(), deviceId: v.string(), currentFingerprint: v.union(v.string(), v.null()) },
    handler: async (ctx, { otplessUserId, deviceId, currentFingerprint }) => {
        const id = ctx.db.normalizeId("devices", deviceId);
        const device = id ? await ctx.db.get(id) : null;
        if (!device || device.otplessUserId !== otplessUserId) return { ok: false, error: "Device not found" };
        if (device.fingerprint === currentFingerprint)
            return { ok: false, error: "This is the device you're using — sign out instead." };
        await ctx.db.patch(device._id as Id<"devices">, { removedAt: Date.now() });
        // Sign it out now: its sessions go (it can't get new ones until it signs in again).
        const sessions = await ctx.db
            .query("sessions")
            .withIndex("by_user", (q) => q.eq("otplessUserId", otplessUserId))
            .take(1000);
        for (const s of sessions) if (s.deviceFingerprint === device.fingerprint) await ctx.db.delete(s._id);
        return { ok: true };
    },
});
