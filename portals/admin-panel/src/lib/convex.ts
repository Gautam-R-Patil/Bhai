// Convex API client for admin panel
// Direct HTTPS calls to Convex backend

const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL || "https://avid-oyster-465.convex.cloud";

interface ConvexResponse<T> {
  status: "success" | "error";
  value?: T;
  errorMessage?: string;
}

export async function convexQuery<T>(
  functionName: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: functionName,
      args: { ...args },
      format: "json",
    }),
  });

  const data: ConvexResponse<T> = await response.json();

  if (data.status === "error") {
    throw new Error(data.errorMessage || "Query failed");
  }

  return data.value as T;
}

export async function convexMutation<T>(
  functionName: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: functionName,
      args: { ...args },
      format: "json",
    }),
  });

  const data: ConvexResponse<T> = await response.json();

  if (data.status === "error") {
    throw new Error(data.errorMessage || "Mutation failed");
  }

  return data.value as T;
}

export async function convexAction<T>(
  functionName: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch(`${CONVEX_URL}/api/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: functionName,
      args: { ...args },
      format: "json",
    }),
  });

  const data: ConvexResponse<T> = await response.json();

  if (data.status === "error") {
    throw new Error(data.errorMessage || "Action failed");
  }

  return data.value as T;
}

// Admin API base URL — the site URL (not the Convex cloud URL) is where
// httpAction routes live. Configure with NEXT_PUBLIC_ATLAS_ADMIN_API_BASE;
// falls back to deriving from CONVEX_URL when absent.
function adminBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_ATLAS_ADMIN_API_BASE;
  if (explicit) return explicit.replace(/\/+$/, "");
  // Convex conventionally exposes httpActions on the *.convex.site domain
  // that matches the *.convex.cloud API domain. Fallback handles local dev.
  return CONVEX_URL.replace(".convex.cloud", ".convex.site");
}

function adminKey(): string {
  // ATLAS_ADMIN_KEY is intentionally NOT NEXT_PUBLIC_*. Next.js inlines any
  // NEXT_PUBLIC_* variable into every client bundle at build time — even
  // when the only on-paper consumer is a Server Component, the literal
  // value lands in browser JS. Reading without the prefix forces the value
  // to stay server-side; anything that imports this module from a client
  // boundary will get `undefined` and the throw below makes the regression
  // loud instead of silently shipping the master key to every browser tab.
  const key = process.env.ATLAS_ADMIN_KEY;
  if (!key) throw new Error("Bhai admin key missing (set ATLAS_ADMIN_KEY in server-side env, NOT NEXT_PUBLIC_*).");
  return key;
}

// Admin-gated HTTP GET for endpoints defined with validateAdminRequest().
// Use this for routes like /api/admin/observability/overview that require
// a Bearer-authenticated request instead of Convex's public /api/query.
//
// `cache: "no-store"` is load-bearing: Next.js' server-fetch defaults to
// `force-cache` even when the calling page is `dynamic = "force-dynamic"`,
// so without this the dashboard would render data from the first request
// after deploy until the server process restarts.
export async function adminHttpGet<T>(path: string): Promise<T> {
  const url = `${adminBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${adminKey()}` },
    cache: "no-store",
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Admin GET ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

export async function adminHttpPost<T>(path: string, body: unknown): Promise<T> {
  const url = `${adminBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Admin POST ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

// Convenience wrappers: read/write the store via the admin-key-gated
// /api/admin/store-{query,mutation} proxy. Every store/* function is now
// declared as internalQuery/internalMutation in Convex (see admins.ts,
// developers.ts, submissions.ts line 5 of each), so the public /api/query
// path can't reach them. The proxy reuses the existing STORE_QUERY_ALLOWLIST
// — anything not in that map returns 403.
export async function adminStoreQuery<T>(
  functionPath: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { value } = await adminHttpPost<{ status: "success"; value: T }>(
    "/api/admin/store-query",
    { functionPath, args },
  );
  return value;
}

export async function adminStoreMutation<T>(
  functionPath: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { value } = await adminHttpPost<{ status: "success"; value: T }>(
    "/api/admin/store-mutation",
    { functionPath, args },
  );
  return value;
}

// ── Browser-side store proxy ────────────────────────────────────────────────
// Client components can't read ATLAS_ADMIN_KEY, so they hit the same-origin
// /api/store route which adds the admin bearer server-side and forwards to
// the admin-key-gated Convex store proxy.
export async function storeProxy<T>(
  kind: "query" | "mutation",
  functionPath: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const resp = await fetch("/api/store", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, functionPath, args }),
  });
  if (!resp.ok) {
    let msg = `${resp.status}`;
    try {
      const data = await resp.json();
      if (data?.error) msg = data.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const data = (await resp.json()) as { value: T };
  return data.value;
}
