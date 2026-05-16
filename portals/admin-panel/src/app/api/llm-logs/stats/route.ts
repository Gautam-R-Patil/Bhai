import { NextRequest, NextResponse } from "next/server";
import { adminHttpGet } from "@/lib/convex";
import { guard } from "@/lib/route-guards";

export async function GET(request: NextRequest) {
  const g = await guard(request, { permission: "view_analytics", allowAnyBodySize: true });
  if (!g.ok) return g.response;

  const url = new URL(request.url);
  const sinceMs = url.searchParams.get("sinceMs");
  const qs = sinceMs ? `?sinceMs=${encodeURIComponent(sinceMs)}` : "";

  try {
    const data = await adminHttpGet<unknown>(`/api/admin/llm-logs/stats${qs}`);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
