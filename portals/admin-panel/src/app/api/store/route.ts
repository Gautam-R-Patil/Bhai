// Server-side proxy for store-* admin reads/writes.
//
// SECURITY MODEL — every mutation that touches admin / developer / app state
// is mapped to a required permission (`STORE_FUNCTION_PERMISSIONS`). The
// session must hold that permission (or be a super_admin) or the request is
// rejected at the Next.js boundary BEFORE the admin-key bearer hits Convex.
//
// Why this matters: the Convex side enforces `ADMIN_API_KEY` only — it has no
// notion of which logged-in admin made the request, so it cannot tell a
// reviewer apart from a super_admin. Without this layer, any authenticated
// admin could fetch("/api/store", {kind:"mutation", functionPath:"store/admins:create", ...})
// and self-promote.

import { NextRequest, NextResponse } from "next/server";
import { adminStoreQuery, adminStoreMutation } from "@/lib/convex";
import { getSession, hasPermission, type AdminSession } from "@/lib/auth";

// Functions that need a specific permission to invoke. Anything not in this
// map is treated as "read-safe" and only requires an authenticated session.
// `null` means "ALWAYS REJECT from this route" — use the dedicated server
// route (e.g. /api/admins/create) which does additional validation.
const STORE_FUNCTION_PERMISSIONS: Record<string, string | null> = {
  // Admin management — never expose through the generic proxy.
  // /api/admins/create + /api/admins/change-password compute bcrypt hashes
  // server-side and gate by manage_admins; this proxy must not accept a
  // client-supplied passwordHash.
  "store/admins:create": null,
  "store/admins:update": null,
  "store/admins:changePassword": null,
  "store/admins:remove": null,
  "store/admins:deleteAdmin": null,
  "store/admins:initSuperAdmin": null,
  "store/admins:recordLogin": null,
  "store/admins:updateLastLogin": null,

  // Developer review actions
  "store/developers:approve": "approve_devs",
  "store/developers:reject": "approve_devs",
  "store/developers:suspend": "approve_devs",
  "store/developers:ban": "approve_devs",
  "store/developers:reinstate": "approve_devs",
  "store/developers:updateProfile": null, // developer-facing, not admin
  "store/developers:register": null,
  "store/developers:recordLogin": null,
  "store/developers:updateLastLogin": null,
  "store/developers:changePassword": null,

  // Store items
  "store/items:setFeatured": "feature_apps",
  "store/items:updateStatus": "approve_apps",
  "store/items:create": null, // developers create via their portal
  "store/items:update": null,
  "store/items:incrementInstallCount": null, // system-only
  "store/items:updateRating": null, // system-only
  "store/items:resetWeeklyInstalls": null, // cron-only

  // Submissions review
  "store/submissions:approve": "approve_apps",
  "store/submissions:reject": "approve_apps",
  "store/submissions:requestRevision": "approve_apps",
  "store/submissions:startReview": "approve_apps",
  "store/submissions:cancel": null, // developer-facing
  "store/submissions:resubmit": null, // developer-facing
  "store/submissions:create": null, // developer-facing

  // Installs
  "store/installs:uninstall": "manage_users",
  "store/installs:startInstall": null, // user-facing
  "store/installs:confirmInstall": null, // user-facing
  "store/installs:updateVersion": null, // user-facing
  "store/installs:setAutoUpdate": null, // user-facing
  "store/installs:getUpdateDownload": null, // user-facing

  // Reviews
  "store/reviews:submit": null, // user-facing
  "store/reviews:remove": null, // user-facing (own review)
  "store/reviews:adminDelete": "approve_apps",
  "store/reviews:markHelpful": null, // user-facing

  // Storage
  "store/storage:generateUploadUrl": null,
  "store/storage:generateAdminUploadUrl": null,
  "store/storage:deleteFile": "manage_admins",
  "store/storage:cleanupOrphanedFiles": "manage_admins",
  "store/storage:getItemContentUrl": null,
};

const MAX_BODY_BYTES = 64_000;

// Defense-in-depth query denylist. Even if Convex's STORE_QUERY_ALLOWLIST
// is later widened to re-include any of these, the admin panel still won't
// expose them. Anything that returns credential material (bcrypt hashes,
// raw secrets) belongs here.
const QUERY_DENYLIST = new Set<string>([
  "store/admins:getPasswordHash",
  "store/developers:getPasswordHash",
]);

function originAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // same-origin fetches often omit Origin
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

function authorize(
  session: AdminSession,
  functionPath: string,
  kind: "query" | "mutation",
): { ok: true } | { ok: false; status: number; error: string } {
  // Queries: anything not explicitly forbidden is allowed for any logged-in
  // admin. Treat read access as a low-bar default — the alternative is to
  // enumerate every read and we lose the convenience of the proxy.
  if (kind === "query") {
    if (QUERY_DENYLIST.has(functionPath)) {
      return {
        ok: false,
        status: 403,
        error: "Function not allowed via this proxy",
      };
    }
    return { ok: true };
  }

  // Mutations: must be in the permission map.
  if (!(functionPath in STORE_FUNCTION_PERMISSIONS)) {
    return { ok: false, status: 403, error: "Function not allowed via this proxy" };
  }
  const required = STORE_FUNCTION_PERMISSIONS[functionPath];
  if (required === null) {
    return {
      ok: false,
      status: 403,
      error:
        "This function is not exposed to the admin panel. Use the dedicated endpoint or run via the Convex CLI.",
    };
  }
  if (!hasPermission(session, required)) {
    return {
      ok: false,
      status: 403,
      error: `Missing permission: ${required}`,
    };
  }
  return { ok: true };
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!originAllowed(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }

  // Body size cap — cheap DoS gate. Next.js' default is ~1MB; we tighten.
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { kind, functionPath, args } = body || {};
  if (!functionPath || typeof functionPath !== "string") {
    return NextResponse.json({ error: "functionPath is required" }, { status: 400 });
  }
  if (kind !== "query" && kind !== "mutation") {
    return NextResponse.json({ error: "kind must be 'query' or 'mutation'" }, { status: 400 });
  }

  const authz = authorize(session, functionPath, kind);
  if (!authz.ok) {
    console.warn(
      `[store-proxy] DENIED ${session.email} (${session.role}) → ${kind}:${functionPath} — ${authz.error}`,
    );
    return NextResponse.json({ error: authz.error }, { status: authz.status });
  }

  try {
    const value =
      kind === "query"
        ? await adminStoreQuery<unknown>(functionPath, args ?? {})
        : await adminStoreMutation<unknown>(functionPath, args ?? {});
    return NextResponse.json({ value });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Proxy failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
