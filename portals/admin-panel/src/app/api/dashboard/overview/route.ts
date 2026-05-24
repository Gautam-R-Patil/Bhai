import { NextRequest, NextResponse } from "next/server";
import { adminHttpGet } from "@/lib/convex";
import { guard } from "@/lib/route-guards";
import type { SystemOverview } from "@/lib/types";

export async function GET(request: NextRequest) {
  const g = await guard(request, { allowAnyBodySize: true });
  if (!g.ok) return g.response;

  try {
    const { data } = await adminHttpGet<{ data: SystemOverview }>(
      "/api/admin/observability/system-overview",
    );
    return NextResponse.json({ data, fetchedAt: Date.now() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load overview";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
