// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The chat bar's task drawer shows running researches and long tasks, and Cancel stops them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-task-drawer-"));
process.env.ATLAS_OVERLAY_PORT = String(20000 + Math.floor(Math.random() * 20000));

const state = vi.hoisted(() => ({ research: true, cancelled: [] as string[] }));
vi.mock("../research/index.js", async (orig) => ({
    ...(await orig<typeof import("../research/index.js")>()),
    listRunningResearch: () =>
        state.research ? [{ id: "r1", topic: "EV battery prices in India", progress: 40, phase: "12 sources · 30 findings" }] : [],
    cancelResearchById: async (id: string) => {
        if (id !== "r1" || !state.research) return false;
        state.cancelled.push(id);
        state.research = false;
        return true;
    },
}));
vi.mock("../agents/long-task.js", async (orig) => ({
    ...(await orig<typeof import("../agents/long-task.js")>()),
    listActiveLongTasks: () => [
        { id: "t1", description: "Migrate the blog", status: "running", currentPhase: 1, phases: [{ description: "export" }, { description: "import posts" }] },
    ],
    cancelLongTask: () => false,
}));

const chat = await import("./overlay-chat.js");
chat.initOverlayChat({} as never);

it("lists running tasks, cancels one, and says when it ended", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.ATLAS_OVERLAY_PORT}/?localToken=${chat.getOverlayLocalToken()}`);
    const seen: Array<{ type: string; taskId?: string; name?: string; progress?: number; phase?: string }> = [];
    ws.on("message", (d) => seen.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once("open", r));

    await vi.waitFor(() => expect(seen.filter((m) => m.type === "task_progress")).toHaveLength(2), { timeout: 6000 });
    expect(seen).toContainEqual(expect.objectContaining({ type: "task_progress", taskId: "r1", progress: 40 }));
    expect(seen).toContainEqual(expect.objectContaining({ type: "task_progress", taskId: "t1", progress: 50, phase: "import posts" }));

    ws.send(JSON.stringify({ type: "cancel_task", taskId: "r1" }));
    await vi.waitFor(() => expect(seen).toContainEqual({ type: "task_cancelled", taskId: "r1" }));
    expect(state.cancelled).toEqual(["r1"]);
    await vi.waitFor(() => expect(seen).toContainEqual({ type: "task_complete", taskId: "r1" }), { timeout: 6000 });
    ws.close();
}, 20_000);
