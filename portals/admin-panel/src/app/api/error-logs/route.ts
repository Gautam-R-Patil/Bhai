import { NextRequest, NextResponse } from "next/server";
import { adminHttpGet } from "@/lib/convex";
import { guard } from "@/lib/route-guards";

export async function GET(request: NextRequest) {
  const g = await guard(request, { permission: "view_analytics", allowAnyBodySize: true });
  if (!g.ok) return g.response;

  const url = new URL(request.url);
  const qs = new URLSearchParams();
  for (const key of ["source", "severity", "sinceMs", "limit", "cursor"]) {
    const v = url.searchParams.get(key);
    if (v) qs.set(key, v);
  }

  try {
    const data = await adminHttpGet<unknown>(
      `/api/admin/error-logs${qs.toString() ? `?${qs.toString()}` : ""}`,
    );
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
