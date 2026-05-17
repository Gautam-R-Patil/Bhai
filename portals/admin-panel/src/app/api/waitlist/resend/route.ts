import { NextRequest, NextResponse } from "next/server";
import { adminHttpPost } from "@/lib/convex";
import { guard } from "@/lib/route-guards";

export async function POST(request: NextRequest) {
  const g = await guard(request, { permission: "manage_users" });
  if (!g.ok) return g.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const data = await adminHttpPost<{ success: boolean; scheduled?: string }>(
      "/api/admin/waitlist/resend",
      body,
    );
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to resend";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
