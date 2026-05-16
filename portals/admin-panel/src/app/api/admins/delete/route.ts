// Delete an admin. Refuses to delete the caller's own account. The
// "cannot delete the last super_admin" guarantee is enforced inside the
// Convex mutation (`store/admins:deleteAdmin`) where it's a single
// transaction — a Next.js pre-check would have a TOCTOU race window.

import { NextRequest, NextResponse } from "next/server";
import { adminStoreMutation } from "@/lib/convex";
import { guard } from "@/lib/route-guards";

export async function POST(request: NextRequest) {
  const g = await guard(request, { permission: "manage_admins", maxBodyBytes: 4096 });
  if (!g.ok) return g.response;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const adminId = typeof body?.adminId === "string" ? body.adminId : "";
  if (!adminId) {
    return NextResponse.json({ error: "adminId is required" }, { status: 400 });
  }

  // Refuse to delete self — a panel can't recover from "I just deleted my
  // own row" without CLI access.
  if (adminId === g.session.adminId) {
    return NextResponse.json({ error: "Cannot delete your own admin account" }, { status: 400 });
  }

  try {
    await adminStoreMutation("store/admins:deleteAdmin", { adminId });
    console.log(`[admins] ${g.session.email} deleted adminId=${adminId}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Delete failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
