// Server-side helper for talking to the Atlas-mcp (enterprise) Convex
// deployment's admin endpoints. Keeps the MCP admin key strictly on the server.

interface IssueRequest {
  client_name: string;
  contact_email: string;
  plan: "pilot" | "standard" | "enterprise";
  seat_limit: number;
  lifetime_days: number;
}

export interface EnterpriseLicense {
  _id: string;
  clientId: string;
  clientName: string;
  contactEmail: string;
  licenseKey: string;
  status: "active" | "suspended" | "revoked" | "expired";
  seatLimit: number;
  features: string[];
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
  revokedReason?: string;
}

export interface IssuedLicense {
  license_key: string;
  license_id: string;
  client_id: string;
  plan: string;
  seat_limit: number;
  features: string[];
  expires_at: number;
}

function baseUrl(): string {
  const v = process.env.ATLAS_MCP_CONVEX_SITE_URL;
  if (!v || v.length === 0) {
    throw new Error("ATLAS_MCP_CONVEX_SITE_URL env var is required");
  }
  return v;
}

function adminKey(): string {
  const v = process.env.ATLAS_MCP_ADMIN_KEY;
  if (!v || v.length < 32) {
    throw new Error("ATLAS_MCP_ADMIN_KEY env var is required (32+ chars)");
  }
  return v;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function listEnterpriseLicenses(): Promise<EnterpriseLicense[]> {
  const res = await fetch(`${baseUrl()}/v1/admin/license/list`, {
    headers: { "x-admin-key": adminKey() },
    cache: "no-store",
  });
  const body = await jsonOrThrow<{ licenses: EnterpriseLicense[] }>(res);
  return body.licenses;
}

export async function issueEnterpriseLicense(req: IssueRequest): Promise<IssuedLicense> {
  const res = await fetch(`${baseUrl()}/v1/admin/license/issue`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-key": adminKey(),
    },
    body: JSON.stringify(req),
  });
  return await jsonOrThrow<IssuedLicense>(res);
}

export async function revokeEnterpriseLicense(
  licenseKey: string,
  reason: string,
): Promise<{ ok: boolean; revoked_activations: number }> {
  const res = await fetch(`${baseUrl()}/v1/admin/license/revoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-key": adminKey(),
    },
    body: JSON.stringify({ license_key: licenseKey, reason }),
  });
  return await jsonOrThrow<{ ok: boolean; revoked_activations: number }>(res);
}

export interface UsageEntry {
  license_id: string;
  license_key: string;
  client_id: string;
  client_name: string;
  contact_email: string;
  license_status: string;
  seat_limit: number;
  total_calls: number;
  active_days: number;
  last_active_day: string | null;
  top_tools: Array<{ tool_name: string; count: number }>;
}

export interface UsageResponse {
  window_days: number;
  cutoff_day: string;
  usage: UsageEntry[];
}

export async function listEnterpriseUsage(days: number): Promise<UsageResponse> {
  const clamped = Math.max(1, Math.min(365, Math.floor(days)));
  const res = await fetch(`${baseUrl()}/v1/admin/usage?days=${clamped}`, {
    headers: { "x-admin-key": adminKey() },
    cache: "no-store",
  });
  return await jsonOrThrow<UsageResponse>(res);
}
