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
    const data = await adminHttpPost("/api/admin/accounts/delete", body);
    console.log(`[users] ${g.session.email} deleted user`, JSON.stringify(body).slice(0, 200));
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to delete";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
