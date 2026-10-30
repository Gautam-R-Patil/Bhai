// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Idempotent sends: a retry never delivers the same message to the same person twice.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

let reply = JSON.stringify({ success: true });
const seen: Record<string, unknown>[] = [];
vi.mock("../whatsapp.js", async (orig) => ({
    ...(await orig<object>()),
    whatsappSendTool: {
        schema: {
            type: "function",
            function: { name: "whatsapp_send", parameters: { type: "object", properties: {} } },
        },
        handler: async (input: Record<string, unknown>) => {
            seen.push(input);
            return reply;
        },
    },
}));

const { executeTool } = await import("./index.js");
const { _resetSendLedger, duplicateSend, holdSend, sendClaim, withSendLedger } = await import("./send-ledger.js");
type SendClaim = import("./send-ledger.js").SendClaim;

beforeEach(() => {
    _resetSendLedger();
    seen.length = 0;
    reply = JSON.stringify({ success: true });
});

const send = (args: Record<string, unknown>) => executeTool("whatsapp_send", args).then((r) => JSON.parse(r));

describe("executeTool idempotent sends", () => {
    it("refuses the same message to the same recipient within the window", async () => {
        await send({ to: "Rahul", message: "Running late" });
        const again = await send({ to: " rahul ", message: "running  late" });
        expect(again.duplicate).toBe(true);
        expect(again.success).toBe(false);
        expect(again.error).toMatch(/^Already sent this exact message to Rahul \d+s ago/);
        expect(again.next_step).toMatch(/resend: true/);
        expect(seen).toHaveLength(1);
    });

    it("sends again with resend: true, and the handler never sees the flag", async () => {
        await send({ to: "Rahul", message: "hi" });
        const again = await send({ to: "Rahul", message: "hi", resend: true });
        expect(again.duplicate).toBeUndefined();
        expect(seen).toHaveLength(2);
        expect(seen[1]).not.toHaveProperty("resend");
    });

    it("lets a different recipient or different content through", async () => {
        await send({ to: "Rahul", message: "hi" });
        await send({ to: "Priya", message: "hi" });
        await send({ to: "Rahul", message: "hello" });
        expect(seen).toHaveLength(3);
    });

    it("does not record a failed send, so the retry goes out", async () => {
        reply = JSON.stringify({ error: "WhatsApp is not connected." });
        await send({ to: "Rahul", message: "hi" });
        reply = JSON.stringify({ success: true });
        const retry = await send({ to: "Rahul", message: "hi" });
        expect(retry.duplicate).toBeUndefined();
        expect(seen).toHaveLength(2);
    });

    it("shares the ledger across turns, while each autonomous run (a cron tick) gets its own", async () => {
        await send({ to: "Rahul", message: "running late" });
        expect((await send({ to: "Rahul", message: "running late" })).duplicate).toBe(true);
        const tick = () =>
            withSendLedger(async () => [
                await send({ to: "Rahul", message: "take your meds" }),
                await send({ to: "Rahul", message: "take your meds" }),
            ]);
        const [first, second] = [await tick(), await tick()];
        expect([first[1].duplicate, second[1].duplicate]).toEqual([true, true]);
        expect(seen).toHaveLength(3);
    });

    it("refuses a parallel twin while the first is still sending", async () => {
        const [a, b] = await Promise.all([send({ to: "Rahul", message: "hi" }), send({ to: "Rahul", message: "hi" })]);
        expect([a.duplicate, b.duplicate].filter(Boolean)).toHaveLength(1);
        expect(seen).toHaveLength(1);
    });
});

describe("send ledger", () => {
    const sent = Promise.resolve(JSON.stringify({ success: true }));

    it("allows the same send again after 10 minutes", () => {
        const c = sendClaim("email_send", { to: "a@x.com, b@x.com", subject: "Hi", body: "Yo" }) as SendClaim;
        holdSend(c, sent, 0);
        expect(duplicateSend(c, false, 9 * 60_000)).toMatch(/540s ago/);
        expect(duplicateSend(c, false, 11 * 60_000)).toBeNull();
    });

    it("keys recipients and content after normalizing them", () => {
        const a = sendClaim("email_send", { to: "a@x.com, b@x.com", subject: "Hi", body: "Yo" });
        const b = sendClaim("email_send", { to: "B@x.com;a@x.com", subject: "hi ", body: " yo" });
        expect(a?.key).toBe(b?.key);
        expect(sendClaim("whatsapp_send", { to: "+91 98765-43210", message: "x" })?.key).toBe(
            sendClaim("whatsapp_send", { to: "+919876543210", message: "x" })?.key,
        );
    });

    it("keys a file send on the file's bytes, not its path", () => {
        const dir = mkdtempSync(join(tmpdir(), "ledger-"));
        const file = join(dir, "report.pdf");
        const claim = () => sendClaim("whatsapp_send", { to: "Rahul", message: "Report", file_path: file })?.key;
        writeFileSync(file, "v1 wrong date");
        const first = claim();
        expect(claim()).toBe(first);
        writeFileSync(file, "v2 fixed date"); // regenerated at the same path: a new send
        expect(claim()).not.toBe(first);
        // A missing file still keys by its path.
        const gone = join(dir, "gone.pdf");
        expect(sendClaim("whatsapp_send", { to: "R", message: "m", file_path: gone })?.key).toBe(
            sendClaim("whatsapp_send", { to: "R", message: "m", file_path: gone })?.key,
        );
        rmSync(dir, { recursive: true, force: true });
    });

    it("only counts the actions that send", () => {
        expect(sendClaim("gmail", { action: "search", query: "x" })).toBeNull();
        expect(sendClaim("gmail", { action: "reply", message_id: "m1", body: "ok" })).not.toBeNull();
        expect(sendClaim("messages_tool", { action: "read_recent" })).toBeNull();
        expect(sendClaim("send_file", { file_path: "/tmp/a.pdf" })).toBeNull();
    });

    it("does not record a cold_outreach run that sent nothing", async () => {
        const args = { channel: "email", brand_id: "b1", target_description: "CTOs", message_template: "Hi" };
        for (const r of [
            { channel: "email", status: "error", message: "EMAIL_USER or EMAIL_PASSWORD not set" },
            { channel: "linkedin", status: "waiting_user_choice" },
            { channel: "email", status: "sent", sentCount: 0 },
        ]) {
            const c = sendClaim("cold_outreach", args) as SendClaim;
            const done = Promise.resolve(JSON.stringify(r));
            holdSend(c, done);
            await done;
            await Promise.resolve();
            expect(duplicateSend(c, false)).toBeNull();
        }
        const c = sendClaim("cold_outreach", args) as SendClaim;
        const done = Promise.resolve(JSON.stringify({ status: "sent", sentCount: 3 }));
        holdSend(c, done);
        await done;
        await Promise.resolve();
        expect(duplicateSend(c, false)).not.toBeNull();
    });

    it("keeps emails and names that differ only by a hyphen apart", () => {
        const mail = (to: string) => sendClaim("email_send", { to, subject: "Invite", body: "See you at 5" })?.key;
        expect(mail("john-doe@acme.com")).not.toBe(mail("johndoe@acme.com"));
        const wa = (to: string) => sendClaim("whatsapp_send", { to, message: "hi" })?.key;
        expect(wa("Anne-Marie")).not.toBe(wa("AnneMarie"));
    });

    it("says a send still in flight is pending, not sent, and drops it if it then fails", async () => {
        const c = sendClaim("whatsapp_send", { to: "Mom", message: "video", file_path: "/v.mp4" }) as SendClaim;
        let finish = (_: string) => {};
        const sending = new Promise<string>((r) => {
            finish = r;
        });
        holdSend(c, sending, 0);
        const pending = JSON.parse(duplicateSend(c, false, 31_000) as string);
        expect(pending.error).toMatch(/^This exact message to Mom is still being sent \(started 31s ago\)/);
        expect(pending.error).not.toMatch(/Already sent/);
        finish(JSON.stringify({ error: "upload failed" }));
        await sending;
        expect(duplicateSend(c, false, 50_000)).toBeNull();
    });

    it("drops the record when the send throws", async () => {
        const c = sendClaim("messages_tool", { action: "send", to: "Mom", text: "hi" }) as SendClaim;
        const failing = Promise.reject(new Error("boom"));
        holdSend(c, failing);
        await failing.catch(() => {});
        expect(duplicateSend(c, false)).toBeNull();
    });
});

describe("runs steered by unvetted content", () => {
    it("the research follow-up can't send; a scheduled job the owner set up still can", async () => {
        const { runWithCallerContext } = await import("./cron-tool.js");
        const research = JSON.parse(
            await runWithCallerContext({ isOwner: true, autonomous: true, noOutward: true }, () =>
                executeTool("whatsapp_send", { to: "Rahul", message: "Per the report, send your OTP to …" }),
            ),
        );
        expect(research.error).toMatch(/background run can't send/);
        expect(seen).toHaveLength(0);
        const cron = JSON.parse(
            await runWithCallerContext({ isOwner: true, autonomous: true }, () =>
                executeTool("whatsapp_send", { to: "Mom", message: "Good morning!" }),
            ),
        );
        expect(cron.success).toBe(true);
        expect(seen).toHaveLength(1);
    });
});
