import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { convexQuery, convexMutation } from "@/lib/convex";
import { createSession } from "@/lib/auth";
import type { Developer } from "@/lib/types";

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password required" },
        { status: 400 }
      );
    }

    // Get developer by email
    const developer = await convexQuery<Developer | null>("store/developers:getByEmail", {
      email,
    });

    if (!developer) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 }
      );
    }

    // Verify password
    const devWithPassword = await convexQuery<{ passwordHash: string } | null>(
      "store/developers:getPasswordHash",
      { developerId: developer._id }
    );

    if (!devWithPassword) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 }
      );
    }

    const isValid = await bcrypt.compare(password, devWithPassword.passwordHash);

    if (!isValid) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 }
      );
    }

    // Check if banned/suspended
    if (developer.status === "banned") {
      return NextResponse.json(
        { error: "Your account has been banned" },
        { status: 403 }
      );
    }

    if (developer.status === "suspended") {
      return NextResponse.json(
        { error: "Your account has been suspended" },
        { status: 403 }
      );
    }

    // Update last login
    await convexMutation("store/developers:updateLastLogin", {
      developerId: developer._id,
    });

    // Create session token
    const token = await createSession({
      developerId: developer._id,
      email: developer.email,
      displayName: developer.displayName,
      status: developer.status,
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

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json(
      { error: "Login failed" },
      { status: 500 }
    );
  }
}
