// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every OS call is recorded, never run. Each records into the same log as the
// cursor lines so the tests can check ordering.
const log: string[] = vi.hoisted(() => []);
vi.mock("node:child_process", async (orig) => {
    const real = await orig<typeof import("node:child_process")>();
    const execFile = (cmd: string, args: string[], ...rest: unknown[]) => {
        log.push(`exec:${cmd}`);
        const cb = rest.find((r) => typeof r === "function") as (
            e: null,
            o: { stdout: string; stderr: string },
        ) => void;
        cb?.(null, { stdout: "", stderr: "" });
    };
    return { ...real, execFile };
});
vi.mock("../screen-dimensions.js", async (orig) => ({
    ...(await orig<object>()),
    getScreenDimensions: async () => ({ width: 1440, height: 900, scale: 2, monitorId: "m1", originX: 0, originY: 0 }),
}));

const cursor = await import("../agent-cursor.js");
const { osComputerAction } = await import("../../tools/os-computer-action.js");
const { captureScreenshot } = await import("../../tools/platform.js");

const lines = () => log.filter((l) => l.startsWith("##")).map((l) => JSON.parse(l.slice(15)));
const ackLast = () => {
    const last = lines().at(-1);
    cursor._handleCursorInput(`##BHAI_CURSOR_ACK##${last.id}\n`);
};

beforeEach(() => {
    log.length = 0;
    cursor._resetAgentCursorForTest((l) => log.push(l.trimEnd()));
    process.env.ATLAS_AGENT_CURSOR_IPC = "1";
    delete process.env.ATLAS_NO_AGENT_CURSOR;
});
afterEach(() => {
    vi.useRealTimers();
    delete process.env.ATLAS_AGENT_CURSOR_IPC;
});

describe("agent cursor events", () => {
    it("is a no-op without the desktop app or with the kill switch", async () => {
        delete process.env.ATLAS_AGENT_CURSOR_IPC;
        await cursor.cursorClick(10, 10);
        process.env.ATLAS_AGENT_CURSOR_IPC = "1";
        process.env.ATLAS_NO_AGENT_CURSOR = "true";
        await cursor.cursorMove(10, 10);
        expect(await cursor.withCursorHidden(async () => "shot")).toBe("shot");
        expect(log).toEqual([]);
    });

    it("warms the app's windows when a model call is offered screen-driving tools", () => {
        const tool = (name: string) => ({ type: "function" as const, function: { name, parameters: {} } });
        cursor.warmCursorForTools([tool("web_search"), tool("read_file")]);
        cursor.warmCursorForTools(undefined);
        expect(lines()).toEqual([]);
        cursor.warmCursorForTools([tool("web_search"), tool("os_smart_click")]);
        expect(lines()).toEqual([{ t: "warm" }]);
        delete process.env.ATLAS_AGENT_CURSOR_IPC;
        cursor.warmCursorForTools([tool("os_click")]);
        expect(lines()).toHaveLength(1);
    });

    it("still warms mid-session: the app may have freed the windows of a long, quiet turn", async () => {
        const tool = (name: string) => ({ type: "function" as const, function: { name, parameters: {} } });
        const p = cursor.cursorClick(1, 1);
        ackLast();
        await p;
        log.length = 0;
        cursor.warmCursorForTools([tool("os_click")]);
        expect(lines()).toEqual([{ t: "warm" }]);
    });

    it("holds the windows warm for a live voice session until released", () => {
        vi.useFakeTimers();
        const release = cursor.holdCursorWarm();
        expect(lines()).toEqual([{ t: "warm" }]);
        vi.advanceTimersByTime(10 * 60_000);
        expect(lines()).toHaveLength(3);
        release();
        vi.advanceTimersByTime(30 * 60_000);
        expect(lines()).toHaveLength(3);
    });

    it("starts a session, then glides; resolves on ack", async () => {
        const p = cursor.cursorClick(100.4, 200.6, "right", 2);
        ackLast();
        await p;
        expect(lines()).toEqual([
            { t: "session", on: true },
            { t: "click", x: 100, y: 201, button: "right", count: 2, id: 1 },
        ]);
    });

    it("never waits more than ~300ms for a glide ack", async () => {
        vi.useFakeTimers();
        let done = false;
        const p = cursor.cursorMove(5, 5).then(() => (done = true));
        await vi.advanceTimersByTimeAsync(299);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await p;
        expect(done).toBe(true);
    });

    it("hides before a capture, waits for the ack, shows after", async () => {
        const move = cursor.cursorMove(1, 1);
        ackLast();
        await move;
        log.length = 0;
        let captured = false;
        const p = cursor.withCursorHidden(async () => {
            log.push("capture");
            captured = true;
        });
        await Promise.resolve();
        expect(captured).toBe(false); // still waiting for the hide ack
        ackLast();
        await p;
        expect(log.map((l) => (l.startsWith("##") ? JSON.parse(l.slice(15)).t : l))).toEqual([
            "hide",
            "capture",
            "show",
        ]);
    });

    it("captures anyway after 150ms when no ack comes", async () => {
        vi.useFakeTimers();
        const move = cursor.cursorMove(1, 1);
        await vi.advanceTimersByTimeAsync(300);
        await move;
        const p = cursor.withCursorHidden(async () => "shot");
        await vi.advanceTimersByTimeAsync(150);
        expect(await p).toBe("shot");
        expect(lines().at(-1)).toEqual({ t: "show" });
    });

    it("skips the hide round-trip when no session is showing", async () => {
        await cursor.withCursorHidden(async () => log.push("capture"));
        expect(log).toEqual(["capture"]);
    });

    it("shows the typing pulse around typing", async () => {
        await cursor.withCursorTyping(async () => log.push("typing"));
        expect(log.slice(1).map((l) => (l.startsWith("##") ? JSON.stringify(JSON.parse(l.slice(15))) : l))).toEqual([
            '{"t":"type","on":true}',
            "typing",
            '{"t":"type","on":false}',
        ]);
    });

    it("ends the session when the outermost turn ends", async () => {
        await cursor.trackCursorTurn(async () => {
            await cursor.trackCursorTurn(async () => {
                cursor.cursorMove(1, 1);
            });
            expect(lines().some((e) => e.t === "session" && e.on === false)).toBe(false);
        });
        expect(lines().at(-1)).toEqual({ t: "session", on: false });
    });

    it("a background turn that never touched the screen doesn't hold the glow on", async () => {
        let release = () => {};
        const background = cursor.trackCursorTurn(() => new Promise<void>((r) => (release = r)));
        await cursor.trackCursorTurn(async () => {
            cursor.cursorMove(1, 1);
        });
        expect(lines().at(-1)).toEqual({ t: "session", on: false });
        release();
        await background;
    });

    it("still hides for a capture while the glow fades out", async () => {
        await cursor.trackCursorTurn(async () => {
            cursor.cursorMove(1, 1);
        });
        const p = cursor.withCursorHidden(async () => log.push("capture"));
        expect(lines().at(-1)).toMatchObject({ t: "hide" });
        cursor._handleCursorInput(`##BHAI_CURSOR_ACK##${lines().at(-1)?.id}\n`);
        await p;
        expect(lines().at(-1)).toEqual({ t: "show" });
    });
});

describe("tools emit cursor events before acting", () => {
    it("os_computer_action click glides before the OS click", async () => {
        vi.useFakeTimers();
        const p = osComputerAction.handler({ action: "click", coord: [700, 400], coordSystem: "screen" });
        await vi.advanceTimersByTimeAsync(300);
        expect(JSON.parse(await p).success).toBe(true);
        const firstExec = log.findIndex((l) => l.startsWith("exec:"));
        const click = log.findIndex((l) => l.includes('"t":"click"'));
        expect(click).toBeGreaterThan(-1);
        expect(click).toBeLessThan(firstExec);
        expect(JSON.parse(log[click].slice(15))).toMatchObject({ x: 700, y: 400, button: "left", count: 1 });
    });

    it("os_computer_action drag and scroll emit their paths", async () => {
        vi.useFakeTimers();
        const drag = osComputerAction.handler({
            action: "drag",
            path: [
                [10, 10],
                [50, 60],
            ],
            coordSystem: "screen",
        });
        await vi.advanceTimersByTimeAsync(300);
        await drag;
        const scroll = osComputerAction.handler({
            action: "scroll",
            coord: [20, 30],
            scrollDy: 120,
            coordSystem: "screen",
        });
        await vi.advanceTimersByTimeAsync(300);
        await scroll;
        const evts = lines();
        expect(evts.find((e) => e.t === "drag")).toMatchObject({
            points: [
                { x: 10, y: 10 },
                { x: 50, y: 60 },
            ],
        });
        expect(evts.find((e) => e.t === "scroll")).toMatchObject({ x: 20, y: 30, dy: 120 });
    });

    it("the shared screenshot path hides the cursor first", async () => {
        if (process.platform === "win32") return; // Windows capture goes through screenshot-desktop, not execFile
        vi.useFakeTimers();
        const move = cursor.cursorMove(1, 1);
        await vi.advanceTimersByTimeAsync(300);
        await move;
        log.length = 0;
        const shot = captureScreenshot("/tmp/never-written.png");
        await vi.advanceTimersByTimeAsync(150);
        await shot;
        const order = log.map((l) => (l.startsWith("##") ? JSON.parse(l.slice(15)).t : l));
        expect(order[0]).toBe("hide");
        expect(order[1]).toMatch(/^exec:/);
        expect(order.at(-1)).toBe("show");
    });
});
