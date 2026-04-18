// Convex API client for admin panel
// Direct HTTPS calls to Convex backend

const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL || "https://zany-kudu-607.convex.cloud";

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
