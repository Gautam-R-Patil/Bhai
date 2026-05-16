// Initial admin bootstrap. Idempotent: if ANY admin already exists, the
// endpoint refuses (no matter what email is in the env). This is the only
// way to seed a fresh deployment from the browser. After the first admin
// is created, all subsequent admin creation goes through /api/admins/create
// which requires `manage_admins`.

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { adminHttpPost, adminStoreQuery } from "@/lib/convex";

interface AdminRow {
  _id: string;
  email: string;
  role: string;
}

const PLACEHOLDER_PASSWORDS = new Set([
  "change-this-password",
  "CHANGE_ME_AFTER_FIRST_LOGIN",
  "password",
  "admin",
]);

export async function POST() {
  const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD;

  if (!email || !password) {
    return NextResponse.json(
      { error: "INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD must be set" },
      { status: 400 },
    );
  }
  // Refuse known-placeholder values so a misconfigured deployment can't
  // accidentally ship with a guessable bootstrap password.
  if (PLACEHOLDER_PASSWORDS.has(password) || password.length < 12) {
    return NextResponse.json(
      {
        error:
          "INITIAL_ADMIN_PASSWORD is a placeholder or shorter than 12 chars. " +
          "Set a fresh strong password before running setup.",
      },
      { status: 400 },
    );
  }

  // Authoritative existence check via the admin-key-gated store proxy.
  // The previous version called `convexQuery("store/admins:getByEmail")`,
  // which always fails (the function is internalQuery), so the guard was
  // effectively a no-op. We now list ALL admins and refuse if any exist.
  let existing: AdminRow[];
  try {
    existing = await adminStoreQuery<AdminRow[]>("store/admins:listAll", {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not query admins";
    return NextResponse.json({ error: `Admin lookup failed: ${msg}` }, { status: 500 });
  }
  if (existing.length > 0) {
    return NextResponse.json(
      {
        error:
          "Setup is already complete. To create additional admins, log in as a super_admin " +
          "and use the Admins page.",
      },
      { status: 409 },
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const result = await adminHttpPost<{ adminId: string }>(
      "/api/admin/setup-super-admin",
      { email, passwordHash, name: "Super Admin" },
    );
    console.log(`[setup] initial super_admin created: ${email}`);
    return NextResponse.json({ success: true, adminId: result.adminId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Setup failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
