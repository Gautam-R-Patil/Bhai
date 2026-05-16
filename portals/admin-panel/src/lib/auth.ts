import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const rawJwtSecret = process.env.JWT_SECRET;
if (!rawJwtSecret) {
  throw new Error(
    "JWT_SECRET environment variable is required. Set it in .env before starting the admin panel.",
  );
}
// Refuse the placeholder from .env.example — leaving it set ships a guessable
// secret that anyone reading the public repo could use to mint admin sessions.
if (
  rawJwtSecret.includes("change-this") ||
  rawJwtSecret === "your-super-secret-jwt-key-change-this-in-production-64-chars" ||
  rawJwtSecret.length < 32
) {
  throw new Error(
    "JWT_SECRET is unsafe. Generate a fresh ≥32-char random value: " +
      "openssl rand -base64 48",
  );
}
const JWT_SECRET = new TextEncoder().encode(rawJwtSecret);

export interface AdminSession {
  adminId: string;
  email: string;
  name: string;
  role: string;
  permissions: string[];
}

export async function createSession(admin: AdminSession): Promise<string> {
  const token = await new SignJWT({
    adminId: admin.adminId,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    permissions: admin.permissions,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("24h")
    .setIssuedAt()
    .sign(JWT_SECRET);

  return token;
}

export async function verifySession(token: string): Promise<AdminSession | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return {
      adminId: payload.adminId as string,
      email: payload.email as string,
      name: payload.name as string,
      role: payload.role as string,
      permissions: payload.permissions as string[],
    };
  } catch {
    return null;
  }
}

export async function getSession(): Promise<AdminSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("admin_session")?.value;
  if (!token) return null;
  return verifySession(token);
}

export function hasPermission(session: AdminSession, permission: string): boolean {
  if (session.role === "super_admin") return true;
  return session.permissions.includes(permission);
}
