// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

// F5: Canvas WS requires an in-band auth handshake. Unauthenticated
// connections are dropped after the auth timeout (or on bad credentials).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 28791; // not 18791: a running Bhai holds that one
let scratch: string;
let localToken: string;
let closeCanvas: () => void;

beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "bhai-canvas-"));
    process.env.HOME = scratch;

    // Force the overlay-chat module to lazily generate a local token file under
    // our scratch HOME — getOverlayLocalToken() is exported by overlay-chat.
    const overlayMod = await import("../../overlay/overlay-chat.js");
    localToken = overlayMod.getOverlayLocalToken();

    const canvas = await import("../../canvas/server.js");
    closeCanvas = canvas.closeCanvas;
    canvas.initCanvas(PORT);
    await new Promise(r => setTimeout(r, 200));
});

afterAll(async () => {
    try { closeCanvas?.(); } catch { /* */ }
    await new Promise(r => setTimeout(r, 100));
    rmSync(scratch, { recursive: true, force: true });
});

describe("F5: Canvas WS auth", () => {
    it("drops unauthenticated connections (no auth message → timeout close)", async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
            ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
            // Don't send anything.
            // The auth timeout is 5s; we'll wait up to 7s.
            setTimeout(() => resolve({ code: 0, reason: "no-close" }), 7000);
        });
        expect(closed.code).toBe(4001);
    }, 10000);

    it("closes connection on wrong token", async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        await new Promise(r => ws.once("open", r));
        ws.send(JSON.stringify({ type: "auth", token: "nope" }));
        const closed = await new Promise<{ code: number }>((resolve) => {
            ws.on("close", (code) => resolve({ code }));
            setTimeout(() => resolve({ code: 0 }), 3000);
        });
        expect(closed.code).toBe(4001);
    });

    it("accepts valid local-token auth", async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        await new Promise(r => ws.once("open", r));
        ws.send(JSON.stringify({ type: "auth", token: localToken }));
        const initMsg = await new Promise<{ type: string }>((resolve, reject) => {
            ws.on("message", (data) => {
                try { resolve(JSON.parse(data.toString())); } catch (err) { reject(err); }
            });
            setTimeout(() => reject(new Error("no init")), 3000);
        });
        expect(initMsg.type).toBe("init");
        ws.close();
    });
});
