// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// An extension socket that stops answering pings is dropped, so the extension can
// reconnect and calls fail fast instead of waiting out their timeouts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";

// The bridge writes ~/.atlas files and registers Chrome's native host: keep it all in a temp home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-bridge-home-"));
process.env.HOME = home;
process.env.ATLAS_DATA_DIR = path.join(home, "data");
vi.mock("../../overlay/overlay-chat.js", () => ({ getOverlayLocalToken: () => "t" }));

const bridge = await import("./chrome-bridge.js");
const port = 20000 + Math.floor(Math.random() * 20000);
bridge.initChromeBridge(port);

it("drops an extension that stops answering pings", async () => {
    await vi.waitFor(() => expect(bridge.getBridgeToken()).toBeTruthy());
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => ws.once("open", r));
    // The heartbeat's interval and clock start at auth: fake them from here (sockets stay real).
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    const authed = new Promise((r) => ws.on("message", (d) => JSON.parse(String(d)).type === "auth_ok" && r(true)));
    ws.send(JSON.stringify({ type: "auth", token: bridge.getBridgeToken() }));
    await authed;
    expect(bridge.isExtensionConnected()).toBe(true);

    // This client never answers the pings.
    const closed = new Promise((r) => ws.once("close", r));
    vi.advanceTimersByTime(45_000);
    vi.useRealTimers();
    await closed;
    expect(bridge.isExtensionConnected()).toBe(false);
    bridge.closeChromeBridge();
});
