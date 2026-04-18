import { convexQuery } from "@/lib/convex";
import {
  Activity,
  Cpu,
  DollarSign,
  AlertTriangle,
  Zap,
  Users,
  BarChart3,
  Clock,
} from "lucide-react";
import Link from "next/link";
import { ObservabilityCharts } from "./charts";

// ── Types ─────────────────────────────────────────

interface TierInfo {
  label: string;
  credits: number;
  color: string;
}

interface ModelInfo {
  model: string;
  fullModel: string;
  tier: string;
  creditsPerCall: number;
  costPer1kInput: number;
  costPer1kOutput: number;
}

interface RecentError {
  id: string;
  type: string;
  timestamp: number;
  metadata: string | null;
}

interface ObservabilityData {
  totalAccounts: number;
  activeAccounts: number;
  totalCreditsRemaining: number;
  creditsByPlan: Record<string, { count: number; totalCredits: number }>;
  activeSessions: number;
  sessionsToday: number;
  sessionsThisWeek: number;
  sessionsThisMonth: number;
  requestsOverTime: Array<{ date: string; requests: number }>;
  activityByType: Record<string, number>;
  modelUsage: ModelInfo[];
  tierBreakdown: Record<string, TierInfo>;
  recentErrors: RecentError[];
  errorCount: number;
}

interface CreditUser {
  userId: string;
  name: string;
  email: string;
  plan: string;
  status: string;
  creditsRemaining: number;
  activations: number;
}

// ── Data Fetching ─────────────────────────────────

async function getObservabilityData(): Promise<ObservabilityData | null> {
  try {
    return await convexQuery<ObservabilityData>("observability:getObservabilityData", {});
  } catch {
    return null;
  }
}

async function getCreditUsers(): Promise<CreditUser[]> {
  try {
    return await convexQuery<CreditUser[]>("observability:getCreditUsagePerUser", {});
  } catch {
    return [];
  }
}

// ── Helper ────────────────────────────────────────

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCredits(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

// ── Page ──────────────────────────────────────────

export default async function ObservabilityPage() {
  const [data, creditUsers] = await Promise.all([
    getObservabilityData(),
    getCreditUsers(),
  ]);

  if (!data) {
    return (
      <div className="space-y-8">
        <div className="page-header">
          <h1 className="page-title">Observability</h1>
          <p className="page-subtitle">Unable to load observability data</p>
        </div>
        <div className="glass-card-static p-8 text-center">
          <AlertTriangle className="h-12 w-12 text-[--accent-warning] mx-auto mb-4" />
          <p className="text-[--text-secondary]">
            Could not connect to the Convex backend. Make sure the observability queries are deployed.
          </p>
        </div>
      </div>
    );
  }

  // Build stat cards
  const statCards = [
    {
      name: "Active Sessions",
      value: data.activeSessions,
      icon: Zap,
      color: "stat-icon-green",
      sub: `${data.sessionsToday} today`,
    },
    {
      name: "Sessions This Week",
      value: data.sessionsThisWeek,
      icon: Activity,
      color: "stat-icon-blue",
      sub: `${data.sessionsThisMonth} this month`,
    },
    {
      name: "Total Credits Remaining",
      value: formatCredits(data.totalCreditsRemaining),
      icon: DollarSign,
      color: "stat-icon-purple",
      sub: `across ${data.activeAccounts} active accounts`,
    },
    {
      name: "Active Accounts",
      value: data.activeAccounts,
      icon: Users,
      color: "stat-icon-orange",
      sub: `of ${data.totalAccounts} total`,
    },
    {
      name: "Model Tiers Available",
      value: Object.keys(data.tierBreakdown).length,
      icon: Cpu,
      color: "stat-icon-pink",
      sub: `${data.modelUsage.length} models configured`,
    },
    {
      name: "Recent Errors",
      value: data.errorCount,
      icon: AlertTriangle,
      color: data.errorCount > 0 ? "stat-icon-red" : "stat-icon-green",
      sub: data.errorCount > 0 ? "review below" : "all clear",
    },
  ];

  // Prepare chart data
  const activityTypeData = Object.entries(data.activityByType)
    .map(([type, count]) => ({ name: type, value: count }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  const tierData = Object.entries(data.tierBreakdown).map(([key, tier]) => ({
    name: tier.label,
    credits: tier.credits,
    color: tier.color,
    models: data.modelUsage.filter((m) => m.tier === key).length,
  }));

  const planData = Object.entries(data.creditsByPlan).map(([plan, info]) => ({
    name: plan,
    users: info.count,
    credits: info.totalCredits,
  }));

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="page-header">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">Observability</h1>
            <p className="page-subtitle">
              LLM usage, credit tracking, and system health monitoring
            </p>
          </div>
          <Link href="/dashboard" className="btn-glass btn-glass-secondary text-sm">
            Back to Dashboard
          </Link>
        </div>
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
              <p className="stat-value">{stat.value}</p>
              <p className="text-xs text-[--text-muted] mt-0.5">{stat.sub}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Charts Section (client component) */}
      <ObservabilityCharts
        requestsOverTime={data.requestsOverTime}
        activityTypeData={activityTypeData}
        tierData={tierData}
        planData={planData}
      />

      {/* Model Tiers Table */}
      <div className="glass-card-static p-6">
        <div className="flex items-center gap-3 mb-5">
          <BarChart3 className="h-5 w-5 text-[--accent-primary]" />
          <h2 className="text-lg font-semibold text-[--text-primary]">
            Model Cost Tiers
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/5">
                <th className="text-left py-3 px-4 font-semibold text-[--text-secondary]">Model</th>
                <th className="text-left py-3 px-4 font-semibold text-[--text-secondary]">Tier</th>
                <th className="text-right py-3 px-4 font-semibold text-[--text-secondary]">Credits/Call</th>
                <th className="text-right py-3 px-4 font-semibold text-[--text-secondary]">$/1K Input</th>
                <th className="text-right py-3 px-4 font-semibold text-[--text-secondary]">$/1K Output</th>
              </tr>
            </thead>
            <tbody>
              {data.modelUsage.map((m) => (
                <tr
                  key={m.fullModel}
                  className="border-b border-black/[0.03] hover:bg-white/40 transition-colors"
                >
                  <td className="py-3 px-4">
                    <span className="font-medium text-[--text-primary]">{m.model}</span>
                    <span className="text-[--text-muted] text-xs ml-2">
                      {m.fullModel.split("/")[0]}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        m.tier === "light"
                          ? "bg-green-100 text-green-800"
                          : m.tier === "mid"
                          ? "bg-yellow-100 text-yellow-800"
                          : m.tier === "pro"
                          ? "bg-blue-100 text-blue-800"
                          : "bg-red-100 text-red-800"
                      }`}
                    >
                      {m.tier}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-[--text-secondary]">
                    {m.creditsPerCall}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-[--text-secondary]">
                    ${m.costPer1kInput.toFixed(4)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-[--text-secondary]">
                    ${m.costPer1kOutput.toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Credit Usage Per User */}
      {creditUsers.length > 0 && (
        <div className="glass-card-static p-6">
          <div className="flex items-center gap-3 mb-5">
            <Users className="h-5 w-5 text-[--accent-primary]" />
            <h2 className="text-lg font-semibold text-[--text-primary]">
              Credit Usage Per User
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/5">
                  <th className="text-left py-3 px-4 font-semibold text-[--text-secondary]">User</th>
                  <th className="text-left py-3 px-4 font-semibold text-[--text-secondary]">Plan</th>
                  <th className="text-left py-3 px-4 font-semibold text-[--text-secondary]">Status</th>
                  <th className="text-right py-3 px-4 font-semibold text-[--text-secondary]">Credits Remaining</th>
                  <th className="text-right py-3 px-4 font-semibold text-[--text-secondary]">Activations</th>
                </tr>
              </thead>
              <tbody>
                {creditUsers.slice(0, 20).map((user) => (
                  <tr
                    key={user.userId}
                    className="border-b border-black/[0.03] hover:bg-white/40 transition-colors"
                  >
                    <td className="py-3 px-4">
                      <p className="font-medium text-[--text-primary]">{user.name}</p>
                      {user.email && (
                        <p className="text-xs text-[--text-muted]">{user.email}</p>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          user.plan === "enterprise"
                            ? "bg-purple-100 text-purple-800"
                            : user.plan === "pro"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-gray-100 text-gray-800"
                        }`}
                      >
                        {user.plan}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          user.status === "active"
                            ? "bg-green-100 text-green-800"
                            : user.status === "suspended"
                            ? "bg-yellow-100 text-yellow-800"
                            : "bg-red-100 text-red-800"
                        }`}
                      >
                        {user.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-[--text-secondary]">
                      {formatCredits(user.creditsRemaining)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-[--text-secondary]">
                      {user.activations}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Errors */}
      <div className="glass-card-static p-6">
        <div className="flex items-center gap-3 mb-5">
          <AlertTriangle className="h-5 w-5 text-[--accent-danger]" />
          <h2 className="text-lg font-semibold text-[--text-primary]">
            Recent Errors
          </h2>
        </div>
        {data.recentErrors.length === 0 ? (
          <div className="text-center py-8">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-green-100 mb-3">
              <Zap className="h-6 w-6 text-green-600" />
            </div>
            <p className="text-[--text-secondary]">No recent errors detected</p>
            <p className="text-xs text-[--text-muted] mt-1">System is operating normally</p>
          </div>
        ) : (
          <div className="space-y-3">
            {data.recentErrors.map((err) => {
              let errorDetail = "";
              try {
                const meta = JSON.parse(err.metadata || "{}");
                errorDetail = meta.error || meta.message || JSON.stringify(meta).slice(0, 200);
              } catch {
                errorDetail = err.metadata || "Unknown error";
              }

              return (
                <div
                  key={err.id}
                  className="flex items-start gap-4 p-4 rounded-xl bg-red-50/50 border border-red-100"
                >
                  <div className="flex-shrink-0 mt-0.5">
                    <Clock className="h-4 w-4 text-red-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-red-700 bg-red-100 px-2 py-0.5 rounded">
                        {err.type}
                      </span>
                      <span className="text-xs text-[--text-muted]">
                        {formatTimestamp(err.timestamp)}
                      </span>
                    </div>
                    <p className="text-sm text-[--text-secondary] truncate">
                      {errorDetail}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
