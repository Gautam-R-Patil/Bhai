import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required. Set it in .env before starting the admin panel.");
}
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET);

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
