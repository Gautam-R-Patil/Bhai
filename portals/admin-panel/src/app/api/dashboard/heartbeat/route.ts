import { NextRequest, NextResponse } from "next/server";
import { adminHttpGet } from "@/lib/convex";
import { guard } from "@/lib/route-guards";

export interface DashboardHeartbeat {
  now: number;
  health: "healthy" | "idle" | "stale";
  errorCount: number;
  lastErrorAt: number | null;
  lastLlmCallAt: number | null;
  totalLlmCalls: number;
}

export async function GET(request: NextRequest) {
  const g = await guard(request, { allowAnyBodySize: true });
  if (!g.ok) return g.response;

  try {
    const { data } = await adminHttpGet<{ data: DashboardHeartbeat }>(
      "/api/admin/observability/heartbeat",
    );
    return NextResponse.json({ data, fetchedAt: Date.now() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Heartbeat failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
