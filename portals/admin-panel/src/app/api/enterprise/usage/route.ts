import { type NextRequest, NextResponse } from "next/server";
import { guard } from "@/lib/route-guards";
import { listEnterpriseUsage } from "@/lib/mcp-admin";

export async function GET(request: NextRequest) {
  const g = await guard(request, { permission: "manage_enterprise", allowAnyBodySize: true });
  if (!g.ok) return g.response;

  const url = new URL(request.url);
  const daysRaw = url.searchParams.get("days");
  let days = 30;
  if (daysRaw !== null) {
    const n = Number(daysRaw);
    if (!Number.isFinite(n) || n <= 0 || n > 365) {
      return NextResponse.json({ error: "invalid_days" }, { status: 400 });
    }
    days = Math.floor(n);
  }

  try {
    const data = await listEnterpriseUsage(days);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load usage";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
