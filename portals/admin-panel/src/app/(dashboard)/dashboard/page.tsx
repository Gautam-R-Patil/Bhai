import { adminHttpGet } from "@/lib/convex";
import type { SystemOverview } from "@/lib/types";
import DashboardClient from "./dashboard-client";

export const dynamic = "force-dynamic";

async function getOverview(): Promise<SystemOverview | null> {
  try {
    const { data } = await adminHttpGet<{ data: SystemOverview }>(
      "/api/admin/observability/system-overview",
    );
    return data;
  } catch (err) {
    console.error("[dashboard] system-overview failed:", err);
    return null;
  }
}

export default async function DashboardPage() {
  const initial = await getOverview();
  return <DashboardClient initial={initial} initialFetchedAt={Date.now()} />;
}
