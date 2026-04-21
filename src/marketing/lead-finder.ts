// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { getMemoryDB } from "../memory/sqlite.js";

export interface Lead {
  firstName: string;
  lastName: string;
  email?: string;
  emailStatus?: "valid" | "unverified" | "invalid";
  title?: string;
  company?: string;
  linkedinUrl?: string;
  phone?: string;
}

export interface LeadSearchParams {
  titles?: string[];
  industries?: string[];
  companySizeMin?: number;
  companySizeMax?: number;
  domains?: string[];
  limit?: number;
}

// ── Apollo.io ─────────────────────────────────

export async function findLeadsApollo(params: LeadSearchParams): Promise<Lead[]> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) throw new Error("APOLLO_API_KEY not set");

  const body: Record<string, unknown> = {
    api_key: apiKey,
    per_page: Math.min(params.limit ?? 25, 100),
    page: 1,
  };
  if (params.titles?.length) body.person_titles = params.titles;
  if (params.industries?.length) body.organization_industry_tag_ids = params.industries;
  if (params.companySizeMin) {
    body.organization_num_employees_ranges = [
      `${params.companySizeMin},${params.companySizeMax ?? 10000}`,
    ];
  }
  if (params.domains?.length) body.q_organization_domains = params.domains.join("\n");

  const res = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apollo API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { people?: Record<string, unknown>[] };
  return (data.people ?? []).map((p) => ({
    firstName: (p.first_name as string) ?? "",
    lastName: (p.last_name as string) ?? "",
    email: (p.email as string) ?? undefined,
    emailStatus: mapApolloEmailStatus(p.email_status as string),
    title: (p.title as string) ?? undefined,
    company: ((p.organization as Record<string, unknown> | undefined)?.name as string) ?? undefined,
    linkedinUrl: (p.linkedin_url as string) ?? undefined,
    phone: (p.sanitized_phone as string) ?? undefined,
  }));
}

function mapApolloEmailStatus(status: string): Lead["emailStatus"] {
  if (status === "verified") return "valid";
  if (status === "invalid" || status === "bounced") return "invalid";
  return "unverified";
}

// ── Hunter.io ─────────────────────────────────

export async function findEmailHunter(
  domain: string,
  firstName: string,
  lastName: string
): Promise<{ email: string; confidence: number } | null> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) throw new Error("HUNTER_API_KEY not set");

  const url = new URL("https://api.hunter.io/v2/email-finder");
  url.searchParams.set("domain", domain);
  url.searchParams.set("first_name", firstName);
  url.searchParams.set("last_name", lastName);
  url.searchParams.set("api_key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) return null;

  const data = (await res.json()) as { data?: { email?: string; score?: number } };
  const email = data.data?.email;
  const confidence = data.data?.score ?? 0;
  if (!email) return null;
  return { email, confidence };
}

export async function verifyEmailHunter(
  email: string
): Promise<"valid" | "invalid" | "unknown"> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) throw new Error("HUNTER_API_KEY not set");

  const url = new URL("https://api.hunter.io/v2/email-verifier");
  url.searchParams.set("email", email);
  url.searchParams.set("api_key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) return "unknown";

  const data = (await res.json()) as { data?: { status?: string } };
  const status = data.data?.status;
  if (status === "valid") return "valid";
  if (status === "invalid") return "invalid";
  return "unknown";
}

// ── Outreach tracker ──────────────────────────

export function recordOutreach(
  brandId: string,
  lead: Lead,
  channel: string,
  subject: string,
  body: string
): number {
  const db = getMemoryDB();
  db.run(
    `INSERT INTO marketing_outreach (brand_id, channel, target_name, target_contact, subject, body, status, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, 'sent', datetime('now'))`,
    [
      brandId,
      channel,
      `${lead.firstName} ${lead.lastName}`,
      lead.email ?? lead.linkedinUrl ?? "",
      subject,
      body,
    ]
  );
  const rows = db.exec("SELECT last_insert_rowid() as id");
  return Number(rows[0]?.values[0]?.[0] ?? 0);
}
