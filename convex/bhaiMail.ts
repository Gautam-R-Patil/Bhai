// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Bhai's own email address: <name>.bhai@<domain> on a catch-all mailbox
// (Hostinger). bhaiMailNode.ts reads the mailbox every minute and routes mail
// here; each user's Bhai collects its mail through /api/mail/*. Anyone can
// email a Bhai; mail from the owner's address is marked so the bot gives the
// owner full Bhai and everyone else guest mode. Sends are capped per day so
// the company domain can't be used to spam.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
    bhaiAddress,
    DAY_MS,
    handleFromEmail,
    MAX_TEXT,
    mailDomain,
    OTHERS_INBOUND_PER_DAY,
    SEND_RECIPIENTS_PER_DAY,
} from "./bhaiMailHelpers";

// ── Addresses ──────────────────────────────────────────────────────────────

export const claimAddress = internalMutation({
    args: { otplessUserId: v.string(), ownerEmail: v.string() },
    returns: v.string(),
    handler: async (ctx, { otplessUserId, ownerEmail }) => {
        const owner = ownerEmail.toLowerCase();
        const mine = await ctx.db
            .query("bhai_mail_addresses")
            .withIndex("by_otplessUserId", (q) => q.eq("otplessUserId", otplessUserId))
            .first();
        if (mine) {
            // A new owner address has to email Bhai before Bhai writes to it.
            if (mine.ownerEmail !== owner) await ctx.db.patch(mine._id, { ownerEmail: owner, lastInboundAt: 0 });
            return mine.address;
        }
        const domain = mailDomain();
        const handle = handleFromEmail(owner);
        for (let n = 1; n < 1000; n++) {
            const address = bhaiAddress(handle, n, domain);
            const taken = await ctx.db
                .query("bhai_mail_addresses")
                .withIndex("by_address", (q) => q.eq("address", address))
                .first();
            if (!taken) {
                await ctx.db.insert("bhai_mail_addresses", {
                    otplessUserId,
                    address,
                    ownerEmail: owner,
                    lastInboundAt: 0,
                });
                return address;
            }
        }
        throw new Error("No free address");
    },
});

export const addressFor = internalQuery({
    args: { otplessUserId: v.string() },
    returns: v.union(v.null(), v.object({ address: v.string(), ownerEmail: v.string(), lastInboundAt: v.number() })),
    handler: async (ctx, { otplessUserId }) => {
        const row = await ctx.db
            .query("bhai_mail_addresses")
            .withIndex("by_otplessUserId", (q) => q.eq("otplessUserId", otplessUserId))
            .first();
        return row ? { address: row.address, ownerEmail: row.ownerEmail, lastInboundAt: row.lastInboundAt } : null;
    },
});

// ── Inbound ────────────────────────────────────────────────────────────────

export const routeInbound = internalMutation({
    args: {
        address: v.string(),
        from: v.string(),
        fromName: v.string(),
        messageId: v.string(),
        subject: v.string(),
        text: v.string(),
        automated: v.boolean(),
        /** The receiving server verified From (aligned SPF/DKIM/DMARC pass). */
        authenticated: v.optional(v.boolean()),
    },
    returns: v.union(v.literal("queued"), v.literal("unknown"), v.literal("over_cap"), v.literal("duplicate")),
    handler: async (ctx, { address, from, fromName, messageId, subject, text, automated, authenticated }) => {
        const row = await ctx.db
            .query("bhai_mail_addresses")
            .withIndex("by_address", (q) => q.eq("address", address))
            .first();
        if (!row) return "unknown" as const;
        const seen = await ctx.db
            .query("bhai_mail_inbox")
            .withIndex("by_messageId", (q) => q.eq("messageId", messageId))
            .first();
        if (seen) return "duplicate" as const;
        const claimsOwner = from.toLowerCase() === row.ownerEmail;
        const fromOwner = claimsOwner && authenticated === true;
        // Unverified mail claiming to be the owner: never owner Bhai, and no guest reply
        // either (it would go to the owner's real address). Announced, never answered.
        if (claimsOwner && !fromOwner) automated = true;
        if (fromOwner) {
            await ctx.db.patch(row._id, { lastInboundAt: Date.now() });
        } else if (!automated) {
            // Strangers each cost the owner an agent run: cap them per day.
            const day = new Date().toISOString().slice(0, 10);
            const count = row.othersDay === day ? (row.othersCount ?? 0) : 0;
            if (count >= OTHERS_INBOUND_PER_DAY) return "over_cap" as const;
            await ctx.db.patch(row._id, { othersDay: day, othersCount: count + 1 });
        }
        await ctx.db.insert("bhai_mail_inbox", {
            otplessUserId: row.otplessUserId,
            messageId,
            from: from.toLowerCase(),
            fromName: fromName.slice(0, 120),
            fromOwner,
            automated,
            subject: subject.slice(0, 300),
            text: text.slice(0, MAX_TEXT),
            receivedAt: Date.now(),
        });
        return "queued" as const;
    },
});

const inboxItem = v.object({
    id: v.string(),
    messageId: v.string(),
    from: v.string(),
    fromName: v.string(),
    fromOwner: v.boolean(),
    automated: v.boolean(),
    subject: v.string(),
    text: v.string(),
    receivedAt: v.number(),
});

export const inboxFor = internalQuery({
    args: { otplessUserId: v.string() },
    returns: v.array(inboxItem),
    handler: async (ctx, { otplessUserId }) => {
        const rows = await ctx.db
            .query("bhai_mail_inbox")
            .withIndex("by_otplessUserId", (q) => q.eq("otplessUserId", otplessUserId))
            .take(10);
        return rows.map((r) => ({
            id: r._id,
            messageId: r.messageId,
            from: r.from ?? "",
            fromName: r.fromName ?? "",
            fromOwner: r.fromOwner ?? false,
            automated: r.automated ?? false,
            subject: r.subject,
            text: r.text,
            receivedAt: r.receivedAt,
        }));
    },
});

// Daily recipient cap: true (and recorded) if this send fits.
export const reserveSend = internalMutation({
    args: { otplessUserId: v.string(), recipients: v.number() },
    returns: v.boolean(),
    handler: async (ctx, { otplessUserId, recipients }) => {
        const since = Date.now() - DAY_MS;
        const recent = await ctx.db
            .query("bhai_mail_sends")
            .withIndex("by_otplessUserId_and_at", (q) => q.eq("otplessUserId", otplessUserId).gt("at", since))
            .take(SEND_RECIPIENTS_PER_DAY + 1);
        const used = recent.reduce((n, r) => n + r.recipients, 0);
        if (used + recipients > SEND_RECIPIENTS_PER_DAY) return false;
        await ctx.db.insert("bhai_mail_sends", { otplessUserId, at: Date.now(), recipients });
        return true;
    },
});

export const ack = internalMutation({
    args: { otplessUserId: v.string(), ids: v.array(v.string()) },
    returns: v.null(),
    handler: async (ctx, { otplessUserId, ids }) => {
        for (const raw of ids.slice(0, 50)) {
            const id = ctx.db.normalizeId("bhai_mail_inbox", raw);
            if (!id) continue;
            const row = await ctx.db.get(id);
            if (row && row.otplessUserId === otplessUserId) await ctx.db.delete(id);
        }
        return null;
    },
});

// ── IMAP position (one row) ────────────────────────────────────────────────

export const getCursor = internalQuery({
    args: {},
    returns: v.union(v.null(), v.object({ uidValidity: v.number(), lastUid: v.number() })),
    handler: async (ctx) => {
        const row = await ctx.db
            .query("bhai_mail_cursor")
            .withIndex("by_name", (q) => q.eq("name", "inbox"))
            .first();
        return row ? { uidValidity: row.uidValidity, lastUid: row.lastUid } : null;
    },
});

export const setCursor = internalMutation({
    args: { uidValidity: v.number(), lastUid: v.number() },
    returns: v.null(),
    handler: async (ctx, { uidValidity, lastUid }) => {
        const row = await ctx.db
            .query("bhai_mail_cursor")
            .withIndex("by_name", (q) => q.eq("name", "inbox"))
            .first();
        if (row) await ctx.db.patch(row._id, { uidValidity, lastUid });
        else await ctx.db.insert("bhai_mail_cursor", { name: "inbox", uidValidity, lastUid });
        return null;
    },
});
