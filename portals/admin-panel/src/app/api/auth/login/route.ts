import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { adminHttpPost } from "@/lib/convex";
import { createSession } from "@/lib/auth";
import type { Admin } from "@/lib/types";

// Valid bcrypt-shaped hash that will never match any real password. Used to
// burn equivalent CPU on the user-not-found path so the response time
// doesn't reveal whether the email is registered (timing-oracle defense).
const DUMMY_BCRYPT_HASH = "$2a$12$" + "C".repeat(53);

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password required" },
        { status: 400 }
      );
    }

    // store/admins:* are exported as internalQuery/internalMutation in
    // convex/store/admins.ts (line 5), so they're NOT reachable via the
    // public /api/query path. We use admin-key-gated HTTP wrappers
    // (defined in convex/http.ts) that ATLAS_ADMIN_KEY can call.
    const { admin } = await adminHttpPost<{ admin: Admin | null }>(
      "/api/admin/auth/get-by-email",
      { email }
    );

    // Equalize response timing across the three failure paths:
    //   (a) user not found    — skip second roundtrip + bcrypt
    //   (b) hash missing       — only first roundtrip
    //   (c) wrong password     — two roundtrips + real bcrypt
    // Without this, (a) is ~200ms faster than (c) and admin emails can be
    // enumerated by measuring response time. We always burn the bcrypt cost.
    let storedHash: string | null = null;
    if (admin) {
      const pwResult = await adminHttpPost<{ passwordHash: string } | null>(
        "/api/admin/auth/get-password-hash",
        { adminId: admin._id }
      );
      storedHash = pwResult?.passwordHash ?? null;
    }
    const isValid = await bcrypt.compare(password, storedHash ?? DUMMY_BCRYPT_HASH);

    if (!admin || !storedHash || !isValid) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 }
      );
    }

    // Update last login
    await adminHttpPost<{ success: boolean }>(
      "/api/admin/auth/update-last-login",
      { adminId: admin._id }
    );

    // Create session token
    const token = await createSession({
      adminId: admin._id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      permissions: admin.permissions,
    });

    // Set cookie. SameSite=strict is correct here — this is a single-origin
    // admin panel with no cross-site flows to break, and strict gives the
    // strongest CSRF defense in browsers that honor it.
    const cookieStore = await cookies();
    cookieStore.set("admin_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 60 * 60 * 24, // 24 hours
      path: "/",
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json(
      { error: "Login failed" },
      { status: 500 }
    );
  }
}
