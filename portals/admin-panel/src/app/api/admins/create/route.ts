// Create a new admin. Permission-gated, server-side bcrypt (the browser
// must never ship a precomputed passwordHash — it would be equivalent to
// the password itself, since the server stores client input as the
// authoritative credential).

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { adminStoreMutation } from "@/lib/convex";
import { guard } from "@/lib/route-guards";

const ROLE_PERMISSIONS: Record<string, string[]> = {
  super_admin: [
    "approve_devs",
    "approve_apps",
    "manage_users",
    "manage_admins",
    "feature_apps",
    "view_analytics",
    "manage_settings",
  ],
  moderator: ["approve_devs", "approve_apps", "manage_users", "feature_apps", "view_analytics"],
  reviewer: ["approve_apps", "view_analytics"],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  const g = await guard(request, { permission: "manage_admins", maxBodyBytes: 4096 });
  if (!g.ok) return g.response;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const role = typeof body?.role === "string" ? body.role.trim() : "";

  if (!EMAIL_RE.test(email) || email.length > 320) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }
  if (!name || name.length > 100) {
    return NextResponse.json({ error: "Name is required (max 100 chars)" }, { status: 400 });
  }
  if (!password || password.length < 12) {
    return NextResponse.json(
      { error: "Password must be at least 12 characters" },
      { status: 400 },
    );
  }
  // bcryptjs truncates anything past 72 bytes — a 100-char password and a
  // 90-char password sharing the first 72 chars would both authenticate.
  // Cap below the truncation boundary so the on-file hash means what the
  // user expects. (Most practical passwords are well under this.)
  if (password.length > 72) {
    return NextResponse.json(
      { error: "Password too long (max 72 chars — bcrypt boundary)" },
      { status: 400 },
    );
  }
  if (!(role in ROLE_PERMISSIONS)) {
    return NextResponse.json(
      { error: "Role must be super_admin, moderator, or reviewer" },
      { status: 400 },
    );
  }
  // Only super_admins can mint another super_admin.
  if (role === "super_admin" && g.session.role !== "super_admin") {
    return NextResponse.json(
      { error: "Only a super_admin can create a super_admin" },
      { status: 403 },
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const adminId = await adminStoreMutation<string>("store/admins:create", {
      email,
      passwordHash,
      name,
      role,
      permissions: ROLE_PERMISSIONS[role],
    });
    console.log(`[admins] ${g.session.email} created admin email=${email} role=${role}`);
    return NextResponse.json({ adminId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Create failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
