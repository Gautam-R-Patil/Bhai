// Return the current admin session (sans secrets) so client components can
// gate UI by role without re-implementing the JWT decode on the browser.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    adminId: session.adminId,
    email: session.email,
    name: session.name,
    role: session.role,
    permissions: session.permissions,
  });
}
