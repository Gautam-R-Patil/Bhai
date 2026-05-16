// TODO(F16): the convex/store/developers:* + store/submissions:* + store/items:*
// functions are exported as internalQuery/internalMutation in the Convex
// backend (Cluster 1). Direct convexQuery() calls from the dev-portal hit
// `/api/query` which only sees public-facing wrappers. Until the developer
// portal is routed through a server-side proxy (mirroring admin-panel's
// /api/store), these calls will return null/empty in production. Local dev
// against a Convex deploy that re-aliases these as `query` still works.
import { getSession } from "@/lib/auth";
import { convexQuery } from "@/lib/convex";
import type { Developer, DeveloperStats, Submission, StoreItem } from "@/lib/types";
import { Package, Download, Star, Clock, Plus } from "lucide-react";
import Link from "next/link";

async function getDeveloperData(developerId: string) {
  try {
    const [developer, stats, recentSubmissions, publishedApps] = await Promise.all([
      convexQuery<Developer>("store/developers:getById", { developerId }),
      convexQuery<DeveloperStats>("store/developers:getStats", { developerId }),
      convexQuery<Submission[]>("store/submissions:listByDeveloper", { developerId, limit: 5 }),
      convexQuery<StoreItem[]>("store/items:listByDeveloper", { developerId, limit: 5 }),
    ]);
    return { developer, stats, recentSubmissions, publishedApps };
  } catch (err) {
    console.error("Failed to load developer data:", err);
    return { developer: null, stats: null, recentSubmissions: [], publishedApps: [] };
  }
}

export default async function DeveloperDashboard() {
  const session = await getSession();
  if (!session) return null;

  const { developer, stats, recentSubmissions, publishedApps } = await getDeveloperData(
    session.developerId
  );

  // Show pending approval message
  if (session.status === "pending") {
    return (
      <div className="max-w-2xl mx-auto mt-20">
        <div className="glass-card-static p-8 text-center border-l-4 border-l-yellow-500">
          <Clock className="h-12 w-12 text-yellow-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-[--text-primary] mb-2">
            Account Pending Approval
          </h2>
          <p className="text-[--text-secondary] mb-4">
            Your developer account is being reviewed. You&apos;ll receive an email once
            approved. This usually takes 1-2 business days.
          </p>
          <p className="text-sm text-[--text-muted]">
            While waiting, you can check out our{" "}
            <Link href="/docs" className="text-[--accent-primary] hover:underline">
              documentation
            </Link>{" "}
            to learn how to build Skills, MCP Servers, and Tools.
          </p>
        </div>
      </div>
    );
  }

  // Show rejected message
  if (session.status === "rejected") {
    return (
      <div className="max-w-2xl mx-auto mt-20">
        <div className="glass-card-static p-8 text-center border-l-4 border-l-red-500">
          <h2 className="text-xl font-semibold text-[--text-primary] mb-2">
            Application Not Approved
          </h2>
          <p className="text-[--text-secondary] mb-4">
            Unfortunately, your developer application was not approved.
          </p>
          {developer?.verificationNotes && (
            <div className="glass-card p-4 text-left mb-4">
              <p className="text-sm font-medium text-[--text-primary]">Reason:</p>
              <p className="text-sm text-[--text-secondary]">{developer.verificationNotes}</p>
            </div>
          )}
          <p className="text-sm text-[--text-muted]">
            If you believe this was a mistake, please contact support.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="page-header">
          <h1 className="page-title">Welcome, {session.displayName}!</h1>
          <p className="page-subtitle">Here&apos;s an overview of your developer account</p>
        </div>
        <Link
          href="/apps/new"
          className="btn-glass btn-glass-primary flex items-center gap-2"
        >
          <Plus className="h-5 w-5" />
          New Submission
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-5">
        <div className="stat-card-glass">
          <div className="stat-icon stat-icon-blue">
            <Package className="h-6 w-6" />
          </div>
          <div>
            <p className="stat-label">Published Apps</p>
            <p className="stat-value">{stats?.totalApps || 0}</p>
          </div>
        </div>

        <div className="stat-card-glass">
          <div className="stat-icon stat-icon-green">
            <Download className="h-6 w-6" />
          </div>
          <div>
            <p className="stat-label">Total Installs</p>
            <p className="stat-value">{(stats?.totalInstalls || 0).toLocaleString()}</p>
          </div>
        </div>

        <div className="stat-card-glass">
          <div className="stat-icon stat-icon-yellow">
            <Star className="h-6 w-6" />
          </div>
          <div>
            <p className="stat-label">Avg Rating</p>
            <p className="stat-value">{(stats?.averageRating || 0).toFixed(1)}</p>
          </div>
        </div>

        <div className="stat-card-glass">
          <div className="stat-icon stat-icon-orange">
            <Clock className="h-6 w-6" />
          </div>
          <div>
            <p className="stat-label">Pending</p>
            <p className="stat-value">{stats?.pendingSubmissions ?? 0}</p>
          </div>
        </div>
      </div>

      {/* Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Submissions */}
        <div className="glass-card-static p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-semibold text-[--text-primary]">Recent Submissions</h2>
            <Link href="/submissions" className="text-sm font-medium text-[--accent-primary] hover:underline">
              View all
            </Link>
          </div>
          {recentSubmissions.length === 0 ? (
            <p className="text-[--text-muted] text-sm">No submissions yet</p>
          ) : (
            <ul className="space-y-4">
              {recentSubmissions.map((sub) => (
                <li key={sub._id} className="flex items-center justify-between py-2">
                  <div>
                    <p className="font-medium text-[--text-primary]">{sub.name}</p>
                    <p className="text-sm text-[--text-muted]">
                      v{sub.version} &bull;{" "}
                      {new Date(sub.submittedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <span
                    className={`badge-glass ${
                      sub.status === "approved"
                        ? "badge-success"
                        : sub.status === "rejected"
                        ? "badge-danger"
                        : "badge-warning"
                    }`}
                  >
                    {sub.status.replace("_", " ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Published Apps */}
        <div className="glass-card-static p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-semibold text-[--text-primary]">Published Apps</h2>
            <Link href="/apps" className="text-sm font-medium text-[--accent-primary] hover:underline">
              View all
            </Link>
          </div>
          {publishedApps.length === 0 ? (
            <p className="text-[--text-muted] text-sm">No published apps yet</p>
          ) : (
            <ul className="space-y-4">
              {publishedApps.map((app) => (
                <li key={app._id} className="flex items-center justify-between py-2">
                  <div>
                    <p className="font-medium text-[--text-primary]">{app.name}</p>
                    <p className="text-sm text-[--text-muted]">
                      {app.installCount.toLocaleString()} installs &bull;{" "}
                      {app.rating.toFixed(1)} ★
                    </p>
                  </div>
                  <Link
                    href={`/apps/${app._id}`}
                    className="btn-glass btn-glass-secondary text-xs py-2 px-3"
                  >
                    Manage
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
