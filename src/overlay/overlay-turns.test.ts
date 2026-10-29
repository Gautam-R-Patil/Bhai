// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The owner's overlay turns share one history: one at a time, and a reply survives the
// chat bar reconnecting mid-turn.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-overlay-turns-"));
process.env.ATLAS_OVERLAY_PORT = String(20000 + Math.floor(Math.random() * 20000));

let finish: ((text: string) => void) | undefined;
vi.mock("../agent.js", async (orig) => ({
    ...(await orig<typeof import("../agent.js")>()),
    runAgent: vi.fn(() => new Promise((resolve) => (finish = (text) => resolve({ text, toolCalls: 0 })))),
}));

const chat = await import("./overlay-chat.js");
chat.initOverlayChat({} as never);
const url = `ws://127.0.0.1:${process.env.ATLAS_OVERLAY_PORT}/?localToken=${chat.getOverlayLocalToken()}`;

type Msg = { type: string; text?: string; busy?: boolean };
function open(): Promise<{ ws: WebSocket; next: (type: string) => Promise<Msg> }> {
    const ws = new WebSocket(url);
    const seen: Msg[] = [];
    const waiters: Array<() => void> = [];
    ws.on("message", (d) => {
        seen.push(JSON.parse(String(d)));
        for (const w of waiters.splice(0)) w();
    });
    const next = async (type: string): Promise<Msg> => {
        for (;;) {
            const i = seen.findIndex((m) => m.type === type);
            if (i >= 0) return seen.splice(i, 1)[0];
            await new Promise<void>((r) => waiters.push(r));
        }
    };
    return new Promise((resolve, reject) => {
        ws.once("open", () => resolve({ ws, next }));
        ws.once("error", reject);
    });
}

it("refuses a second owner turn, and delivers the reply to the chat bar after it reconnects", async () => {
    const a = await open();
    expect((await a.next("ready")).busy).toBe(false);
    a.ws.send(JSON.stringify({ type: "chat", text: "summarise my inbox", chat: "bar-1" }));
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));

    const b = await open(); // e.g. the extension, or a second window
    expect((await b.next("ready")).busy).toBe(true);
    b.ws.send(JSON.stringify({ type: "chat", text: "and the weather?", chat: "other" }));
    expect((await b.next("error")).text).toMatch(/still on your last message/);

    a.ws.close(); // the chat bar's socket drops mid-turn…
    await new Promise((r) => setTimeout(r, 50));
    const c = await open(); // …and comes back
    expect((await c.next("ready")).busy).toBe(true);
    c.ws.send(JSON.stringify({ type: "hello", chat: "bar-1" }));
    await new Promise((r) => setTimeout(r, 50));
    finish?.("3 unread, nothing urgent");
    expect((await c.next("response")).text).toContain("3 unread");

    const d = await open();
    expect((await d.next("ready")).busy).toBe(false); // nothing running any more
    for (const s of [b, c, d]) s.ws.close();
});
