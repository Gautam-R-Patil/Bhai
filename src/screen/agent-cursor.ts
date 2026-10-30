// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Bhai's ghost cursor for computer use. The desktop app draws it in a
 * click-through overlay (desktop/agent-cursor.js); the bot only sends small
 * events as stdout lines (`##BHAI_CURSOR##{json}`) and reads acks from stdin
 * (`##BHAI_CURSOR_ACK##<id>`), the same pipe the companion uses.
 *
 * Every call is a no-op unless the desktop app spawned the bot
 * (ATLAS_AGENT_CURSOR_IPC=1) and ATLAS_NO_AGENT_CURSOR is not "true". Waits are
 * bounded (glide ≤300ms, hide ≤150ms), so a missing or stuck app never stalls
 * a click or a screenshot. Coordinates are global screen points, as posted to
 * CGEvent / SetCursorPos.
 */

import { AsyncLocalStorage } from "node:async_hooks";

type Point = { x: number; y: number };
type CursorEvent =
    | { t: "move"; x: number; y: number }
    | { t: "click"; x: number; y: number; button: string; count: number }
    | { t: "drag"; points: Point[] }
    | { t: "scroll"; x: number; y: number; dx: number; dy: number }
    | { t: "type"; on: boolean }
    | { t: "session"; on: boolean }
    | { t: "hide" }
    | { t: "show" }
    | { t: "warm" };

const GLIDE_WAIT_MS = 300;
const HIDE_WAIT_MS = 150;
const FADE_MS = 700; // desktop fades the glow out over 600ms after a session ends

let writeLine = (line: string): void => {
    process.stdout.write(line);
};
let listening = false;
let seq = 0;
const pending = new Map<number, () => void>();
let inputTail = "";
let sessionOn = false;
let endedAt = 0;
let hiddenDepth = 0;
let hiding: Promise<void> = Promise.resolve();
/** Turns that have driven the screen and are still running. */
let drivers = 0;
const turnStore = new AsyncLocalStorage<{ drove: boolean; done: boolean }>();

export function agentCursorEnabled(): boolean {
    return process.env.ATLAS_NO_AGENT_CURSOR !== "true" && process.env.ATLAS_AGENT_CURSOR_IPC === "1";
}

function send(evt: CursorEvent & { id?: number }): void {
    try {
        writeLine(`##BHAI_CURSOR##${JSON.stringify(evt)}\n`);
    } catch {
        /* app gone: the cursor is cosmetic */
    }
}

/** Parse ack lines from the desktop app (exported for tests). */
export function _handleCursorInput(chunk: string): void {
    const lines = (inputTail + chunk).split("\n");
    inputTail = lines.pop() ?? "";
    for (const line of lines) {
        const m = line.match(/^##BHAI_CURSOR_ACK##(\d+)\s*$/);
        if (m) pending.get(Number(m[1]))?.();
    }
}

function listen(): void {
    if (listening) return;
    listening = true;
    try {
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c: string) => _handleCursorInput(c));
        process.stdin.on("error", () => {});
    } catch {
        /* no stdin: requests just time out */
    }
}

/** Send an event and wait for its ack, at most `ms`. Never rejects. */
function request(evt: CursorEvent, ms: number): Promise<void> {
    listen();
    const id = ++seq;
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            pending.delete(id);
            resolve();
        };
        const timer = setTimeout(done, ms);
        pending.set(id, done);
        send({ ...evt, id });
    });
}

function touch(): void {
    const turn = turnStore.getStore();
    if (turn && !turn.drove && !turn.done) {
        turn.drove = true;
        drivers++;
    }
    if (sessionOn) return;
    sessionOn = true;
    send({ t: "session", on: true });
}

const r = (n: number) => Math.round(n);

/**
 * A model call is about to be offered these tools: if any can drive the screen
 * (os_*), have the app load its cursor windows now, a model call ahead of the
 * first click, so the ghost leads it even on a cold start.
 */
export function warmCursorForTools(
    tools: ReadonlyArray<{ type?: string; function?: { name?: string } }> | undefined,
): void {
    if (sessionOn || !tools?.length || !agentCursorEnabled()) return;
    if (tools.some((t) => t.function?.name?.startsWith("os_"))) send({ t: "warm" });
}

/** Glide the ghost cursor to (x, y) before a real move. */
export async function cursorMove(x: number, y: number): Promise<void> {
    if (!agentCursorEnabled()) return;
    touch();
    await request({ t: "move", x: r(x), y: r(y) }, GLIDE_WAIT_MS);
}

/** Glide to (x, y) and ripple, before the real click. */
export async function cursorClick(x: number, y: number, button = "left", count = 1): Promise<void> {
    if (!agentCursorEnabled()) return;
    touch();
    await request({ t: "click", x: r(x), y: r(y), button, count }, GLIDE_WAIT_MS);
}

/** Glide to the drag start; the overlay then follows the path. */
export async function cursorDrag(points: Point[]): Promise<void> {
    if (!agentCursorEnabled() || points.length === 0) return;
    touch();
    await request({ t: "drag", points: points.map((p) => ({ x: r(p.x), y: r(p.y) })) }, GLIDE_WAIT_MS);
}

export async function cursorScroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    if (!agentCursorEnabled()) return;
    touch();
    await request({ t: "scroll", x: r(x), y: r(y), dx, dy }, GLIDE_WAIT_MS);
}

/** Show the typing pulse while `fn` types. */
export async function withCursorTyping<T>(fn: () => Promise<T>): Promise<T> {
    if (!agentCursorEnabled()) return fn();
    touch();
    send({ t: "type", on: true });
    try {
        return await fn();
    } finally {
        send({ t: "type", on: false });
    }
}

/**
 * Run a screen capture with the ghost cursor and glow hidden, so Bhai's own
 * screenshots (vision grounding, click verification) never see them.
 * Overlapping captures share one hide; show goes out when the last finishes.
 */
export async function withCursorHidden<T>(capture: () => Promise<T>): Promise<T> {
    // Also hide while the glow is still fading out from the last session.
    if (!agentCursorEnabled() || (!sessionOn && Date.now() - endedAt > FADE_MS)) return capture();
    if (hiddenDepth++ === 0) hiding = request({ t: "hide" }, HIDE_WAIT_MS);
    try {
        await hiding;
        return await capture();
    } finally {
        if (--hiddenDepth === 0) send({ t: "show" });
    }
}

/** Fade the glow out: Bhai is no longer in control. */
export function endCursorSession(): void {
    if (!sessionOn) return;
    sessionOn = false;
    endedAt = Date.now();
    send({ t: "session", on: false });
}

/**
 * Run one agent turn. When the last running turn that drove the screen ends,
 * the session ends (glow fades). Turns that never touch the screen (heartbeat,
 * other channels) don't hold the glow on.
 */
export async function trackCursorTurn<T>(fn: () => Promise<T>): Promise<T> {
    const outer = turnStore.getStore();
    if (outer && !outer.done) return fn(); // nested turn (sub-agent): the outer turn owns the screen
    const turn = { drove: false, done: false };
    try {
        return await turnStore.run(turn, fn);
    } finally {
        turn.done = true;
        if (turn.drove && --drivers === 0) endCursorSession();
    }
}

/** Test hook: capture writes instead of stdout and reset state. */
export function _resetAgentCursorForTest(write: (line: string) => void): void {
    writeLine = write;
    listening = true; // tests feed acks through _handleCursorInput
    seq = 0;
    pending.clear();
    inputTail = "";
    sessionOn = false;
    endedAt = 0;
    hiddenDepth = 0;
    hiding = Promise.resolve();
    drivers = 0;
}
