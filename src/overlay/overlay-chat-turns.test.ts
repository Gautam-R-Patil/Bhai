// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Live turn events over the overlay socket: only the turn's own chat sees them, a rejoining
// chat bar gets a snapshot, and old clients still get the whole reply from `response`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { AgentResponse, ChannelContext } from "../agent.js";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-overlay-chat-turns-"));
process.env.ATLAS_OVERLAY_PORT = String(20000 + Math.floor(Math.random() * 20000));

type Call = {
    ctx: ChannelContext;
    signal: AbortSignal;
    resolve: (r: AgentResponse) => void;
    reject: (e: Error) => void;
};
let call: Call | undefined;
vi.mock("../agent.js", async (orig) => ({
    ...(await orig<typeof import("../agent.js")>()),
    runAgent: vi.fn(
        (...a: unknown[]) =>
            new Promise((resolve, reject) => {
                call = { ctx: a[8] as ChannelContext, signal: a[4] as AbortSignal, resolve, reject };
            }),
    ),
}));

const chat = await import("./overlay-chat.js");
chat.initOverlayChat({} as never);
const url = `ws://127.0.0.1:${process.env.ATLAS_OVERLAY_PORT}/?localToken=${chat.getOverlayLocalToken()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Msg = { type: string; text?: string; turn?: string; [k: string]: unknown };
async function open() {
    const ws = new WebSocket(url);
    const all: Msg[] = [];
    const seen: Msg[] = [];
    const waiters: Array<() => void> = [];
    ws.on("message", (d) => {
        const m = JSON.parse(String(d));
        all.push(m);
        seen.push(m);
        for (const w of waiters.splice(0)) w();
    });
    const next = async (type: string): Promise<Msg> => {
        for (;;) {
            const i = seen.findIndex((m) => m.type === type);
            if (i >= 0) return seen.splice(i, 1)[0];
            await new Promise<void>((r) => waiters.push(r));
        }
    };
    const send = (m: object) => ws.send(JSON.stringify(m));
    await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
    });
    await next("ready");
    return { ws, all, next, send };
}

/** Start a turn from a fresh chat bar and wait until the (mocked) agent is running it. */
async function startTurn(chatId: string) {
    call = undefined;
    const bar = await open();
    bar.send({ type: "hello", chat: chatId });
    bar.send({ type: "chat", text: "count my unread emails", chat: chatId });
    const running = () => call as Call | undefined; // set by the mocked runAgent
    await vi.waitFor(() => expect(running()).toBeDefined(), { timeout: 10_000 });
    const c = running() as Call;
    return { bar, c, emit: c.ctx.onTurnEvent as NonNullable<ChannelContext["onTurnEvent"]> };
}

it("an old client that ignores turn_* still gets the full response", async () => {
    const { bar, c, emit } = await startTurn("bar-old");
    const thinking = await bar.next("thinking");
    expect(thinking.turn).toMatch(/^\w+$/);
    emit({ type: "step", id: 1, text: "Reading mail", state: "running" });
    emit({ type: "answer", attempt: 0, text: "3 unread, " });
    emit({ type: "step", id: 1, text: "Reading mail", state: "done" });
    emit({ type: "answer", attempt: 0, text: "nothing urgent" });
    emit({ type: "end" });
    c.resolve({ text: "3 unread, nothing urgent", toolCalls: 1 });
    const res = await bar.next("response");
    expect(res.text).toBe("3 unread, nothing urgent");
    expect(res.turn).toBe(thinking.turn);
    expect(res.worked).toMatchObject({ steps: 1 });
    expect((res.worked as { secs: number }).secs).toBeGreaterThanOrEqual(0);
    // The streamed pieces carried the same turn id and an increasing seq.
    const turnMsgs = bar.all.filter((m) => m.type.startsWith("turn_"));
    expect(turnMsgs.every((m) => m.turn === thinking.turn)).toBe(true);
    expect(turnMsgs.map((m) => m.seq)).toEqual(turnMsgs.map((_, i) => i + 1));
    bar.ws.close();
});

it("an overlay turn's events never reach the extension socket", async () => {
    const ext = await open(); // the extension: an owner socket that never names a chat
    const { bar, c, emit } = await startTurn("bar-1");
    emit({ type: "answer", attempt: 0, text: "Hel" });
    await bar.next("turn_answer");
    bar.ws.close(); // the chat bar's socket drops mid-turn
    await sleep(50);
    emit({ type: "status", text: "Reading mail", step: 1, elapsedSec: 2 });
    emit({ type: "step", id: 1, text: "Reading mail", state: "running" });
    emit({ type: "note", text: "Looking for urgent ones" });
    emit({ type: "answer", attempt: 0, text: "lo" });
    emit({ type: "end" });
    c.resolve({ text: "Hello", toolCalls: 0 });
    await sleep(150);
    expect(ext.all.filter((m) => m.type.startsWith("turn_"))).toEqual([]);
    ext.ws.close();
});

it("a rejoining socket gets a snapshot", async () => {
    const { bar, c, emit } = await startTurn("bar-2");
    emit({ type: "step", id: 1, text: "Reading mail", state: "running" });
    emit({ type: "note", text: "Checking unread" });
    emit({ type: "answer", attempt: 0, text: "3 unread" });
    await bar.next("turn_answer");
    const turn = (await bar.next("thinking")).turn;
    bar.ws.close();
    await sleep(50);
    emit({ type: "answer", attempt: 0, text: ", nothing" }); // lost with the old socket…
    await sleep(80);
    const back = await open();
    back.send({ type: "hello", chat: "bar-2" });
    const snap = await back.next("turn_snapshot");
    expect(snap).toMatchObject({
        turn,
        steps: [{ id: 1, text: "Reading mail", state: "running" }],
        notes: ["Checking unread"],
        answer: "3 unread, nothing", // …but the snapshot has it
    });
    emit({ type: "answer", attempt: 0, text: " urgent" }); // later deltas reach the new socket
    expect((await back.next("turn_answer")).text).toBe(" urgent");
    emit({ type: "end" });
    c.resolve({ text: "3 unread, nothing urgent", toolCalls: 0 });
    expect((await back.next("response")).text).toBe("3 unread, nothing urgent");
    // Another chat's socket asking for its own chat gets no snapshot.
    const other = await open();
    other.send({ type: "hello", chat: "bar-x" });
    await sleep(50);
    expect(other.all.some((m) => m.type === "turn_snapshot")).toBe(false);
    for (const s of [back, other]) s.ws.close();
});

it("all attempts failing ends with the stream-cut note", async () => {
    const { bar, c, emit } = await startTurn("bar-3");
    emit({ type: "answer", attempt: 0, text: "Here is what I fo" });
    c.reject(new Error("socket hang up"));
    expect((await bar.next("error")).text).toBe("Lost the connection mid-answer. Ask me again.");
    bar.ws.close();
});

it("stop sends the partial answer plus Stopped.", async () => {
    const { bar, c, emit } = await startTurn("bar-4");
    emit({ type: "answer", attempt: 0, text: "Here is the par" });
    await bar.next("turn_answer");
    c.signal.addEventListener("abort", () =>
        c.resolve({ text: "✅ Task stopped. (1 credits used)", toolCalls: 0, partialText: "Here is the par" }),
    );
    bar.send({ type: "stop" });
    const res = await bar.next("response");
    expect(res).toMatchObject({ text: "Here is the par\n\nStopped.", stopped: true });
    bar.ws.close();
});
