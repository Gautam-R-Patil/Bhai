import { convexQuery } from "@/lib/convex";
import type { DashboardStats, Submission, Developer } from "@/lib/types";
import {
  Users,
  Code2,
  Package,
  Download,
  TrendingUp,
  Clock,
} from "lucide-react";
import Link from "next/link";

async function getStats(): Promise<DashboardStats> {
  try {
    return await convexQuery<DashboardStats>("store/admins:getDashboardStats", {});
  } catch {
    return {
      totalUsers: 0,
      totalDevelopers: 0,
      pendingDevelopers: 0,
      totalItems: 0,
      activeItems: 0,
      pendingSubmissions: 0,
      totalInstalls: 0,
    };
  }
}

async function getPendingDevelopers(): Promise<Developer[]> {
  try {
    return await convexQuery<Developer[]>("store/developers:listByStatus", {
      status: "pending",
      limit: 5,
    });
  } catch {
    return [];
  }
}

async function getPendingSubmissions(): Promise<Submission[]> {
  try {
    return await convexQuery<Submission[]>("store/submissions:listPending", {
      limit: 5,
    });
  } catch {
    return [];
  }
}

export default async function DashboardPage() {
  const [stats, pendingDevs, pendingSubmissions] = await Promise.all([
    getStats(),
    getPendingDevelopers(),
    getPendingSubmissions(),
  ]);

  const statCards = [
    { name: "Total Users", value: stats.totalUsers ?? 0, icon: Users, color: "stat-icon-blue" },
    { name: "Developers", value: stats.totalDevelopers ?? 0, icon: Code2, color: "stat-icon-green" },
    { name: "Published Items", value: stats.totalItems ?? 0, icon: Package, color: "stat-icon-purple" },
    { name: "Active Items", value: stats.activeItems ?? 0, icon: TrendingUp, color: "stat-icon-pink" },
    { name: "Total Installs", value: stats.totalInstalls ?? 0, icon: Download, color: "stat-icon-orange" },
    { name: "Pending Reviews", value: stats.pendingSubmissions ?? 0, icon: Clock, color: "stat-icon-yellow" },
  ];

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">Welcome to the A.T.L.A.S Store Admin Panel</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {statCards.map((stat) => (
          <div key={stat.name} className="stat-card-glass">
            <div className={`stat-icon ${stat.color}`}>
              <stat.icon className="h-6 w-6" />
            </div>
            <div>
              <p className="stat-label">{stat.name}</p>
              <p className="stat-value">{stat.value.toLocaleString()}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Pending Items */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pending Developer Approvals */}
        <div className="glass-card-static p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-semibold text-[--text-primary]">
              Pending Developer Approvals
            </h2>
            <Link
              href="/developers?status=pending"
              className="text-sm font-medium text-[--accent-primary] hover:underline"
            >
              View all
            </Link>
          </div>
          {pendingDevs.length === 0 ? (
            <p className="text-[--text-muted] text-sm">No pending approvals</p>
          ) : (
            <ul className="space-y-4">
              {pendingDevs.map((dev) => (
                <li key={dev._id} className="flex items-center justify-between py-2">
                  <div>
                    <p className="font-medium text-[--text-primary]">{dev.displayName}</p>
                    <p className="text-sm text-[--text-muted]">{dev.email}</p>
                  </div>
                  <Link
                    href={`/developers/${dev._id}`}
                    className="btn-glass btn-glass-primary text-xs py-2 px-4"
                  >
                    Review
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Pending Submissions */}
        <div className="glass-card-static p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-semibold text-[--text-primary]">
              Pending App Submissions
            </h2>
            <Link
              href="/submissions"
              className="text-sm font-medium text-[--accent-primary] hover:underline"
            >
              View all
            </Link>
          </div>
          {pendingSubmissions.length === 0 ? (
            <p className="text-[--text-muted] text-sm">No pending submissions</p>
          ) : (
            <ul className="space-y-4">
              {pendingSubmissions.map((sub) => (
                <li key={sub._id} className="flex items-center justify-between py-2">
                  <div>
                    <p className="font-medium text-[--text-primary]">{sub.name}</p>
                    <p className="text-sm text-[--text-muted]">
                      {sub.type} &bull; v{sub.version}
                    </p>
                  </div>
                  <Link
                    href={`/submissions/${sub._id}`}
                    className="btn-glass btn-glass-primary text-xs py-2 px-4"
                  >
                    Review
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
