// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// One Calendar read serves the monitors and the environment snapshot; the snapshot makes no
// network request of its own.
import { expect, it, vi } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:child_process", () => ({
    execFile: (cmd: string, args: string[], _o: unknown, cb: (e: Error | null, r?: { stdout: string }) => void) => {
        calls.push(cmd);
        const soon = new Date(Date.now() + 10 * 60_000).toISOString();
        const out: Record<string, string> = {
            osascript: args.join(" ").includes("Calendar")
                ? JSON.stringify([{ title: "Standup", startTime: soon, endTime: soon, location: "", notes: "" }])
                : "",
            pmset: "",
            df: "Filesystem 1G-blocks Used Available Capacity\n/dev/disk3s1 460 200 250 45% /\n",
            pbpaste: "",
            ps: "%CPU\n1.0\n",
            vm_stat: "",
            find: "",
        };
        setTimeout(() => cb(null, { stdout: out[cmd] ?? "" }), 5);
    },
}));
vi.mock("../tools/platform.js", () => ({ IS_MAC: true, IS_WIN: false }));
vi.mock("../location/index.js", () => ({ getLocation: () => null }));
vi.mock("../network-health.js", () => ({ isOnline: () => true }));

it("monitors and the environment snapshot share one Calendar read, with no HEAD request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { runAllMonitors } = await import("./monitors.js");
    const { getEnvironmentSnapshot } = await import("./environment-sensors.js");
    const [results, snap] = await Promise.all([runAllMonitors("Finder"), getEnvironmentSnapshot()]);
    expect(results.upcomingEventCount).toBe(1);
    expect(snap.upcomingCalendar).toHaveLength(1);
    expect(snap.upcomingCalendar[0]).toMatch(/^Standup at /);
    expect(snap.networkStatus).toBe(true);
    expect(calls.filter((c) => c === "osascript")).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
});
