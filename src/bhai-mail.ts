// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Bhai's own email address (<name>.bhai@xagilab.com). The server reads the
// shared mailbox and keeps only mail from this user's own address for us
// (convex/bhaiMail.ts); we collect it, run the agent, and reply through the
// server, which only ever writes to the owner.

import { runAgent } from "./agent.js";
import { withStuckReplyLine } from "./channel-text.js";
import { getConvexSiteUrl } from "./config/keys.js";
import { encryptedFetch } from "./crypto-transport.js";
import { sanitizeIncomingChannelText } from "./email.js";
import type { LLMClient } from "./llm.js";
import { getSessionToken, handleAuthError } from "./session.js";

const POLL_MS = 15_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

type MailItem = { id: string; messageId: string; subject: string; text: string };

async function mailApi<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
    let token = await getSessionToken();
    if (!token) return null;
    const call = (t: string) =>
        encryptedFetch(`${getConvexSiteUrl()}${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    let res = await call(token);
    if (res.status === 401) {
        token = await handleAuthError();
        if (!token) return null;
        res = await call(token);
    }
    return (await res.json().catch(() => null)) as T | null;
}

async function handle(llm: LLMClient, owner: string, mail: MailItem): Promise<void> {
    const subject = sanitizeIncomingChannelText(mail.subject);
    const body = sanitizeIncomingChannelText(mail.text);
    const message = `[EMAIL from you <${owner}> to your Bhai email]\nSubject: ${subject}\n\n<channel_message_content>\n${body}\n</channel_message_content>\n\n[ATLAS-INTERNAL — not from user: This arrived at your own Bhai email address. Respond naturally; your reply is emailed back.]`;
    const result = await runAgent(llm, message, async () => {}, undefined, undefined, undefined, undefined, undefined, {
        channel: "email",
        userId: owner,
        userName: undefined,
        isOwner: true,
    });
    const reply = withStuckReplyLine(result, true);
    if (!reply.trim() || reply.trim() === "[NO_REPLY]") return;
    const sent = await mailApi<{ ok: boolean; error?: string }>("/api/mail/send", {
        subject: /^re:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject || "your email"}`,
        text: reply,
        inReplyTo: mail.messageId,
    });
    if (!sent?.ok) console.error(`[BHAI-MAIL] Reply failed: ${sent?.error ?? "no response"}`);
}

async function tick(llm: LLMClient, owner: string): Promise<void> {
    if (running) return;
    running = true;
    try {
        const box = await mailApi<{ messages?: MailItem[] }>("/api/mail/inbox", {});
        for (const mail of box?.messages ?? []) {
            console.log(`\n📧 [BHAI-MAIL] ${mail.subject || "(no subject)"}`);
            try {
                await handle(llm, owner, mail);
            } catch (err) {
                console.error("[BHAI-MAIL] Failed:", (err as Error).message);
            }
            // Ack even on failure: a mail that crashes the agent shouldn't loop forever.
            await mailApi("/api/mail/ack", { ids: [mail.id] });
        }
    } catch (err) {
        console.warn("[BHAI-MAIL] Poll failed:", (err as Error).message);
    } finally {
        running = false;
    }
}

export function initBhaiMail(llm: LLMClient): void {
    const address = process.env.BHAI_MAIL_ADDRESS;
    const owner = process.env.BHAI_MAIL_OWNER;
    if (!address || !owner) return;
    console.log(`   📧 Bhai's email: ${address} (answers ${owner})`);
    const loop = async () => {
        await tick(llm, owner);
        timer = setTimeout(loop, POLL_MS);
    };
    timer = setTimeout(loop, 3_000);
}

export function closeBhaiMail(): void {
    if (timer) clearTimeout(timer);
    timer = null;
}
