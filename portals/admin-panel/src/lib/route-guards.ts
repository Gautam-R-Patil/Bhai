// Shared guards for admin-panel API routes. Centralised so every state-mutating
// endpoint enforces the same checks: session → permission → origin → body-size.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSession, hasPermission, type AdminSession } from "./auth";

const DEFAULT_MAX_BODY_BYTES = 64_000;

export function originAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  // Same-origin fetches frequently omit Origin; that's safe given SameSite=Lax
  // and the lack of a public-write surface here.
  if (!origin) return true;
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

export function bodySizeOk(request: NextRequest, max = DEFAULT_MAX_BODY_BYTES): boolean {
  const lengthHeader = request.headers.get("content-length");
  if (!lengthHeader) return true;
  const n = Number(lengthHeader);
  return Number.isFinite(n) && n <= max;
}

export interface GuardOptions {
  permission?: string;
  /** Skip body-size check (e.g. for GETs). */
  allowAnyBodySize?: boolean;
  maxBodyBytes?: number;
}

export type GuardResult =
  | { ok: true; session: AdminSession }
  | { ok: false; response: NextResponse };

export async function guard(
  request: NextRequest,
  opts: GuardOptions = {},
): Promise<GuardResult> {
  const session = await getSession();
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (opts.permission && !hasPermission(session, opts.permission)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Forbidden: ${opts.permission} required` },
        { status: 403 },
      ),
    };
  }
  if (!originAllowed(request)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Cross-origin request rejected" },
        { status: 403 },
      ),
    };
  }
  if (!opts.allowAnyBodySize && !bodySizeOk(request, opts.maxBodyBytes)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Body too large" }, { status: 413 }),
    };
  }
  return { ok: true, session };
}
