import { type NextRequest, NextResponse } from "next/server";
import { guard } from "@/lib/route-guards";
import {
  revokeEnterpriseLicense,
  updateEnterpriseLicense,
  type UpdateEnterpriseLicensePatch,
} from "@/lib/mcp-admin";

const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ licenseKey: string }> },
) {
  const g = await guard(request, { permission: "manage_enterprise" });
  if (!g.ok) return g.response;

  const { licenseKey } = await context.params;
  if (typeof licenseKey !== "string" || licenseKey.length < 8 || licenseKey.length > 64) {
    return NextResponse.json({ error: "invalid_license_key" }, { status: 400 });
  }

  let reason = "admin_revoked";
  try {
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    if (typeof body.reason === "string" && body.reason.length > 0 && body.reason.length < 500) {
      reason = body.reason;
    }
  } catch {}

  try {
    const result = await revokeEnterpriseLicense(licenseKey, reason);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to revoke license";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ licenseKey: string }> },
) {
  const g = await guard(request, { permission: "manage_enterprise" });
  if (!g.ok) return g.response;

  const { licenseKey } = await context.params;
  if (typeof licenseKey !== "string" || licenseKey.length < 8 || licenseKey.length > 64) {
    return NextResponse.json({ error: "invalid_license_key" }, { status: 400 });
  }

  let body: {
    client_name?: string;
    contact_email?: string;
    seat_limit?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const patch: UpdateEnterpriseLicensePatch = {};
  if (body.client_name !== undefined) {
    if (
      typeof body.client_name !== "string" ||
      body.client_name.trim().length === 0 ||
      body.client_name.length > 200
    ) {
      return NextResponse.json({ error: "invalid_client_name" }, { status: 400 });
    }
    patch.client_name = body.client_name.trim();
  }
  if (body.contact_email !== undefined) {
    if (typeof body.contact_email !== "string" || !EMAIL_RE.test(body.contact_email)) {
      return NextResponse.json({ error: "invalid_contact_email" }, { status: 400 });
    }
    patch.contact_email = body.contact_email.trim().toLowerCase();
  }
  if (body.seat_limit !== undefined) {
    if (
      !Number.isInteger(body.seat_limit) ||
      body.seat_limit <= 0 ||
      body.seat_limit > 10000
    ) {
      return NextResponse.json({ error: "invalid_seat_limit" }, { status: 400 });
    }
    patch.seat_limit = body.seat_limit;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no_fields_to_update" }, { status: 400 });
  }

  try {
    const result = await updateEnterpriseLicense(licenseKey, patch);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to update license";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
