import { type NextRequest, NextResponse } from "next/server";
import { guard } from "@/lib/route-guards";
import { revokeEnterpriseLicense } from "@/lib/mcp-admin";

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
