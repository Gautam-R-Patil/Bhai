// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Presence probe: lsappinfo + a narrow ioreg, and a failed probe is never an app switch.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Out = { stdout: string } | Error;
const { calls, replies } = vi.hoisted(() => ({
    calls: [] as { cmd: string; args: string[] }[],
    replies: {} as Record<string, () => Out>,
}));
vi.mock("node:child_process", () => ({
    execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string }) => void) => {
        calls.push({ cmd, args });
        const r = replies[cmd]?.() ?? new Error(`no reply for ${cmd}`);
        if (r instanceof Error) cb(r);
        else cb(null, r);
    },
}));
vi.mock("../tools/platform.js", () => ({ IS_MAC: true, IS_WIN: false }));

const list = (front: string) => `
 1) "loginwindow" ASN:0x0-0x2002: ${front === "loginwindow" ? "(in front) " : ""}
    pid = 414 type="UIElement" flavor=3
 2) "Google Chrome" ASN:0x0-0x5c05c: ${front === "Google Chrome" ? "(in front) " : ""}
    pid = 900 type="Foreground" flavor=3
 3) "Google Chrome Helper (Aperitif)" ASN:0x0-0x5c060:
    pid = 901 type="UIElement" flavor=3
 4) "‎WhatsApp" ASN:0x0-0x211211: ${front === "WhatsApp" ? "(in front) " : ""}
    pid = 902 type="Foreground" flavor=3
 5) "SecurityAgent" ASN:0x0-0x79079: ${front === "SecurityAgent" ? "(in front) " : ""}
    pid = 63345 type="UIElement" flavor=3
 6) "chronod" ASN:0x0-0xf00f:
    pid = 722 !signalled type="BackgroundOnly" flavor=2
`;

async function load() {
    vi.resetModules();
    const activity = await import("./activity.js");
    const { globalBoundaryBus } = await import("./boundary-events.js");
    const events: { kind: string; meta?: Record<string, unknown> }[] = [];
    globalBoundaryBus.subscribe((e) => events.push(e));
    return { ...activity, events };
}

describe("presence probe", () => {
    beforeEach(() => {
        calls.length = 0;
        replies.ioreg = () => ({ stdout: '      "HIDIdleTime" = 4000000000\n' });
        replies.lsappinfo = () => ({ stdout: list("Google Chrome") });
    });

    it("parses lsappinfo list: Foreground apps in order, bidi marks dropped, the front app", async () => {
        const { parseLsappinfoList } = await load();
        expect(parseLsappinfoList(list("WhatsApp"))).toEqual({ apps: ["Google Chrome", "WhatsApp"], frontmost: "WhatsApp" });
        // A UIElement process lsappinfo marks in front isn't the user-facing front app.
        expect(parseLsappinfoList(list("loginwindow")).frontmost).toBe("");
        expect(parseLsappinfoList(list("SecurityAgent"))).toEqual({ apps: ["Google Chrome", "WhatsApp"], frontmost: "" });
        expect(parseLsappinfoList("garbage").frontmost).toBe("");
    });

    it("uses lsappinfo and a narrow ioreg, never osascript", async () => {
        const { getUserPresence } = await load();
        const p = await getUserPresence();
        expect(p.frontmostApp).toBe("Google Chrome");
        expect(p.activeApps).toEqual(["Google Chrome", "WhatsApp"]);
        expect(p.idleMinutes).toBe(0);
        expect(calls.some((c) => c.cmd === "osascript")).toBe(false);
        expect(calls.find((c) => c.cmd === "ioreg")?.args).toEqual(["-r", "-c", "IOHIDSystem", "-d", "1", "-k", "HIDIdleTime"]);
    });

    it("a failed probe keeps the last front app and fires no app_switch", async () => {
        const { getUserPresence, _resetPresenceCacheForTests, events } = await load();
        await getUserPresence();
        replies.lsappinfo = () => new Error("boom");
        _resetPresenceCacheForTests?.();
        const p = await getUserPresence();
        expect(p.frontmostApp).toBe("Google Chrome");
        expect(p.activeApps).toEqual(["Google Chrome", "WhatsApp"]);
        expect(events.filter((e) => e.kind === "app_switch")).toEqual([]);
        // A real switch still fires.
        replies.lsappinfo = () => ({ stdout: list("WhatsApp") });
        _resetPresenceCacheForTests?.();
        await getUserPresence();
        expect(events.filter((e) => e.kind === "app_switch").map((e) => e.meta)).toEqual([
            { from: "Google Chrome", to: "WhatsApp" },
        ]);
    });

    it("an auth prompt (SecurityAgent) in front keeps the last front app and fires no app_switch", async () => {
        const { getUserPresence, _resetPresenceCacheForTests, describePresence, events } = await load();
        await getUserPresence();
        replies.lsappinfo = () => ({ stdout: list("SecurityAgent") });
        _resetPresenceCacheForTests();
        const p = await getUserPresence();
        expect(p.frontmostApp).toBe("Google Chrome");
        expect(describePresence(p)).not.toContain("SecurityAgent");
        expect(events.filter((e) => e.kind === "app_switch")).toEqual([]);
    });

    it("callers share one probe for 25 s, then probe again", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            const { getUserPresence } = await load();
            const [a, b] = await Promise.all([getUserPresence(), getUserPresence()]);
            await getUserPresence();
            expect(a).toBe(b);
            expect(calls.filter((c) => c.cmd === "lsappinfo")).toHaveLength(1);
            vi.advanceTimersByTime(24_000);
            await getUserPresence();
            expect(calls.filter((c) => c.cmd === "lsappinfo")).toHaveLength(1);
            vi.advanceTimersByTime(2_000);
            await getUserPresence();
            expect(calls.filter((c) => c.cmd === "lsappinfo")).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });
});
