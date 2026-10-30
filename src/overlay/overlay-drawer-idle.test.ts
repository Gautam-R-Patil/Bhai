// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The chat bar's task drawer polls every 4 s only while a research or long task runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-overlay-drawer-"));
process.env.ATLAS_OVERLAY_PORT = String(20000 + Math.floor(Math.random() * 20000));

const { state } = vi.hoisted(() => ({
    state: {
        running: [] as Array<{ id: string; topic: string; progress: number; phase: string }>,
        listCalls: 0,
        hook: null as null | (() => void),
    },
}));
vi.mock("../research/index.js", async (orig) => ({
    ...(await orig<typeof import("../research/index.js")>()),
    listRunningResearch: () => {
        state.listCalls++;
        return state.running;
    },
    setResearchStartHook: (fn: () => void) => {
        state.hook = fn;
    },
}));
vi.mock("../proactive/activity.js", () => ({ getUserPresence: async () => ({ frontmostApp: "Finder" }) }));

it("polls only while a task runs, and still sends its progress and its end", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const chat = await import("./overlay-chat.js");
    chat.initOverlayChat({} as never);
    await vi.waitFor(() => expect(state.hook).not.toBeNull());
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.ATLAS_OVERLAY_PORT}/?localToken=${chat.getOverlayLocalToken()}`);
    const got: Array<{ type: string; taskId?: string }> = [];
    ws.on("message", (d) => got.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once("open", r));
    await vi.waitFor(() => expect(got.some((m) => m.type === "ready")).toBe(true));

    // Nothing running: one look after the connect, then the poll stops.
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(4000);
    expect(state.listCalls).toBe(1);

    // A research starts: progress every 4 s, then its end, then quiet again.
    state.running = [{ id: "r1", topic: "solar panels", progress: 10, phase: "2 sources" }];
    state.hook?.();
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(got.filter((m) => m.type === "task_progress")).toHaveLength(1));
    state.running = [];
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(got.some((m) => m.type === "task_complete" && m.taskId === "r1")).toBe(true));
    const calls = state.listCalls;
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(4000);
    expect(state.listCalls).toBe(calls);

    ws.close();
    chat.closeOverlayChat();
    vi.useRealTimers();
});
