// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// "use node": imapflow and nodemailer need Node built-ins (net, tls).
// Reads Bhai's catch-all mailbox and sends Bhai's replies (see bhaiMail.ts).

"use node";

import { v } from "convex/values";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { mailDomain, pickBhaiRecipient, stripQuoted } from "./bhaiMailHelpers";

const PER_RUN = 20;
const MAX_PART_BYTES = 200_000;

function mailConfig() {
    const user = process.env.BHAI_MAIL_USER;
    const pass = process.env.BHAI_MAIL_PASS;
    if (!user || !pass) return null;
    return {
        user,
        pass,
        imapHost: process.env.BHAI_MAIL_IMAP_HOST || "imap.hostinger.com",
        smtpHost: process.env.BHAI_MAIL_SMTP_HOST || "smtp.hostinger.com",
    };
}

type Part = { part?: string; type?: string; disposition?: string; childNodes?: Part[] };

function findPart(node: Part | undefined, type: string): Part | null {
    if (!node) return null;
    if (node.type === type && node.disposition !== "attachment") return node;
    for (const child of node.childNodes ?? []) {
        const hit = findPart(child, type);
        if (hit) return hit;
    }
    return null;
}

async function readPart(client: ImapFlow, uid: number, part: string): Promise<string> {
    const { content } = await client.download(String(uid), part, { uid: true });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of content) {
        size += chunk.length;
        if (size > MAX_PART_BYTES) break;
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf-8");
}

const htmlToText = (html: string) =>
    html
        .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
        .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"');

export const poll = internalAction({
    args: {},
    returns: v.null(),
    handler: async (ctx) => {
        const cfg = mailConfig();
        if (!cfg) return null;
        const domain = mailDomain();
        const client = new ImapFlow({
            host: cfg.imapHost,
            port: 993,
            secure: true,
            auth: { user: cfg.user, pass: cfg.pass },
            logger: false,
        });
        await client.connect();
        try {
            const lock = await client.getMailboxLock("INBOX");
            try {
                const box = client.mailbox;
                if (!box) return null;
                const uidValidity = Number(box.uidValidity);
                const cursor = await ctx.runQuery(internal.bhaiMail.getCursor, {});
                if (!cursor || cursor.uidValidity !== uidValidity) {
                    // First run (or the mailbox was rebuilt): start from now, not the backlog.
                    await ctx.runMutation(internal.bhaiMail.setCursor, {
                        uidValidity,
                        lastUid: Math.max(0, (box.uidNext ?? 1) - 1),
                    });
                    return null;
                }

                // Collect first; imapflow can't run other commands inside a fetch loop.
                const found: Array<{
                    uid: number;
                    to: string;
                    from: string;
                    messageId: string;
                    subject: string;
                    structure: Part;
                }> = [];
                for await (const msg of client.fetch(
                    `${cursor.lastUid + 1}:*`,
                    { uid: true, envelope: true, bodyStructure: true },
                    { uid: true },
                )) {
                    if (msg.uid <= cursor.lastUid) continue; // "N:*" returns the last message when nothing is newer
                    const env = msg.envelope;
                    const to = pickBhaiRecipient(
                        [...(env?.to ?? []), ...(env?.cc ?? [])].map((a) => a.address ?? ""),
                        domain,
                    );
                    found.push({
                        uid: msg.uid,
                        to: to ?? "",
                        from: env?.from?.[0]?.address ?? "",
                        messageId: env?.messageId || `uid-${uidValidity}-${msg.uid}`,
                        subject: env?.subject ?? "",
                        structure: msg.bodyStructure as Part,
                    });
                    if (found.length >= PER_RUN) break;
                }

                const routed: number[] = [];
                let lastUid = cursor.lastUid;
                for (const m of found) {
                    lastUid = Math.max(lastUid, m.uid);
                    if (!m.to) continue; // not Bhai mail: leave it alone
                    const plain = findPart(m.structure, "text/plain");
                    const html = plain ? null : findPart(m.structure, "text/html");
                    const raw = plain
                        ? await readPart(client, m.uid, plain.part || "1")
                        : html
                          ? htmlToText(await readPart(client, m.uid, html.part || "1"))
                          : "";
                    const result = await ctx.runMutation(internal.bhaiMail.routeInbound, {
                        address: m.to,
                        from: m.from,
                        messageId: m.messageId,
                        subject: m.subject,
                        text: stripQuoted(raw) || "(empty email)",
                    });
                    // Bhai mail is copied into its owner's queue (or isn't theirs to read);
                    // either way it doesn't stay in the shared mailbox.
                    if (result !== "unknown") routed.push(m.uid);
                }
                if (routed.length) await client.messageDelete(routed.join(","), { uid: true });
                await ctx.runMutation(internal.bhaiMail.setCursor, { uidValidity, lastUid });
            } finally {
                lock.release();
            }
        } finally {
            await client.logout().catch(() => {});
        }
        return null;
    },
});

export const deliver = internalAction({
    args: {
        replyTo: v.string(),
        to: v.string(),
        subject: v.string(),
        text: v.string(),
        inReplyTo: v.optional(v.string()),
    },
    returns: v.object({ ok: v.boolean(), error: v.optional(v.string()) }),
    handler: async (_ctx, { replyTo, to, subject, text, inReplyTo }) => {
        const cfg = mailConfig();
        if (!cfg) return { ok: false, error: "not_configured" };
        const transport = nodemailer.createTransport({
            host: cfg.smtpHost,
            port: 465,
            secure: true,
            auth: { user: cfg.user, pass: cfg.pass },
        });
        try {
            // Sent as the mailbox itself (what the SMTP login may send as); replies
            // come back to the user's .bhai address through the catch-all.
            await transport.sendMail({
                from: { name: "Bhai", address: cfg.user },
                replyTo,
                to,
                subject,
                text,
                ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
            });
            return { ok: true };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    },
});
