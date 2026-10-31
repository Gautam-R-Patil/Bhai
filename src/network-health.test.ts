// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The passive connectivity check waits 45 s from the last successful call, never longer.
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./config/keys.js", () => ({ getConvexSiteUrl: () => "https://convex.test" }));

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it("skips the HEAD while calls succeed, and checks 45 s after the last one", async () => {
    vi.useFakeTimers();
    let up = true;
    const fetch = vi.fn(async () => {
        if (!up) throw new Error("offline");
        return { ok: true, status: 200 };
    });
    vi.stubGlobal("fetch", fetch);
    const net = await import("./network-health.js");
    net.startNetworkMonitor();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1); // initial check

    // A successful call every 30 s: no passive HEAD at all.
    for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
        net.reportNetworkSuccess();
    }
    expect(fetch).toHaveBeenCalledTimes(1);

    // The network drops right after the last success: noticed within 45 s of it.
    up = false;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    expect(net.getNetworkStatus()).toBe("degraded");
    net.stopNetworkMonitor();
});
