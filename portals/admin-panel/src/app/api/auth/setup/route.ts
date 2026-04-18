import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { convexQuery, convexMutation } from "@/lib/convex";
import type { Admin } from "@/lib/types";

// Initial admin setup - creates the first super_admin account
// Only works if no admins exist yet

export async function POST() {
  try {
    const email = process.env.INITIAL_ADMIN_EMAIL;
    const password = process.env.INITIAL_ADMIN_PASSWORD;

    if (!email || !password) {
      return NextResponse.json(
        { error: "INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD must be set" },
        { status: 400 }
      );
    }

    // Check if any admins exist
    const existingAdmin = await convexQuery<Admin | null>("store/admins:getByEmail", {
      email,
    });

    if (existingAdmin) {
      return NextResponse.json(
        { error: "Admin already exists" },
        { status: 400 }
      );
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create admin
    const adminId = await convexMutation<string>("store/admins:create", {
      email,
      passwordHash,
      name: "Super Admin",
      role: "super_admin",
      permissions: ["*"],
    });

    return NextResponse.json({
      success: true,
      message: "Initial admin created",
      adminId,
    });
  } catch (error) {
    console.error("Setup error:", error);
    return NextResponse.json(
      { error: "Setup failed" },
      { status: 500 }
    );
  }
}
