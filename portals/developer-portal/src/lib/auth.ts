import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required. Set it in .env before starting the developer portal.");
}
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET);

export interface DeveloperSession {
  developerId: string;
  email: string;
  displayName: string;
  status: string;
}

export async function createSession(developer: DeveloperSession): Promise<string> {
  const token = await new SignJWT({
    developerId: developer.developerId,
    email: developer.email,
    displayName: developer.displayName,
    status: developer.status,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .setIssuedAt()
    .sign(JWT_SECRET);

  return token;
}

export async function verifySession(token: string): Promise<DeveloperSession | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return {
      developerId: payload.developerId as string,
      email: payload.email as string,
      displayName: payload.displayName as string,
      status: payload.status as string,
    };
  } catch {
    return null;
  }
}

export async function getSession(): Promise<DeveloperSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("dev_session")?.value;
  if (!token) return null;
  return verifySession(token);
}
