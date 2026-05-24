import { NextRequest, NextResponse } from "next/server";
import { adminHttpGet } from "@/lib/convex";
import { guard } from "@/lib/route-guards";
import type { ContactListResponse } from "@/lib/types";

export async function GET(request: NextRequest) {
  const g = await guard(request, { permission: "manage_users", allowAnyBodySize: true });
  if (!g.ok) return g.response;

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const inquiry = url.searchParams.get("inquiry");
  const limit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");

  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (inquiry) qs.set("inquiry", inquiry);
  if (limit) qs.set("limit", limit);
  if (cursor) qs.set("cursor", cursor);

  try {
    const data = await adminHttpGet<ContactListResponse>(
      `/api/admin/contact${qs.toString() ? `?${qs.toString()}` : ""}`,
    );
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
