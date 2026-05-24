import { type NextRequest, NextResponse } from "next/server";
import { guard } from "@/lib/route-guards";
import { rotateEnterpriseLicenseKey } from "@/lib/mcp-admin";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ licenseKey: string }> },
) {
  const g = await guard(request, { permission: "manage_enterprise" });
  if (!g.ok) return g.response;

  const { licenseKey } = await context.params;
  if (typeof licenseKey !== "string" || licenseKey.length < 8 || licenseKey.length > 64) {
    return NextResponse.json({ error: "invalid_license_key" }, { status: 400 });
  }

  let revokeActivations = false;
  try {
    const body = (await request.json().catch(() => ({}))) as { revoke_activations?: boolean };
    if (typeof body.revoke_activations === "boolean") {
      revokeActivations = body.revoke_activations;
    }
  } catch {}

  try {
    const result = await rotateEnterpriseLicenseKey(licenseKey, revokeActivations);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to rotate license key";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
