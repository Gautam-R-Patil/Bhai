import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { convexQuery, convexMutation } from "@/lib/convex";
import { createSession } from "@/lib/auth";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import type { Developer } from "@/lib/types";

// F14: simple RFC-style email validation. Not a full grammar — just enough
// to reject obvious garbage at the API boundary before we hash and store.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// bcrypt truncates inputs above 72 bytes. Reject explicitly so user is
// told their password is too long instead of silently being capped.
const PASSWORD_MIN = 8;
const PASSWORD_MAX_BYTES = 72;

export async function POST(request: NextRequest) {
  try {
    // F14: per-IP rate limit on register. Same 5/min as login.
    const ip = clientIp(request);
    const rl = checkRateLimit(`dev-register:${ip}`, 5);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many attempts. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
      );
    }

    const { email, password, displayName, companyName, website, bio } = await request.json();

    if (!email || !password || !displayName) {
      return NextResponse.json(
        { error: "Email, password, and display name are required" },
        { status: 400 }
      );
    }

    // F14: email format + password length validation.
    if (typeof email !== "string" || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
    }
    if (typeof password !== "string") {
      return NextResponse.json({ error: "Invalid password" }, { status: 400 });
    }
    if (password.length < PASSWORD_MIN) {
      return NextResponse.json(
        { error: `Password must be at least ${PASSWORD_MIN} characters` },
        { status: 400 },
      );
    }
    if (Buffer.byteLength(password, "utf-8") > PASSWORD_MAX_BYTES) {
      return NextResponse.json(
        { error: `Password too long (max ${PASSWORD_MAX_BYTES} bytes; bcrypt limit)` },
        { status: 400 },
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
