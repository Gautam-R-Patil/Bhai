// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The mic and live voice are the owner's: a web-widget guest can't start, stop or hear them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";

process.env.BHAI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-overlay-voice-"));
process.env.BHAI_OVERLAY_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.WIDGET_TOKEN = "w".repeat(40);

vi.mock("../voice/live/integration.js", () => ({
    getActiveLiveSession: () => ({ isActive: true }),
    isLiveVoiceAvailable: () => true,
    startLiveVoice: vi.fn(),
}));

const chat = await import("./overlay-chat.js");
chat.initOverlayChat({} as never);
const base = `ws://127.0.0.1:${process.env.BHAI_OVERLAY_PORT}/`;

async function open(query: string) {
    const ws = new WebSocket(`${base}?${query}`);
    const got: Array<{ type: string }> = [];
    ws.on("message", (d) => got.push(JSON.parse(String(d))));
    await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
    });
    await vi.waitFor(() => expect(got.some((m) => m.type === "ready")).toBe(true));
    const voice = () => got.filter((m) => m.type.startsWith("voice_"));
    return { ws, voice, send: (m: object) => ws.send(JSON.stringify(m)) };
}

it("a widget guest's voice messages do nothing; the owner's still work", async () => {
    const guest = await open(`source=web-widget&token=${process.env.WIDGET_TOKEN}`);
    const owner = await open(`localToken=${chat.getOverlayLocalToken()}`);

    for (const type of ["voice_live_start", "voice_stop"]) guest.send({ type });
    owner.send({ type: "voice_live_start" });
    await vi.waitFor(() => expect(owner.voice()).toEqual([expect.objectContaining({ type: "voice_live_status", status: "already_active" })]));
    await new Promise((r) => setTimeout(r, 100));
    expect(guest.voice()).toEqual([]);

    guest.ws.close();
    owner.ws.close();
});
