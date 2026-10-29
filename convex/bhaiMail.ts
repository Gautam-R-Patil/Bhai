// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Bhai's own email address: <name>.bhai@<domain> on a catch-all mailbox
// (Hostinger). bhaiMailNode.ts reads the mailbox every minute and routes mail
// here; each user's Bhai collects its owner's mail through /api/mail/*. Bhai
// only takes mail from its owner's address and only writes to that owner, and
// only after they've emailed it recently, so nobody can send from the domain.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { bhaiAddress, handleFromEmail, MAX_TEXT, mailDomain } from "./bhaiMailHelpers";

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
    args: { address: v.string(), from: v.string(), messageId: v.string(), subject: v.string(), text: v.string() },
    returns: v.union(v.literal("queued"), v.literal("unknown"), v.literal("not_owner"), v.literal("duplicate")),
    handler: async (ctx, { address, from, messageId, subject, text }) => {
        const row = await ctx.db
            .query("bhai_mail_addresses")
            .withIndex("by_address", (q) => q.eq("address", address))
            .first();
        if (!row) return "unknown" as const;
        if (from.toLowerCase() !== row.ownerEmail) return "not_owner" as const;
        const seen = await ctx.db
            .query("bhai_mail_inbox")
            .withIndex("by_messageId", (q) => q.eq("messageId", messageId))
            .first();
        if (seen) return "duplicate" as const;
        await ctx.db.insert("bhai_mail_inbox", {
            otplessUserId: row.otplessUserId,
            messageId,
            subject: subject.slice(0, 300),
            text: text.slice(0, MAX_TEXT),
            receivedAt: Date.now(),
        });
        await ctx.db.patch(row._id, { lastInboundAt: Date.now() });
        return "queued" as const;
    },
});

export const inboxFor = internalQuery({
    args: { otplessUserId: v.string() },
    returns: v.array(
        v.object({
            id: v.string(),
            messageId: v.string(),
            subject: v.string(),
            text: v.string(),
            receivedAt: v.number(),
        }),
    ),
    handler: async (ctx, { otplessUserId }) => {
        const rows = await ctx.db
            .query("bhai_mail_inbox")
            .withIndex("by_otplessUserId", (q) => q.eq("otplessUserId", otplessUserId))
            .take(10);
        return rows.map((r) => ({
            id: r._id,
            messageId: r.messageId,
            subject: r.subject,
            text: r.text,
            receivedAt: r.receivedAt,
        }));
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
