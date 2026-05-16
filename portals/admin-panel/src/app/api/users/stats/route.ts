import { NextRequest, NextResponse } from "next/server";
import { adminHttpGet } from "@/lib/convex";
import { guard } from "@/lib/route-guards";
import type { AccountStats } from "@/lib/types";

export async function GET(request: NextRequest) {
  const g = await guard(request, { permission: "manage_users", allowAnyBodySize: true });
  if (!g.ok) return g.response;

  try {
    const data = await adminHttpGet<AccountStats>("/api/admin/accounts/stats");
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load stats";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
