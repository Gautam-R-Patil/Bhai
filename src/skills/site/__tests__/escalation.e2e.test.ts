// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Escalation to the owner on the synthetic shop (an OTP after the order), in headless Chromium:
//  1. Full chain: a real overlay socket, the real runAgent and consent gate, a scripted fake
//     model. site_task's needs_user reaches the owner's socket as a turn_answer carrying the
//     manifest prompt in < 2 s, and the code the owner types there resumes the task to done.
//     What the < 2 s covers: from executeTool returning needs_user to the owner's socket
//     receiving the frame (agent loop → the turn stream's ask → relay coalescing → ws), in this
//     process. The fake model waits MODEL_MS (> 2 s) before its reply, so only the
//     deterministic ask can pass it: the figure does not depend on a model call. Not covered:
//     the overlay's DOM render, and Telegram/WhatsApp/Discord/Slack (no turn events there:
//     they get the model's reply only).
//  2. Tool layer (site_task's handler): a resume picks up exactly where it paused (only the
//     OTP POST reaches the shop), also after a simulated restart (module reload; the same
//     Chromium page stays open, so a real restart's lost page is not proven here).
//  3. A 10-minute park, by a Date.now offset plus 1 s of real quiet (not 10 wall-clock
//     minutes; the shop's tickets never expire): the task parks with nothing running, and a
//     late code is never typed: the owner is asked for a fresh one, which finishes it.
//  4. Wrong codes re-prompt without a crash; the 4th prompt hits the cap (too_many_prompts),
//     nothing placed. The task is kept (its order may exist), so the owner's own right code
//     after that still completes the one consented order: never a second one.
// Plain `npm test` runs each once; SITE_ESCALATION_RUNS=50 is the acceptance run
// (describe retry is off then, so no failure is retried away).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { SHOP_RESOLVER_ARG, startShop } from "./synthetic-shop.js";

process.env.BHAI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "bhai-escalation-"));
process.env.BHAI_OVERLAY_PORT = String(20000 + Math.floor(Math.random() * 20000));

const RUNS = Number(process.env.SITE_ESCALATION_RUNS ?? 1);
const PROMPT = "Enter the code the shop sent to your phone";
const WRONG = "That didn't work. Please check it and send it again.";
const LATE = "That took a while, so I didn't use that code. Send the latest one.";
const ASK_MS = 2000;
const MODEL_MS = 2500; // the fake model's reply after needs_user: slower than ASK_MS on purpose
const TTL = 10 * 60_000;

const h = vi.hoisted(() => ({ page: null as any, t0: 0 }));
vi.mock("../../../tools/browser/core.js", async (orig) => ({
    ...(await orig<object>()),
    getActivePage: async () => h.page,
}));
vi.mock("../registry.js", async (orig) => {
    const m = await orig<typeof import("../registry.js")>();
    const { fileURLToPath } = await import("node:url");
    const builtin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
    return { ...m, findSiteSkill: (url: string) => m.findSiteSkill(url, [builtin]) };
});
vi.mock("../../../account-guard.js", async (orig) => ({
    ...(await orig<object>()),
    checkAccountStatus: async () => ({ allowed: true }),
}));
vi.mock("../../../agents/verify-before-done.js", async (orig) => ({
    ...(await orig<object>()),
    shouldForceVerify: () => false,
}));
// The clock starts when the runtime returns needs_user (a little before site_task's JSON and
// executeTool's return: the figure is if anything over-counted).
vi.mock("../runtime.js", async (orig) => {
    const m = await orig<typeof import("../runtime.js")>();
    return {
        ...m,
        runSiteTask: async (...a: Parameters<typeof m.runSiteTask>) => {
            const r = await m.runSiteTask(...a);
            if (r.status === "needs_user") h.t0 = performance.now();
            return r;
        },
    };
});

// The tool registry first, as the app loads it (site_task ← tools/index ← browser core is a cycle).
await import("../../../tools/index.js");
const { resetRateLimits } = await import("../../../tools/tool-intelligence.js");
type Tool = { handler: (i: Record<string, unknown>) => Promise<string> };
// The instance the agent's registry holds (the full chain's site_task; restart() swaps `site` only).
const agentSite = await import("../../../tools/site-task.js");
let site: Tool = agentSite.siteTask as Tool;
/** A restart: site_task's module state is gone; the parked task comes back from its checkpoint. */
const restart = async () => {
    vi.resetModules();
    site = (await import("../../../tools/site-task.js")).siteTask as Tool;
};
/**
 * A clean slate for a tool-layer case (and its retries): an earlier failure can leave a parked
 * order that blocks every new search. Not for the full chain, whose agent holds the first module.
 */
const clean = async () => {
    rmSync(path.join(process.env.BHAI_DATA_DIR as string, "site-tasks"), { recursive: true, force: true });
    await restart();
};
const call = async (i: Record<string, unknown>): Promise<any> => JSON.parse(await site.handler(i));
const checkpoint = (taskId: string) =>
    JSON.parse(readFileSync(path.join(process.env.BHAI_DATA_DIR as string, "site-tasks", `${taskId}.json`), "utf8"));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

let browser: any = null;
let shop: Awaited<ReturnType<typeof startShop>>;
beforeAll(async () => {
    process.env.BHAI_SPEND_CAP_DAY_INR = "1000000";
    process.env.BHAI_NO_AGENT_CURSOR = "true";
    try {
        const { chromium } = await import("playwright-core");
        browser = await chromium.launch({ headless: true, args: [SHOP_RESOLVER_ARG] });
    } catch (e) {
        // Locally a missing Chromium skips; in CI it must fail, not pass silently.
        if (process.env.CI || process.env.SITE_E2E_REQUIRE_BROWSER) throw e;
        browser = null;
        return;
    }
    shop = await startShop({ otp: true });
}, 60_000);
afterAll(async () => {
    delete process.env.BHAI_SPEND_CAP_DAY_INR;
    delete process.env.BHAI_NO_AGENT_CURSOR;
    await shop?.close();
    await browser?.close();
});

/** A fresh tab on the shop, with every request it makes (the favicon aside). */
async function fresh() {
    const context = await browser.newContext();
    const page = await context.newPage();
    const seen: string[] = [];
    page.on("request", (r: any) => {
        const u = new URL(r.url());
        if (u.pathname !== "/favicon.ico") seen.push(`${r.method()} ${u.pathname}`);
    });
    await page.goto(shop.url);
    h.page = page;
    return { context, page, seen };
}

/** search → select → confirm on the tool layer, up to the OTP question. */
async function toOtp() {
    const s = await call({ action: "search", query: "dal" });
    expect(s.status).toBe("options");
    const c = await call({ action: "select", option_id: s.options[0].id });
    expect([c.status, c.confirm?.amount]).toEqual(["confirm", 199]);
    const ask = await call({ action: "confirm", amount: 199 });
    expect([ask.status, ask.needsUser?.kind, ask.needsUser?.prompt]).toEqual(["needs_user", "otp", PROMPT]);
    return ask;
}
const ticket = (url: string) => new URL(url).searchParams.get("t");
const verifies = () => shop.requests().filter((r) => r.method === "POST" && r.path === "/verify");

// ── A fake model for the full chain ───────────────────────────
type Msg = { role: string; content?: unknown };
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
// The owner's code as the model sees it: the vault may have masked it to a handle.
const CODE = /\[OTP_\d+\]|\b\d{6}\b/;
const OWNER = (t: string) => /place the order/.test(t) || CODE.test(t);
type Req = { messages: Msg[]; onDelta?: (d: { kind: "text"; text: string }) => void };
const reply = (content: string, tool?: Record<string, unknown>) => ({
    choices: [
        {
            message: {
                role: "assistant",
                content,
                tool_calls: tool && [
                    {
                        id: `c${Math.random()}`,
                        type: "function",
                        function: { name: "site_task", arguments: JSON.stringify(tool) },
                    },
                ],
            },
            finish_reason: tool ? "tool_calls" : "stop",
        },
    ],
});
/**
 * Main-loop calls (given onDelta) read the conversation: the owner's latest message with no
 * site_task result after it gets the tool call (confirm for the yes, resume with the code);
 * after a result it says what the result says. Any extra main-loop call (a nudge) gets the
 * same answer again, so a push never turns the reply into something else. Helper calls: "ok".
 */
const fakeLLM = {
    chat: async (req: Req) => {
        if (!req.onDelta) return reply("ok");
        const msgs = req.messages;
        let u = msgs.length - 1;
        while (u >= 0 && !(msgs[u].role === "user" && OWNER(textOf(msgs[u])))) u--;
        const result = msgs
            .slice(u + 1)
            .reverse()
            .find((m) => m.role === "tool");
        const said = u >= 0 ? textOf(msgs[u]) : "";
        if (!result) {
            if (/place the order/.test(said)) return reply("", { action: "confirm", amount: 199, confirmed: true });
            const code = CODE.exec(said)?.[0];
            if (code) return reply("", { action: "resume", answer: code });
            return reply("ok");
        }
        const r = textOf(result);
        const text = /needs_user/.test(r)
            ? (/"prompt":"([^"]+)"/.exec(r)?.[1] ?? "no prompt in the tool result") // what reached the model's input
            : `Done: ${/Order placed #\d+/.exec(r)?.[0] ?? r.slice(0, 200)}`;
        if (/needs_user/.test(r)) await pause(MODEL_MS);
        req.onDelta({ kind: "text", text });
        return reply(text);
    },
};

describe("escalation to the owner", { retry: process.env.SITE_ESCALATION_RUNS ? 0 : 2 }, () => {
    it(`needs_user reaches the owner's overlay socket in < ${ASK_MS} ms; the code typed there finishes the order, ${RUNS}/${RUNS}`, async (ctx) => {
        if (!browser) return ctx.skip();
        // A failed attempt leaves its order parked (commit sent), which refuses every later
        // search: each attempt starts clean in the agent's own site_task, so a retry can pass.
        rmSync(path.join(process.env.BHAI_DATA_DIR as string, "site-tasks"), { recursive: true, force: true });
        agentSite._resetSiteTask();
        const chat = await import("../../../overlay/overlay-chat.js");
        chat.initOverlayChat(fakeLLM as never);
        const ws = new WebSocket(
            `ws://127.0.0.1:${process.env.BHAI_OVERLAY_PORT}/?localToken=${chat.getOverlayLocalToken()}`,
        );
        const frames: Array<{ m: { type: string; text?: string; turn?: string }; at: number }> = [];
        ws.on("message", (d) => frames.push({ m: JSON.parse(String(d)), at: performance.now() }));
        await new Promise((res, rej) => {
            ws.once("open", res);
            ws.once("error", rej);
        });
        const frameAfter = async (from: number, type: string) => {
            await vi.waitFor(() => expect(frames.slice(from).some((f) => f.m.type === type)).toBe(true), {
                timeout: 120_000,
                interval: 20,
            });
            return frames.slice(from).find((f) => f.m.type === type) as (typeof frames)[number];
        };
        await frameAfter(0, "ready");
        const lat: number[] = [];
        try {
            for (let i = 0; i < RUNS; i++) {
                const { context, page, seen } = await fresh();
                // 50 orders a minute is this test's pace, not an owner's: site_task's 30/min limit stays out of it.
                resetRateLimits();
                const chatId = `esc-${i}`;
                ws.send(JSON.stringify({ type: "hello", chat: chatId }));
                const orders0 = shop.orders();
                const s = await call({ action: "search", query: "dal" });
                const c = await call({ action: "select", option_id: s.options[0].id }); // the ask the yes answers
                expect(c.status).toBe("confirm");

                // "yes": the real consent gate grants the confirm, which ends on the OTP page.
                h.t0 = 0;
                let from = frames.length;
                ws.send(JSON.stringify({ type: "chat", text: "yes, place the order", chat: chatId }));
                const res1 = await frameAfter(from, "response");
                expect(h.t0).toBeGreaterThan(0); // needs_user left the tool
                let shown = "";
                let t1 = 0;
                for (const f of frames.slice(from)) {
                    if (f.m.type === "turn_answer_reset") shown = "";
                    if (f.m.type !== "turn_answer") continue;
                    shown += f.m.text ?? "";
                    if (shown.includes(PROMPT)) {
                        t1 = f.at;
                        break;
                    }
                }
                expect(t1, "the manifest prompt never reached the socket as turn_answer").toBeGreaterThan(0);
                lat.push(t1 - h.t0);
                expect(t1 - h.t0).toBeLessThan(ASK_MS);
                expect(res1.m.text).toContain(PROMPT); // the model saw the prompt in its tool result
                expect(shop.orders()).toBe(orders0);
                expect(checkpoint(c.task_id).status).toBe("needs_user");

                // The owner's code over the overlay: only the OTP form's POST, then /done.
                const T = ticket(page.url());
                shop.resetRequests();
                seen.length = 0;
                from = frames.length;
                ws.send(JSON.stringify({ type: "chat", text: "123456", chat: chatId }));
                const res2 = await frameAfter(from, "response");
                expect(res2.m.text).toContain("Order placed #");
                expect(shop.orders()).toBe(orders0 + 1);
                expect(verifies().map((r) => new URLSearchParams(r.body).get("t"))).toEqual([T]);
                expect(seen).toEqual(["POST /verify", "GET /done"]);
                await context.close();
            }
        } finally {
            console.log(
                `[escalation] needs_user → turn_answer ms: ${lat.map((x) => x.toFixed(0)).join(", ")} (max ${Math.max(...lat).toFixed(0)})`,
            );
            ws.close();
            chat.closeOverlayChat();
        }
    }, 600_000);

    it(`the owner's code resumes exactly where the task paused, also after a restart, ${RUNS}/${RUNS}`, async (ctx) => {
        if (!browser) return ctx.skip();
        await clean();
        for (let i = 0; i < RUNS; i++) {
            const { context, page, seen } = await fresh();
            const orders0 = shop.orders();
            const ask = await toOtp();
            const T = ticket(page.url());
            expect(T).toBeTruthy();
            shop.resetRequests();
            seen.length = 0;
            if (i % 2) await restart();
            const done = await call({ action: "resume", answer: "123456" });
            expect([done.status, done.summary]).toEqual(["done", `Order placed #${shop.orders()}`]);
            expect(shop.orders()).toBe(orders0 + 1);
            // Nothing before the pause runs again: no search, cart or order, just the code.
            expect(verifies().map((r) => new URLSearchParams(r.body).get("t"))).toEqual([T]);
            expect(shop.requests()).toHaveLength(1);
            expect(seen).toEqual(["POST /verify", "GET /done"]);
            expect(done.steps).toBeGreaterThan(ask.steps);
            expect(done.steps).toBeLessThan(40);
            expect(checkpoint(done.task_id).status).toBe("done");
            await context.close();
        }
    }, 600_000);

    it(`ignored for 10 minutes: parks with nothing running; a late code is never typed, a fresh one finishes it, ${RUNS}/${RUNS}`, async (ctx) => {
        if (!browser) return ctx.skip();
        await clean();
        const real = Date.now.bind(Date);
        let late = 0;
        for (let i = 0; i < RUNS; i++) {
            const { context, page, seen } = await fresh();
            const orders0 = shop.orders();
            const t0 = real();
            const ask = await toOtp();
            const T = ticket(page.url());
            // Parked: the handler returned, the busy lock is free, the checkpoint waits on the owner.
            expect(await site.handler({ action: "noop" })).toContain("Unknown action");
            const cp = checkpoint(ask.task_id);
            expect([cp.status, cp.commit?.state]).toEqual(["needs_user", "sent"]);
            expect(Math.abs(cp.waitingUntil - (t0 + TTL))).toBeLessThan(15_000);
            expect(cp.stepCount).toBeLessThan(40);
            expect(shop.orders()).toBe(orders0);
            shop.resetRequests();
            seen.length = 0;
            await pause(1000);
            expect([shop.requests(), seen]).toEqual([[], []]); // nothing runs while parked

            const kind = i % 3; // 0: late · 1: late after a restart · 2: just inside the TTL
            // The clock jumps to just before / just past the question's deadline.
            const offset = cp.waitingUntil + (kind === 2 ? -5000 : 1000) - real();
            const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
            try {
                if (kind === 1) await restart();
                if (kind === 2) {
                    const done = await call({ action: "resume", answer: "123456" });
                    expect(done.status).toBe("done");
                } else {
                    late++;
                    const again = await call({ action: "resume", answer: "123456" });
                    expect([again.status, again.reason, again.needsUser?.kind, again.needsUser?.prompt]).toEqual([
                        "needs_user",
                        "answer_expired",
                        "otp",
                        PROMPT,
                    ]);
                    expect(again.needsUser.retry).toBe(LATE);
                    expect(verifies()).toEqual([]); // the late code was not typed
                    expect(checkpoint(again.task_id).waitingUntil).toBeGreaterThan(Date.now());
                    const done = await call({ action: "resume", answer: "123456" });
                    expect(done.status).toBe("done");
                }
            } finally {
                spy.mockRestore();
            }
            expect(shop.orders()).toBe(orders0 + 1);
            expect(verifies().map((r) => new URLSearchParams(r.body).get("t"))).toEqual([T]);
            await context.close();
        }
        expect(late).toBeGreaterThan(0);
    }, 600_000);

    it(`wrong codes re-prompt without a crash; the cap stops the 4th prompt, ${RUNS}/${RUNS}`, async (ctx) => {
        if (!browser) return ctx.skip();
        await clean();
        const bad = ["driver_error", "loop_identical_args"];
        for (let i = 0; i < RUNS; i++) {
            const { context } = await fresh();
            const orders0 = shop.orders();
            await toOtp();
            shop.resetRequests();
            const k = i % 3; // the confirm's prompt + k wrong ones stays within the cap of 3
            for (let w = 0; w < k; w++) {
                const r = await call({ action: "resume", answer: String(w).repeat(6) });
                expect([r.status, r.needsUser?.kind, r.needsUser?.prompt, r.needsUser?.retry]).toEqual([
                    "needs_user",
                    "otp",
                    PROMPT,
                    WRONG,
                ]);
                expect(bad.some((b) => String(r.reason ?? "").startsWith(b))).toBe(false);
            }
            const done = await call({ action: "resume", answer: "123456" });
            expect(done.status).toBe("done");
            expect(shop.orders()).toBe(orders0 + 1);
            expect(verifies()).toHaveLength(k + 1);
            await context.close();

            if (i % 3 !== 2) continue;
            // The cap: 3 wrong codes, and the 4th prompt ends the task with nothing placed.
            const cap = await fresh();
            const before = shop.orders();
            await toOtp();
            let last: { status?: string; reason?: string } = {};
            for (const code of ["000000", "111111", "222222"]) last = await call({ action: "resume", answer: code });
            expect([last.status, last.reason]).toEqual(["failed", "too_many_prompts"]);
            expect(shop.orders()).toBe(before);
            expect(cap.page.url()).toMatch(/\/otp\?.*wrong=1/);
            // The task stays (the order may exist: site_task keeps it), so the owner's own right
            // code still finishes that one consented order: one more /verify, one order, no resubmit.
            shop.resetRequests();
            const after = await call({ action: "resume", answer: "123456" });
            expect(after.status).toBe("done");
            expect([shop.orders(), verifies().length]).toEqual([before + 1, 1]);
            expect(shop.requests().some((r) => r.path.startsWith("/order"))).toBe(false);
            await cap.context.close();
            // The tool is still healthy: a fresh search works.
            const next = await fresh();
            expect((await call({ action: "search", query: "dal" })).status).toBe("options");
            await next.context.close();
        }
    }, 600_000);
});
