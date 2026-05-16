import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { convexQuery, convexMutation } from "@/lib/convex";
import { createSession } from "@/lib/auth";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import type { Developer } from "@/lib/types";

// F14: dummy hash to burn bcrypt CPU on the user-not-found path so the
// response time doesn't reveal whether the email is registered.
const DUMMY_BCRYPT_HASH = "$2a$12$" + "C".repeat(53);

export async function POST(request: NextRequest) {
  try {
    // F14: per-IP rate limit on login. 5 attempts / 60s. Blocks credential
    // stuffing + email enumeration even before bcrypt fires.
    const ip = clientIp(request);
    const rl = checkRateLimit(`dev-login:${ip}`, 5);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many attempts. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
      );
    }

    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password required" },
        { status: 400 }
      );
    }

    const developer = await convexQuery<Developer | null>("store/developers:getByEmail", {
      email,
    });

    // F14: equalize timing across all failure paths. Always run bcrypt.
    let storedHash: string | null = null;
    if (developer) {
      const devWithPassword = await convexQuery<{ passwordHash: string } | null>(
        "store/developers:getPasswordHash",
        { developerId: developer._id }
      );
      storedHash = devWithPassword?.passwordHash ?? null;
    }
    const isValid = await bcrypt.compare(password, storedHash ?? DUMMY_BCRYPT_HASH);

    // F14: collapse banned / suspended / wrong-password into a single
    // "Invalid credentials" response so an attacker can't probe a user's
    // status via the login endpoint. Banned/suspended users still get the
    // dashboard redirect block via layout.tsx (F14d).
    if (!developer || !storedHash || !isValid || developer.status === "banned" || developer.status === "suspended") {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 }
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
