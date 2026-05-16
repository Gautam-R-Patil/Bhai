import { adminHttpGet } from "@/lib/convex";
import type { SystemOverview } from "@/lib/types";
import {
  Users,
  Code2,
  Package,
  Download,
  TrendingUp,
  Clock,
  UserPlus,
  Mail,
  Activity,
  AlertTriangle,
  Cpu,
  DollarSign,
  CircleCheck,
  CircleAlert,
  CircleSlash,
} from "lucide-react";
import Link from "next/link";

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

function fmtN(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function relTime(ts: number | null, now: number): string {
  if (!ts) return "never";
  const ms = now - ts;
  if (ms < 0) return "in the future";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default async function DashboardPage() {
  const data = await getOverview();

  if (!data) {
    return (
      <div className="space-y-6">
        <div className="page-header">
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Could not load system overview</p>
        </div>
        <div className="glass-card-static p-8 text-center">
          <AlertTriangle className="h-12 w-12 text-[--accent-warning] mx-auto mb-4" />
          <p className="text-[--text-secondary]">
            Convex backend unreachable. Check ATLAS_ADMIN_KEY in .env.local and
            that the prod deployment is up at avid-oyster-465.convex.cloud.
          </p>
        </div>
      </div>
    );
  }

  const noTrafficYet = data.llm.totalCalls === 0;
  const healthBadge =
    data.health === "healthy"
      ? {
          icon: CircleCheck,
          color: "stat-icon-green",
          label: "Healthy",
          note: noTrafficYet ? "Awaiting first LLM call" : "LLM proxy active",
        }
      : data.health === "idle"
        ? { icon: CircleAlert, color: "stat-icon-yellow", label: "Idle", note: "No LLM calls in last hour" }
        : { icon: CircleSlash, color: "stat-icon-red", label: "Stale", note: "No traffic in 24h" };
  const HealthIcon = healthBadge.icon;

  return (
    <div className="space-y-8">
      {/* Header + Health badge */}
      <div className="page-header">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="page-title">Dashboard</h1>
            <p className="page-subtitle">
              ATLAS admin overview &middot; production deployment{" "}
              <span className="font-mono text-xs">avid-oyster-465</span>
            </p>
          </div>
          <div className="flex items-center gap-3 bg-white/70 backdrop-blur rounded-xl px-4 py-2.5">
            <div className={`stat-icon ${healthBadge.color}`}>
              <HealthIcon className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-[--text-primary]">{healthBadge.label}</p>
              <p className="text-xs text-[--text-muted]">{healthBadge.note}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Top-line KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
        <KpiCard
          label="ATLAS Users"
          value={fmtN(data.accounts.total)}
          sub={`${data.accounts.active} active`}
          icon={Users}
          color="stat-icon-blue"
        />
        <KpiCard
          label="Active Sessions"
          value={fmtN(data.sessions.active)}
          sub={`${data.sessions.today} today`}
          icon={Activity}
          color="stat-icon-green"
        />
        <KpiCard
          label="Waitlist"
          value={fmtN(data.waitlist.total)}
          sub={`+${data.waitlist.last24h} in 24h`}
          icon={UserPlus}
          color="stat-icon-purple"
        />
        <KpiCard
          label="LLM Calls"
          value={fmtN(data.llm.totalCalls)}
          sub={`last: ${relTime(data.llm.lastCalledAt, data.now)}`}
          icon={Cpu}
          color="stat-icon-pink"
        />
        <KpiCard
          label="Credits Pool"
          value={fmtN(data.accounts.totalCreditsRemaining)}
          sub={`${fmtN(data.llm.totalCreditsCharged)} charged`}
          icon={DollarSign}
          color="stat-icon-orange"
        />
        <KpiCard
          label="Activity (7d)"
          value={data.activity.scanCapped ? `${fmtN(data.activity.last7d)}+` : fmtN(data.activity.last7d)}
          sub={`${data.activity.last24h} last 24h${data.activity.scanCapped ? " (capped)" : ""}`}
          icon={TrendingUp}
          color="stat-icon-yellow"
        />
        <KpiCard
          label="Store Items"
          value={fmtN(data.store.activeItems)}
          sub={`${data.store.totalInstalls} installs`}
          icon={Package}
          color="stat-icon-blue"
        />
        <KpiCard
          label="Recent Errors"
          value={fmtN(data.recentErrors.length)}
          sub={data.recentErrors.length === 0 ? "all clear" : "review below"}
          icon={AlertTriangle}
          color={data.recentErrors.length > 0 ? "stat-icon-red" : "stat-icon-green"}
        />
      </div>

      {/* Two-column: model usage + queues */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Top Models */}
        <div className="glass-card-static p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-semibold text-[--text-primary]">Top LLM Models</h2>
            <Link
              href="/dashboard/observability"
              className="text-sm font-medium text-[--accent-primary] hover:underline"
            >
              Full breakdown
            </Link>
          </div>
          {data.llm.topModels.length === 0 ? (
            <p className="text-[--text-muted] text-sm">
              No LLM calls recorded yet. Numbers will appear after the first request through{" "}
              <span className="font-mono">/api/llm/chat</span>.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-black/5 text-[--text-secondary]">
                    <th className="text-left py-2 px-3 font-semibold">Model</th>
                    <th className="text-right py-2 px-3 font-semibold">Calls</th>
                    <th className="text-right py-2 px-3 font-semibold">Credits</th>
                    <th className="text-right py-2 px-3 font-semibold">Last call</th>
                  </tr>
                </thead>
                <tbody>
                  {data.llm.topModels.map((m) => {
                    const pct = data.llm.totalCalls > 0
                      ? (m.count / data.llm.totalCalls) * 100
                      : 0;
                    return (
                      <tr key={m.model} className="border-b border-black/5 last:border-0">
                        <td className="py-2 px-3 font-mono text-xs">{m.model}</td>
                        <td className="py-2 px-3 text-right">
                          <span className="font-medium">{m.count.toLocaleString()}</span>
                          <span className="text-[--text-muted] ml-2">({pct.toFixed(1)}%)</span>
                        </td>
                        <td className="py-2 px-3 text-right">{m.creditsCharged.toFixed(2)}</td>
                        <td className="py-2 px-3 text-right text-[--text-muted]">
                          {relTime(m.lastCalledAt, data.now)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Queues */}
        <div className="space-y-4">
          <QueueCard
            title="Waitlist queue"
            value={data.waitlist.new}
            total={data.waitlist.total}
            href="/waitlist"
            color="bg-blue-50 text-blue-700"
            sub={`${data.waitlist.contacted} contacted · ${data.waitlist.accepted} accepted`}
            icon={Mail}
          />
          <QueueCard
            title="Pending developers"
            value={data.store.pendingDevelopers}
            total={data.store.totalDevelopers}
            href="/developers?status=pending"
            color="bg-purple-50 text-purple-700"
            sub={`${data.store.totalDevelopers} total devs`}
            icon={Code2}
          />
          <QueueCard
            title="Pending app reviews"
            value={data.store.pendingSubmissions}
            total={data.store.activeItems}
            href="/submissions?status=pending"
            color="bg-orange-50 text-orange-700"
            sub={`${data.store.activeItems} active items live`}
            icon={Clock}
          />
          <QueueCard
            title="Store downloads"
            value={data.store.totalInstalls}
            total={data.store.activeItems}
            href="/apps"
            color="bg-emerald-50 text-emerald-700"
            sub={`${data.store.activeItems} live items`}
            icon={Download}
          />
        </div>
      </div>

      {/* Plan distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="glass-card-static p-6">
          <h2 className="text-lg font-semibold text-[--text-primary] mb-5">
            Account distribution
          </h2>
          <div className="space-y-3">
            {Object.entries(data.accounts.planCounts).length === 0 ? (
              <p className="text-[--text-muted] text-sm">No accounts yet.</p>
            ) : (
              Object.entries(data.accounts.planCounts).map(([plan, count]) => {
                const pct = data.accounts.total > 0 ? (count / data.accounts.total) * 100 : 0;
                return (
                  <div key={plan}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="capitalize font-medium">{plan}</span>
                      <span className="text-[--text-muted]">
                        {count} ({pct.toFixed(0)}%)
                      </span>
                    </div>
                    <div className="h-2 bg-black/5 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-blue-500 to-purple-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="mt-5 pt-5 border-t border-black/5 grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-xs text-[--text-muted]">Active</p>
              <p className="text-lg font-bold text-green-600">{data.accounts.active}</p>
            </div>
            <div>
              <p className="text-xs text-[--text-muted]">Suspended</p>
              <p className="text-lg font-bold text-yellow-600">{data.accounts.suspended}</p>
            </div>
            <div>
              <p className="text-xs text-[--text-muted]">Blocked</p>
              <p className="text-lg font-bold text-red-600">{data.accounts.blocked}</p>
            </div>
          </div>
        </div>

        {/* Recent errors */}
        <div className="glass-card-static p-6">
          <h2 className="text-lg font-semibold text-[--text-primary] mb-5">
            Recent errors
          </h2>
          {data.recentErrors.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-[--text-muted]">
              <CircleCheck className="h-10 w-10 text-green-500 mb-2" />
              <p className="text-sm">No errors logged in the last 500 activity entries.</p>
            </div>
          ) : (
            <ul className="space-y-3 max-h-72 overflow-y-auto">
              {data.recentErrors.map((e) => (
                <li
                  key={e.id}
                  className="text-sm border-l-2 border-red-400 pl-3 py-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium capitalize">{e.type}</span>
                    <span className="text-xs text-[--text-muted]">
                      {relTime(e.timestamp, data.now)}
                    </span>
                  </div>
                  {e.metadata && (
                    <p className="text-xs text-[--text-muted] mt-0.5 font-mono break-all">
                      {e.metadata.slice(0, 140)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="stat-card-glass">
      <div className={`stat-icon ${color}`}>
        <Icon className="h-6 w-6" />
      </div>
      <div>
        <p className="stat-label">{label}</p>
        <p className="stat-value">{value}</p>
        {sub && <p className="text-xs text-[--text-muted] mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function QueueCard({
  title,
  value,
  total,
  href,
  color,
  sub,
  icon: Icon,
}: {
  title: string;
  value: number;
  total: number;
  href: string;
  color: string;
  sub: string;
  icon: React.ElementType;
}) {
  return (
    <Link
      href={href}
      className="block glass-card-static p-4 hover:shadow-md transition-shadow"
    >
      <div className="flex items-center justify-between">
        <div className={`p-2 rounded-lg ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
        <span className="text-2xl font-bold">{value.toLocaleString()}</span>
      </div>
      <p className="text-sm font-semibold mt-2 text-[--text-primary]">{title}</p>
      <p className="text-xs text-[--text-muted] mt-0.5">{sub}</p>
    </Link>
  );
}
