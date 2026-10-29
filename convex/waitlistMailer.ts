// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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

// nodemailer/SMTP error strings can echo back the AUTH PLAIN payload or the
// password itself ("535 5.7.8 ... <password>"). Scrub before storing into the
// waitlist row (which is surfaced in the admin UI on failure).
function sanitizeSmtpError(message: string): string {
  let out = message;
  const pass = process.env.SMTP_PASS;
  const user = process.env.SMTP_USER;
  if (pass && pass.length > 2) out = out.split(pass).join("***");
  if (user && user.length > 2) out = out.split(user).join("<smtp-user>");
  // Strip base64 AUTH PLAIN blobs (>=16 chars of base64 after "AUTH PLAIN ").
  out = out.replace(/AUTH\s+PLAIN\s+[A-Za-z0-9+/=]{16,}/gi, "AUTH PLAIN ***");
  out = out.replace(/AUTH\s+LOGIN\s+[A-Za-z0-9+/=]{16,}/gi, "AUTH LOGIN ***");
  return out.slice(0, 500);
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
    // Derive the visible-domain (e.g. "xagilab.com") so headers we generate
    // identify the message as originating from the brand, not the SMTP relay.
    // Without this, mail clients fall back to the SMTP server's hostname
    // for things like the auto-Message-ID, which is why receivers show
    // "via <relay>" tags in the sender line.
    const fromDomain = (fromAddress.split("@")[1] || "xagilab.com").trim();

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      // Force the EHLO/HELO greeting to match the From-domain so SMTP
      // banners don't expose the underlying relay hostname.
      name: fromDomain,
    });

    const fullName = `${entry.firstName} ${entry.lastName}`.trim();
    const subject = `New Bhai waitlist signup: ${fullName}`;
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
        <h2 style="margin:0 0 16px;font-size:20px;">New Bhai waitlist signup</h2>
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

    // Custom Message-ID so the header reads <random@xagilab.com>, not the
    // relay's default <random@smtp.xxx.com>. Also pin the envelope sender
    // (Return-Path) to the From-address so receiving clients don't see
    // "<smtp-relay-domain> sent on behalf of" tags.
    const messageId = `<waitlist-${args.entryId}-${Date.now()}@${fromDomain}>`;

    try {
      await transporter.sendMail({
        from: { name: "XAGI Labs", address: fromAddress },
        to: toAddress,
        replyTo: fromAddress,
        sender: fromAddress,
        envelope: { from: fromAddress, to: toAddress },
        messageId,
        subject,
        text,
        html,
        headers: {
          "X-Mailer": "Bhai",
        },
      });
      return { sent: true };
    } catch (err: any) {
      console.error("[waitlistMailer] sendMail failed:", err?.message || err);
      return { sent: false, reason: "send_failed", error: err?.message };
    }
  },
});

// Triggered when an admin flips a waitlist entry to "accepted" via the panel.
// Sends the alpha-access invitation directly to the applicant's address.
export const sendAcceptanceEmail = internalAction({
  args: { entryId: v.id("waitlist") },
  handler: async (ctx, args) => {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT ?? 465);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) {
      console.warn(
        "[waitlistMailer] SMTP not configured — skipping acceptance email",
      );
      await ctx.runMutation(internal.waitlist.recordEmailOutcome, {
        entryId: args.entryId,
        kind: "accepted",
        status: "failed",
        error: "SMTP not configured on Convex deployment",
      });
      return { sent: false, reason: "smtp_not_configured" };
    }

    const entry = await ctx.runQuery(internal.waitlist.getEntryById, {
      entryId: args.entryId,
    });
    if (!entry) {
      console.warn(`[waitlistMailer] entry ${args.entryId} not found`);
      return { sent: false, reason: "entry_not_found" };
    }

    const fromAddress = process.env.WAITLIST_NOTIFY_FROM || user;
    const fromDomain = (fromAddress.split("@")[1] || "xagilab.com").trim();

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      name: fromDomain,
    });

    const subject = "Welcome to Bhai Alpha Testing – You’re In!";

    const html = `<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;background:#f3f4f6;">
  <tbody>
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="border-radius:14px; overflow:hidden; background:#ffffff; box-shadow:0 10px 30px rgba(0,0,0,0.25);">
          <tbody>
            <tr>
              <td style="padding:30px; text-align:center; background:linear-gradient(135deg,#6366f1,#ec4899,#22c55e); color:#ffffff;">
                <h1 style="margin:0; font-size:26px; letter-spacing:2px;">Bhai</h1>
                <p style="margin:6px 0 0; font-size:14px; opacity:0.9;">Alpha Access Invitation</p>
              </td>
            </tr>
            <tr>
              <td style="padding:35px; color:#111827; font-size:15px; line-height:1.7;">
                <p><b>Congratulations.</b></p>
                <p>You have been selected to be part of a <b>small, exclusive alpha testing group</b> for Bhai by XAGI Labs &mdash; a platform built to redefine how humans interact with intelligence itself.</p>
                <p><b>Bhai is the world’s first AGI experience platform.</b><br>This is not just another tool or interface, but a new way of engaging with intelligence &mdash; one that moves beyond commands and responses into true interaction, adaptation, and understanding.</p>
                <p>As an early tester, you are among a very limited group gaining access to something fundamentally new.</p>
                <p>If you are interested in participating, please reply to this email confirming your interest. Along with your confirmation, kindly share:</p>
                <ul style="padding-left:20px;">
                  <li>Your Operating System</li>
                  <li>Your OS Version (if available)</li>
                </ul>
                <p>Selected participants will receive a <b>complimentary Pro account</b> along with <b>250 AI credits</b> to explore Bhai and experience its capabilities firsthand.</p>
                <p>A follow-up email will include access details, usage instructions, and program guidelines, along with a feedback form for reporting issues and sharing insights.</p>
                <p>For every valid issue or feedback submission, you will receive <b>10 additional AI credits</b>.<br>After 10 successful submissions, you will receive a <b>bonus of 100 AI credits</b>.</p>
                <p style="margin-top:20px; font-weight:bold;">You are not just testing a product.<br>You are stepping into the earliest version of what comes next.</p>
                <p style="margin-top:25px;">For any queries, contact us at <a href="mailto:hello@xagilab.com" style="color:#2563eb; text-decoration:none;">hello@xagilab.com</a>.</p>
                <p style="margin-top:20px;">Welcome to Bhai.</p>
                <p>Best regards,<br><b>XAGI Labs Private Limited</b></p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px; font-size:11px; line-height:1.6; color:#6b7280; background:#f9fafb;">
                <b>Confidentiality Notice:</b><br>
                This email and any attachments are intended solely for the addressed recipient and may contain confidential, proprietary, or sensitive information belonging to XAGI Labs Private Limited. If you are not the intended recipient, you are hereby notified that any review, dissemination, distribution, copying, or use of this communication is strictly prohibited.<br><br>
                If you have received this email in error, please notify the sender immediately and delete this email from your system. Unauthorized use or disclosure of the contents may be unlawful.<br><br>
                &copy; XAGI Labs Private Limited. All rights reserved.
              </td>
            </tr>
          </tbody>
        </table>
      </td>
    </tr>
  </tbody>
</table>`;

    const text = [
      "Congratulations.",
      "",
      "You have been selected to be part of a small, exclusive alpha testing group for Bhai by XAGI Labs.",
      "",
      "Bhai is the world’s first AGI experience platform.",
      "",
      "If you are interested in participating, please reply to this email confirming your interest. Along with your confirmation, kindly share:",
      "  - Your Operating System",
      "  - Your OS Version (if available)",
      "",
      "Selected participants will receive a complimentary Pro account along with 250 AI credits.",
      "",
      "For every valid issue or feedback submission, you will receive 10 additional AI credits. After 10 successful submissions, you will receive a bonus of 100 AI credits.",
      "",
      "Welcome to Bhai.",
      "",
      "Best regards,",
      "XAGI Labs Private Limited",
      "hello@xagilab.com",
    ].join("\n");

    const messageId = `<accept-${args.entryId}-${Date.now()}@${fromDomain}>`;

    try {
      await transporter.sendMail({
        from: { name: "XAGI Labs", address: fromAddress },
        to: entry.email,
        replyTo: fromAddress,
        sender: fromAddress,
        envelope: { from: fromAddress, to: entry.email },
        messageId,
        subject,
        text,
        html,
        headers: {
          "X-Mailer": "Bhai",
        },
      });
      console.log(`[waitlistMailer] acceptance email sent to ${entry.email}`);
      await ctx.runMutation(internal.waitlist.recordEmailOutcome, {
        entryId: args.entryId,
        kind: "accepted",
        status: "sent",
      });
      return { sent: true };
    } catch (err: any) {
      console.error("[waitlistMailer] acceptance sendMail failed:", err?.message || err);
      await ctx.runMutation(internal.waitlist.recordEmailOutcome, {
        entryId: args.entryId,
        kind: "accepted",
        status: "failed",
        error: sanitizeSmtpError(String(err?.message || err)),
      });
      return { sent: false, reason: "send_failed", error: err?.message };
    }
  },
});

// Triggered when an admin flips a waitlist entry to "contacted" via the panel.
// Sends the 1:1 walkthrough booking invite to the applicant's address.
export const sendContactedEmail = internalAction({
  args: { entryId: v.id("waitlist") },
  handler: async (ctx, args) => {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT ?? 465);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) {
      console.warn(
        "[waitlistMailer] SMTP not configured — skipping contacted email",
      );
      await ctx.runMutation(internal.waitlist.recordEmailOutcome, {
        entryId: args.entryId,
        kind: "contacted",
        status: "failed",
        error: "SMTP not configured on Convex deployment",
      });
      return { sent: false, reason: "smtp_not_configured" };
    }

    const entry = await ctx.runQuery(internal.waitlist.getEntryById, {
      entryId: args.entryId,
    });
    if (!entry) {
      console.warn(`[waitlistMailer] entry ${args.entryId} not found`);
      return { sent: false, reason: "entry_not_found" };
    }

    const fromAddress = process.env.WAITLIST_NOTIFY_FROM || user;
    const fromDomain = (fromAddress.split("@")[1] || "xagilab.com").trim();

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      name: fromDomain,
    });

    const subject = "Important Update: Book Your 1:1 Session for Bhai Alpha";

    const html = `<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;background:#f3f4f6;">
  <tbody>
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="border-radius:14px; overflow:hidden; background:#ffffff; box-shadow:0 10px 30px rgba(0,0,0,0.25);">
          <tbody>
            <tr>
              <td style="padding:30px; text-align:center; background:linear-gradient(135deg,#6366f1,#ec4899,#22c55e); color:#ffffff;">
                <h1 style="margin:0; font-size:26px; letter-spacing:2px;">Bhai</h1>
                <p style="margin:6px 0 0; font-size:14px; opacity:0.9;">Alpha Walkthrough Session</p>
              </td>
            </tr>
            <tr>
              <td style="padding:35px; color:#111827; font-size:15px; line-height:1.7;">
                <p><b>Hey,</b></p>
                <p>Welcome to the next step of your Bhai alpha access.</p>
                <p>As part of the onboarding process, we are inviting you to a <b>one-on-one Google Meet session directly with the founders of XAGI Labs</b>.</p>
                <p>This session is designed to give you a complete walkthrough of Bhai, including:</p>
                <ul style="padding-left:20px;">
                  <li>How to set up the platform</li>
                  <li>How to use its core capabilities effectively</li>
                  <li>How to report issues and provide feedback</li>
                  <li>Best practices to get the most out of your access</li>
                </ul>
                <p>This is a personalized session to ensure you have a smooth and powerful start with Bhai.</p>
                <table cellpadding="0" cellspacing="0" style="margin:25px 0;">
                  <tbody>
                    <tr>
                      <td align="center">
                        <a href="https://cal.id/xagilabs/product-walkthrough" style="background:linear-gradient(135deg,#6366f1,#ec4899); color:#ffffff; padding:14px 24px; text-decoration:none; border-radius:8px; font-weight:bold; display:inline-block;">Book Your Time Slot</a>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p>Once you book your slot, you will receive the meeting details automatically.</p>
                <p>We look forward to having you on this journey and helping you experience Bhai the way it was meant to be.</p>
                <p style="margin-top:20px;">Best regards,<br><b><a href="https://xagilab.com/" rel="noopener noreferrer" style="color:#000000; text-decoration:underline;">XAGI Labs Private Limited</a></b></p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px; font-size:11px; line-height:1.6; color:#6b7280; background:#f9fafb;">
                <b>Confidentiality Notice:</b><br>
                This email and any attachments are intended solely for the addressed recipient and may contain confidential, proprietary, or sensitive information belonging to XAGI Labs Private Limited. If you are not the intended recipient, you are hereby notified that any review, dissemination, distribution, copying, or use of this communication is strictly prohibited.<br><br>
                If you have received this email in error, please notify the sender immediately and delete this email from your system. Unauthorized use or disclosure of the contents may be unlawful.<br><br>
                &copy; XAGI Labs Private Limited. All rights reserved.
              </td>
            </tr>
          </tbody>
        </table>
      </td>
    </tr>
  </tbody>
</table>`;

    const text = [
      "Hey,",
      "",
      "Welcome to the next step of your Bhai alpha access.",
      "",
      "As part of the onboarding process, we are inviting you to a one-on-one Google Meet session directly with the founders of XAGI Labs.",
      "",
      "This session will cover:",
      "  - How to set up the platform",
      "  - How to use its core capabilities effectively",
      "  - How to report issues and provide feedback",
      "  - Best practices to get the most out of your access",
      "",
      "Book your slot here: https://cal.id/xagilabs/product-walkthrough",
      "",
      "Once you book your slot, you will receive the meeting details automatically.",
      "",
      "Best regards,",
      "XAGI Labs Private Limited",
      "https://xagilab.com/",
    ].join("\n");

    const messageId = `<contacted-${args.entryId}-${Date.now()}@${fromDomain}>`;

    try {
      await transporter.sendMail({
        from: { name: "XAGI Labs", address: fromAddress },
        to: entry.email,
        replyTo: fromAddress,
        sender: fromAddress,
        envelope: { from: fromAddress, to: entry.email },
        messageId,
        subject,
        text,
        html,
        headers: {
          "X-Mailer": "Bhai",
        },
      });
      console.log(`[waitlistMailer] contacted email sent to ${entry.email}`);
      await ctx.runMutation(internal.waitlist.recordEmailOutcome, {
        entryId: args.entryId,
        kind: "contacted",
        status: "sent",
      });
      return { sent: true };
    } catch (err: any) {
      console.error("[waitlistMailer] contacted sendMail failed:", err?.message || err);
      await ctx.runMutation(internal.waitlist.recordEmailOutcome, {
        entryId: args.entryId,
        kind: "contacted",
        status: "failed",
        error: sanitizeSmtpError(String(err?.message || err)),
      });
      return { sent: false, reason: "send_failed", error: err?.message };
    }
  },
});
