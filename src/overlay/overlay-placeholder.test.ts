// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The app-aware placeholder goes to a chat bar when it changes, not every 15 s.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";

process.env.BHAI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-overlay-placeholder-"));
process.env.BHAI_OVERLAY_PORT = String(20000 + Math.floor(Math.random() * 20000));

const { front } = vi.hoisted(() => ({ front: { app: "TextEdit" } }));
vi.mock("../proactive/activity.js", () => ({
    getUserPresence: async () => ({ frontmostApp: front.app }),
}));

it("sends the placeholder once, and again only when it changes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    const chat = await import("./overlay-chat.js");
    chat.initOverlayChat({} as never);
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.BHAI_OVERLAY_PORT}/?localToken=${chat.getOverlayLocalToken()}`);
    const got: string[] = [];
    ws.on("message", (d) => {
        const m = JSON.parse(String(d));
        if (m.type === "placeholder") got.push(m.text);
    });
    await new Promise((r) => ws.once("open", r));
    await vi.waitFor(() => expect(got).toEqual(["Help me write this…"]), { timeout: 5000 });
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(15_000); // 90 s of ticks, re-probing presence
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual(["Help me write this…"]);
    front.app = "Finder";
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(got).toEqual(["Help me write this…", "Tell Bhai what needs sorting…"]));
    ws.close();
    chat.closeOverlayChat();
    vi.useRealTimers();
});
