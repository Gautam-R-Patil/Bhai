// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// "use node"; — required because nodemailer depends on Node built-ins (net, tls, dns).
// Kept in a separate file from convex/waitlist.ts so the queries/mutations
// there stay in Convex's default V8 runtime (mixing the two in one file is
// rejected by Convex per the AI guidelines).

"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import nodemailer from "nodemailer";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const sendNewEntryNotification = internalAction({
  args: { entryId: v.id("waitlist") },
  handler: async (ctx, args) => {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT ?? 465);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    // Fail-quiet: if SMTP isn't configured, log and bail. The waitlist
    // submission itself already succeeded — we don't want the user-facing
    // success UI to depend on the ops-side notification path.
    if (!host || !user || !pass) {
      console.warn(
        "[waitlistMailer] SMTP_HOST/USER/PASS not configured — skipping notification",
      );
      return { sent: false, reason: "smtp_not_configured" };
    }

    const entry = await ctx.runQuery(internal.waitlist.getEntryById, {
      entryId: args.entryId,
    });
    if (!entry) {
      console.warn(`[waitlistMailer] entry ${args.entryId} not found`);
      return { sent: false, reason: "entry_not_found" };
    }

    const toAddress = process.env.WAITLIST_NOTIFY_EMAIL || "hello@xagilab.com";
    const fromAddress = process.env.WAITLIST_NOTIFY_FROM || user;

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });

    const fullName = `${entry.firstName} ${entry.lastName}`.trim();
    const subject = `New ATLAS waitlist signup: ${fullName}`;
    const lines = [
      `Name:       ${fullName}`,
      `Email:      ${entry.email}`,
      `Role:       ${entry.role}`,
      entry.company ? `Company:    ${entry.company}` : null,
      `Use case:   ${entry.useCase}`,
      `Submitted:  ${new Date(entry.submittedAt).toISOString()}`,
      entry.ipAddress ? `IP:         ${entry.ipAddress}` : null,
      entry.referrer ? `Referrer:   ${entry.referrer}` : null,
    ].filter(Boolean);
    const text = lines.join("\n");

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;">
        <h2 style="margin:0 0 16px;font-size:20px;">New ATLAS waitlist signup</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:6px 0;color:#666;width:120px;">Name</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(fullName)}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Email</td><td style="padding:6px 0;"><a href="mailto:${escapeHtml(entry.email)}">${escapeHtml(entry.email)}</a></td></tr>
          <tr><td style="padding:6px 0;color:#666;">Role</td><td style="padding:6px 0;">${escapeHtml(entry.role)}</td></tr>
          ${entry.company ? `<tr><td style="padding:6px 0;color:#666;">Company</td><td style="padding:6px 0;">${escapeHtml(entry.company)}</td></tr>` : ""}
          <tr><td style="padding:6px 0;color:#666;">Use case</td><td style="padding:6px 0;">${escapeHtml(entry.useCase)}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Submitted</td><td style="padding:6px 0;">${escapeHtml(new Date(entry.submittedAt).toLocaleString())}</td></tr>
          ${entry.ipAddress ? `<tr><td style="padding:6px 0;color:#666;">IP</td><td style="padding:6px 0;font-family:monospace;">${escapeHtml(entry.ipAddress)}</td></tr>` : ""}
          ${entry.referrer ? `<tr><td style="padding:6px 0;color:#666;">Referrer</td><td style="padding:6px 0;font-size:12px;">${escapeHtml(entry.referrer)}</td></tr>` : ""}
        </table>
        <p style="margin-top:24px;color:#666;font-size:12px;">Review in the admin panel under Waitlist.</p>
      </div>
    `;

    try {
      await transporter.sendMail({
        from: fromAddress,
        to: toAddress,
        subject,
        text,
        html,
      });
      return { sent: true };
    } catch (err: any) {
      console.error("[waitlistMailer] sendMail failed:", err?.message || err);
      return { sent: false, reason: "send_failed", error: err?.message };
    }
  },
});
