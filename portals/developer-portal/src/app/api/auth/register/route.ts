import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { convexQuery, convexMutation } from "@/lib/convex";
import { createSession } from "@/lib/auth";
import type { Developer } from "@/lib/types";

export async function POST(request: NextRequest) {
  try {
    const { email, password, displayName, companyName, website, bio } = await request.json();

    if (!email || !password || !displayName) {
      return NextResponse.json(
        { error: "Email, password, and display name are required" },
        { status: 400 }
      );
    }

    // Check if developer already exists
    const existing = await convexQuery<Developer | null>("store/developers:getByEmail", {
      email,
    });

    if (existing) {
      return NextResponse.json(
        { error: "Email already registered" },
        { status: 400 }
      );
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create developer
    const developerId = await convexMutation<string>("store/developers:register", {
      email,
      passwordHash,
      displayName,
      companyName,
      website,
      bio,
    });

    // Create session token
    const token = await createSession({
      developerId,
      email,
      displayName,
      status: "pending",
    });

    // Set cookie
    const cookieStore = await cookies();
    cookieStore.set("dev_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: "/",
    });

    return NextResponse.json({ success: true, developerId });
  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json(
      { error: "Registration failed" },
      { status: 500 }
    );
  }
}
