// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

// Boots the overlay HTTP + WS server in-process. Verifies:
//  F2: /api/file and /api/browse require auth + workspace containment + deny-list.
//  F4: /api/push/subscribe requires auth.
//  F3: WS message dispatch sets isOwner correctly per source.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import http from "node:http";

const runAgentSpy = vi.fn(async () => ({ text: "stubbed", toolCalls: 0 }));
vi.mock("../../agent.js", () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runAgent: (...args: any[]) => runAgentSpy(...(args as [])),
    getConversationHistory: () => [],
    setConversationHistory: () => {},
}));
vi.mock("../../notifications/push.js", () => ({
    initPushNotifications: vi.fn(),
    getVapidPublicKey: () => "stub-vapid",
    registerSubscription: vi.fn(),
}));

const PORT = 28792; // not 18792: a running Bhai holds that one
const BASE = `http://127.0.0.1:${PORT}`;
const VALID_TOKEN = "T".repeat(48);

let scratch: string;
let workspaceDir: string;
let localToken: string;
let closeOverlay: () => void;

beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "atlas-overlay-http-"));
    workspaceDir = join(scratch, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    process.env.ATLAS_WORKSPACE = workspaceDir;
    process.env.WIDGET_TOKEN = VALID_TOKEN;
    process.env.HOME = scratch;
    process.env.ATLAS_OVERLAY_PORT = String(PORT);

    writeFileSync(join(workspaceDir, "foo.txt"), "hello");
    writeFileSync(join(workspaceDir, ".env"), "SECRET=1");

    const mod = await import("../../overlay/overlay-chat.js");
    closeOverlay = mod.closeOverlayChat;
    mod.initOverlayChat({} as never);
    localToken = mod.getOverlayLocalToken();
    await new Promise(r => setTimeout(r, 200));
});

afterAll(async () => {
    try { closeOverlay?.(); } catch { /* */ }
    await new Promise(r => setTimeout(r, 100));
    rmSync(scratch, { recursive: true, force: true });
    delete process.env.ATLAS_WORKSPACE;
    delete process.env.WIDGET_TOKEN;
});

describe("F2: /api/file auth + containment", () => {
    it("rejects request with no Authorization header (401)", async () => {
        const r = await fetch(`${BASE}/api/file?path=${encodeURIComponent("/etc/passwd")}`);
        expect(r.status).toBe(401);
    });

    it("rejects /etc/passwd even with valid auth (outside workspace)", async () => {
        const r = await fetch(`${BASE}/api/file?path=${encodeURIComponent("/etc/passwd")}`, {
            headers: { Authorization: `Bearer ${localToken}` },
        });
        expect(r.status).toBe(403);
    });

    it("rejects $WORKSPACE/.env (deny-list) with valid auth", async () => {
        const r = await fetch(`${BASE}/api/file?path=${encodeURIComponent(join(workspaceDir, ".env"))}`, {
            headers: { Authorization: `Bearer ${localToken}` },
        });
        expect(r.status).toBe(403);
    });

    it("serves $WORKSPACE/foo.txt with valid auth", async () => {
        const r = await fetch(`${BASE}/api/file?path=${encodeURIComponent(join(workspaceDir, "foo.txt"))}`, {
            headers: { Authorization: `Bearer ${localToken}` },
        });
        expect(r.status).toBe(200);
        const body = await r.text();
        expect(body).toBe("hello");
    });

    it("also accepts the widget token", async () => {
        const r = await fetch(`${BASE}/api/file?path=${encodeURIComponent(join(workspaceDir, "foo.txt"))}`, {
            headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        });
        expect(r.status).toBe(200);
    });

    it("does NOT set wildcard CORS on /api/file", async () => {
        const r = await fetch(`${BASE}/api/file?path=${encodeURIComponent(join(workspaceDir, "foo.txt"))}`, {
            headers: { Authorization: `Bearer ${localToken}` },
        });
        expect(r.headers.get("access-control-allow-origin")).toBeNull();
    });
});

describe("F2: /api/browse auth + containment", () => {
    it("rejects without auth (401)", async () => {
        const r = await fetch(`${BASE}/api/browse?dir=${encodeURIComponent("/")}`);
        expect(r.status).toBe(401);
    });

    it("rejects path outside workspace (403)", async () => {
        const r = await fetch(`${BASE}/api/browse?dir=${encodeURIComponent("/etc")}`, {
            headers: { Authorization: `Bearer ${localToken}` },
        });
        expect(r.status).toBe(403);
    });

    it("lists workspace dir with valid auth", async () => {
        const r = await fetch(`${BASE}/api/browse?dir=${encodeURIComponent(workspaceDir)}`, {
            headers: { Authorization: `Bearer ${localToken}` },
        });
        expect(r.status).toBe(200);
        const data = await r.json();
        const names = (data.entries as Array<{ name: string }>).map(e => e.name);
        expect(names).toContain("foo.txt");
    });
});

describe("F4: /api/push/subscribe auth", () => {
    it("rejects without auth (401)", async () => {
        const r = await fetch(`${BASE}/api/push/subscribe`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: "x", keys: { p256dh: "a", auth: "b" } }),
        });
        expect(r.status).toBe(401);
    });

    it("accepts with valid auth", async () => {
        const r = await fetch(`${BASE}/api/push/subscribe`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${localToken}` },
            body: JSON.stringify({ endpoint: "x", keys: { p256dh: "a", auth: "b" } }),
        });
        expect(r.status).toBe(201);
    });
});

// ── F3: WS owner-distinguishing ────────────────

// Resolves to the WS only if the server keeps it open for >150ms after the
// upgrade (i.e. did NOT close with 4001 immediately). Servers can close after
// `open`, so we explicitly settle the race.
function connectWS(query: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?${query}`);
        let settled = false;
        ws.once("open", () => {
            setTimeout(() => {
                if (settled) return;
                if (ws.readyState === WebSocket.OPEN) {
                    settled = true;
                    resolve(ws);
                }
            }, 200);
        });
        ws.once("error", (err) => {
            if (!settled) { settled = true; reject(err); }
        });
        ws.once("close", (code) => {
            if (!settled) { settled = true; reject(new Error(`closed code=${code}`)); }
        });
        setTimeout(() => {
            if (!settled) { settled = true; reject(new Error("ws connect timeout")); }
        }, 3000);
    });
}

async function sendChat(ws: WebSocket, text: string): Promise<void> {
    ws.send(JSON.stringify({ type: "chat", text }));
    // Wait for the server to call runAgent (stub resolves immediately).
    await new Promise(r => setTimeout(r, 500));
}

describe("F3: WS owner-distinguishing", () => {
    it("web-widget WS message gets isOwner:false", async () => {
        runAgentSpy.mockClear();
        const ws = await connectWS(`source=web-widget&token=${VALID_TOKEN}`);
        await sendChat(ws, "hello from widget");
        ws.close();
        await new Promise(r => setTimeout(r, 100));

        expect(runAgentSpy).toHaveBeenCalled();
        const lastCall = runAgentSpy.mock.calls[runAgentSpy.mock.calls.length - 1];
        const channelCtx = lastCall[lastCall.length - 1] as { isOwner: boolean; channel: string };
        expect(channelCtx.channel).toBe("overlay");
        expect(channelCtx.isOwner).toBe(false);
    });

    it("native-overlay WS message gets isOwner:true", async () => {
        runAgentSpy.mockClear();
        const ws = await connectWS(`localToken=${localToken}`);
        await sendChat(ws, "hello from native");
        ws.close();
        await new Promise(r => setTimeout(r, 100));

        expect(runAgentSpy).toHaveBeenCalled();
        const lastCall = runAgentSpy.mock.calls[runAgentSpy.mock.calls.length - 1];
        const channelCtx = lastCall[lastCall.length - 1] as { isOwner: boolean };
        expect(channelCtx.isOwner).toBe(true);
    });

    it("Stop aborts the running turn and answers within 2s", async () => {
        let seenSignal: AbortSignal | undefined;
        runAgentSpy.mockImplementationOnce(((...args: unknown[]) => {
            seenSignal = args[4] as AbortSignal;
            // A long turn that only ends when aborted.
            return new Promise((resolve) =>
                seenSignal?.addEventListener("abort", () => resolve({ text: "✅ Task stopped.", toolCalls: 0 })),
            );
        }) as never);
        const ws = await connectWS(`localToken=${localToken}`);
        const replies: Array<{ type: string; text?: string }> = [];
        ws.on("message", (d) => replies.push(JSON.parse(d.toString())));
        await sendChat(ws, "do something long");
        expect(seenSignal?.aborted).toBe(false);

        const t0 = Date.now();
        ws.send(JSON.stringify({ type: "stop" }));
        await new Promise((r) => setTimeout(r, 300));
        ws.close();
        expect(seenSignal?.aborted).toBe(true);
        expect(Date.now() - t0).toBeLessThan(2000);
        const responses = replies.filter((m) => m.type === "response");
        expect(responses.map((m) => m.text)).toEqual(["Stopped."]); // no second, late reply
    });

    it("rejects WS connection with no credentials", async () => {
        await expect(connectWS("")).rejects.toBeTruthy();
    });

    it("rejects web-widget WS with bad token", async () => {
        await expect(connectWS("source=web-widget&token=bad")).rejects.toBeTruthy();
    });

    it("rejects WS with bad localToken", async () => {
        await expect(connectWS("localToken=wrong")).rejects.toBeTruthy();
    });
});

describe("DNS-rebinding guard", () => {
    const get = (host: string) =>
        new Promise<number>((resolve, reject) => {
            const req = http.request({ host: "127.0.0.1", port: PORT, path: "/", headers: { host } }, (res) => {
                res.resume();
                resolve(res.statusCode ?? 0);
            });
            req.on("error", reject);
            req.end();
        });

    it("refuses a request addressed to another hostname (421)", async () => {
        expect(await get(`evil.example:${PORT}`)).toBe(421);
        expect(await get(`127.0.0.1:${PORT}`)).toBe(200);
    });

    it("closes an owner socket opened from a foreign web page, even with the token", async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?localToken=${localToken}`, { origin: "https://evil.example" });
        const code = await new Promise<number>((resolve) => {
            ws.on("close", (c) => resolve(c));
            setTimeout(() => resolve(0), 3000);
        });
        expect(code).toBe(4003);
    });
});

