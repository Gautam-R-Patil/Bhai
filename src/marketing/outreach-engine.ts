// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import nodemailer from "nodemailer";
import type { LLMClient } from "../llm.js";
import { findLeadsApollo, recordOutreach, type Lead, type LeadSearchParams } from "./lead-finder.js";
import { deliverToActiveChannel } from "../tools/channel-send.js";

let _llm: LLMClient | null = null;
export function setOutreachLLM(llm: LLMClient): void { _llm = llm; }

export interface OutreachRequest {
  brandId: string;
  channel: "email" | "linkedin" | "twitter";
  targetDescription: string;
  messageTemplate: string;
  maxLeads: number;
}

export interface OutreachResult {
  channel: string;
  status: "sent" | "waiting_user_choice" | "error";
  sentCount?: number;
  message?: string;
  options?: string[];
}

const LINKEDIN_OPTIONS = [
  "A — Automated via PhantomBuster: I send connection requests + follow-up DMs automatically. Fastest results, ~5-15% monthly account ban risk.",
  "B — Posts only (safe): I post engaging content to attract inbound leads. Zero ban risk. Results build over 2-4 weeks.",
  "C — Semi-automated: I write the messages and find the targets, then send you the list here for you to send manually. Safe, requires your time.",
];

export async function runOutreachCampaign(req: OutreachRequest): Promise<OutreachResult> {
  if (req.channel === "linkedin") {
    const msg = [
      "**LinkedIn Outreach — Choose your approach:**",
      "",
      ...LINKEDIN_OPTIONS.map((o) => `• ${o}`),
      "",
      "Reply: `linkedin A`, `linkedin B`, or `linkedin C`",
    ].join("\n");
    await deliverToActiveChannel(msg, "");
    return { channel: "linkedin", status: "waiting_user_choice", options: LINKEDIN_OPTIONS };
  }

  if (req.channel === "email") {
    return runEmailOutreach(req);
  }

  return { channel: req.channel, status: "error", message: `Twitter DM outreach requires Pro API tier ($100/mo). Set X_API_TIER_${req.brandId}=pro to enable.` };
}

async function runEmailOutreach(req: OutreachRequest): Promise<OutreachResult> {
  const emailUser = process.env.EMAIL_USER;
  const emailPass = process.env.EMAIL_PASSWORD;
  if (!emailUser || !emailPass) {
    return { channel: "email", status: "error", message: "EMAIL_USER or EMAIL_PASSWORD not set" };
  }

  const searchParams = parseTargetDescription(req.targetDescription, req.maxLeads);
  let leads: Lead[] = [];
  try {
    leads = await findLeadsApollo(searchParams);
  } catch (err) {
    return { channel: "email", status: "error", message: `Lead finder failed: ${(err as Error).message}` };
  }
  if (!leads.length) {
    return { channel: "email", status: "error", message: "No leads found matching criteria" };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST ?? "smtp.hostinger.com",
    port: Number(process.env.EMAIL_PORT ?? 465),
    secure: true,
    auth: { user: emailUser, pass: emailPass },
  });

  let sentCount = 0;
  for (const lead of leads.filter((l) => l.email && l.emailStatus !== "invalid")) {
    const personalised = await personaliseMessage(req.messageTemplate, lead);
    const subject = extractSubject(personalised);
    const body = personalised.replace(/^Subject:.*\n?/im, "").trim();

    try {
      await transporter.sendMail({ from: emailUser, to: lead.email!, subject, text: body });
      recordOutreach(req.brandId, lead, "email", subject, body);
      sentCount++;
      await new Promise((r) => setTimeout(r, 2000));
    } catch { /* skip failed sends */ }
  }

  return { channel: "email", status: "sent", sentCount, message: `Sent ${sentCount} personalised emails` };
}

async function personaliseMessage(template: string, lead: Lead): Promise<string> {
  const filled = template
    .replace(/\{\{name\}\}/gi, lead.firstName)
    .replace(/\{\{company\}\}/gi, lead.company ?? "your company")
    .replace(/\{\{title\}\}/gi, lead.title ?? "");

  if (!_llm) return filled;

  try {
    const response = await _llm.chat({
      messages: [
        {
          role: "user",
          content: `Personalise this cold email for ${lead.firstName} ${lead.lastName} (${lead.title ?? "professional"} at ${lead.company ?? "their company"}). Make it sound genuine and specific, not generic. Keep roughly the same length. Return only the email, no explanation.\n\n${filled}`,
        },
      ],
    });
    return response.choices[0]?.message?.content ?? filled;
  } catch {
    return filled;
  }
}

function extractSubject(message: string): string {
  const match = message.match(/^Subject:\s*(.+)$/mi);
  return match?.[1]?.trim() ?? "Quick question";
}

function parseTargetDescription(description: string, limit: number): LeadSearchParams {
  const lower = description.toLowerCase();
  const titles: string[] = [];
  const industries: string[] = [];

  if (lower.includes("cto") || lower.includes("technical")) titles.push("CTO", "VP Engineering");
  if (lower.includes("ceo") || lower.includes("founder")) titles.push("CEO", "Co-founder", "Founder");
  if (lower.includes("marketing")) titles.push("CMO", "VP Marketing", "Marketing Director");
  if (lower.includes("product")) titles.push("CPO", "VP Product", "Product Manager");
  if (lower.includes("saas") || lower.includes("software")) industries.push("SaaS");
  if (lower.includes("fintech") || lower.includes("finance")) industries.push("FinTech");
  if (lower.includes("ecommerce") || lower.includes("retail")) industries.push("eCommerce");

  return { titles: titles.length ? titles : undefined, industries: industries.length ? industries : undefined, limit };
}
