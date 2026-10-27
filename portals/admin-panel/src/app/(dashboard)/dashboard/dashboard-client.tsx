"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  Wifi,
  WifiOff,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";

// Cost-conscious polling cadence — each interval is independent so cheap signals
// stay fresh while the heavy aggregation only runs on a slow cycle.
const CONNECTIVITY_PROBE_MS = 30_000;   // /api/auth/me — same-origin only, no Convex hit
const HEARTBEAT_MS = 60_000;            // /api/dashboard/heartbeat — ~3 Convex reads
const FULL_REFRESH_MS = 5 * 60_000;     // /api/dashboard/overview — full aggregation, ~30k reads
const FETCH_TIMEOUT_MS = 8_000;

type Connectivity = "online" | "offline" | "checking";

interface Heartbeat {
  now: number;
  health: "healthy" | "idle" | "stale";
  errorCount: number;
  lastErrorAt: number | null;
  lastLlmCallAt: number | null;
  totalLlmCalls: number;
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

async function fetchWithTimeout(url: string, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { cache: "no-store", signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default function DashboardClient({
  initial,
  initialFetchedAt,
}: {
  initial: SystemOverview | null;
  initialFetchedAt: number;
}) {
  const [data, setData] = useState<SystemOverview | null>(initial);
  const [lastFullFetchedAt, setLastFullFetchedAt] = useState<number>(initialFetchedAt);
  const [heartbeat, setHeartbeat] = useState<Heartbeat | null>(null);
  const [connectivity, setConnectivity] = useState<Connectivity>(initial ? "online" : "checking");
  const [refreshingFull, setRefreshingFull] = useState(false);
  // Live "x ago" labels update each second without re-fetching.
  const [tick, setTick] = useState(Date.now());

  // --- Connectivity probe (no Convex) ---------------------------------------
  // Hits /api/auth/me — already exists, light, server-only Next.js. Verifies
  // browser↔panel reachability. We don't read the body, just the status.
  const probeConnectivity = useCallback(async () => {
    try {
      const resp = await fetchWithTimeout("/api/auth/me", 5_000);
      // 200 or 401 both prove the round-trip is alive. Anything else = degraded.
      if (resp.status === 200 || resp.status === 401) {
        setConnectivity("online");
      } else {
        setConnectivity("offline");
      }
    } catch {
      setConnectivity(
        typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "offline",
      );
    }
  }, []);

  // --- Heartbeat (cheap Convex) ---------------------------------------------
  const pollHeartbeat = useCallback(async () => {
    try {
      const resp = await fetchWithTimeout("/api/dashboard/heartbeat");
      if (!resp.ok) {
        // Backend reachable enough to answer but heartbeat failed — treat as
        // "online" connectivity-wise (the request itself round-tripped), but
        // don't update the heartbeat data.
        return;
      }
      const json = await resp.json();
      if (json?.data) {
        setHeartbeat(json.data);
        setConnectivity("online");
      }
    } catch {
      // Network failure → let the probe decide connectivity; don't flip on
      // a single heartbeat timeout to avoid flicker.
    }
  }, []);

  // --- Full refresh (heavy, slow cadence + manual) --------------------------
  const refreshFull = useCallback(async (silent = false) => {
    if (!silent) setRefreshingFull(true);
    try {
      const resp = await fetchWithTimeout("/api/dashboard/overview", 15_000);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (json?.data) {
        setData(json.data);
        setLastFullFetchedAt(json.fetchedAt ?? Date.now());
        setConnectivity("online");
      }
    } catch {
      // Don't flip connectivity here — the connectivity probe is the source
      // of truth. A failed full-refresh just means the user sees stale data.
    } finally {
      if (!silent) setRefreshingFull(false);
    }
  }, []);

  // Initial fast-path: kick a heartbeat immediately so the badge updates
  // within a second of mount instead of waiting a full HEARTBEAT_MS cycle.
  useEffect(() => {
    pollHeartbeat();
    probeConnectivity();
  }, [pollHeartbeat, probeConnectivity]);

  // Independent intervals — paused while the tab is hidden so background tabs
  // cost zero. Resume + immediate probe on visibility return.
  useEffect(() => {
    let probeId: ReturnType<typeof setInterval> | null = null;
    let hbId: ReturnType<typeof setInterval> | null = null;
    let fullId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (probeId === null) probeId = setInterval(probeConnectivity, CONNECTIVITY_PROBE_MS);
      if (hbId === null) hbId = setInterval(pollHeartbeat, HEARTBEAT_MS);
      if (fullId === null) fullId = setInterval(() => refreshFull(true), FULL_REFRESH_MS);
    };
    const stop = () => {
      if (probeId !== null) { clearInterval(probeId); probeId = null; }
      if (hbId !== null) { clearInterval(hbId); hbId = null; }
      if (fullId !== null) { clearInterval(fullId); fullId = null; }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        start();
        probeConnectivity();
        pollHeartbeat();
        // If we've been hidden for longer than the heavy cadence, refresh.
        if (Date.now() - lastFullFetchedAt > FULL_REFRESH_MS) refreshFull(true);
      } else {
        stop();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [pollHeartbeat, probeConnectivity, refreshFull, lastFullFetchedAt]);

  // Browser-level online/offline — instant flip, no network call needed.
  useEffect(() => {
    const onOnline = () => {
      setConnectivity("checking");
      probeConnectivity();
      pollHeartbeat();
    };
    const onOffline = () => setConnectivity("offline");
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    if (typeof navigator !== "undefined" && !navigator.onLine) setConnectivity("offline");
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [probeConnectivity, pollHeartbeat]);

  // 1Hz tick so relTime labels keep counting up between fetches.
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!data) {
    return (
      <div className="space-y-6">
        <div className="page-header flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="page-title">Dashboard</h1>
            <p className="page-subtitle">Could not load system overview</p>
          </div>
          <ConnectivityPill state={connectivity} lastFetchedAt={lastFullFetchedAt} now={tick} />
        </div>
        <div className="glass-card-static p-8 text-center">
          <AlertTriangle className="h-12 w-12 text-[--accent-warning] mx-auto mb-4" />
          <p className="text-[--text-secondary]">
            Convex backend unreachable. Check ATLAS_ADMIN_KEY in .env.local and that the prod
            deployment is up at avid-finch-726.convex.cloud.
          </p>
          <button
            onClick={() => refreshFull(false)}
            disabled={refreshingFull}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${refreshingFull ? "animate-spin" : ""}`} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Live signals override the snapshot's value where we have them.
  const liveHealth = heartbeat?.health ?? data.health;
  const liveErrorCount = heartbeat?.errorCount ?? data.recentErrors.length;
  const liveLastLlmCallAt = heartbeat?.lastLlmCallAt ?? data.llm.lastCalledAt;
  const liveTotalLlmCalls = heartbeat?.totalLlmCalls ?? data.llm.totalCalls;
  const noTrafficYet = liveTotalLlmCalls === 0;

  const healthBadge =
    liveHealth === "healthy"
      ? {
          icon: CircleCheck,
          color: "stat-icon-green",
          label: "Healthy",
          note: noTrafficYet ? "Awaiting first LLM call" : "LLM proxy active",
        }
      : liveHealth === "idle"
        ? { icon: CircleAlert, color: "stat-icon-yellow", label: "Idle", note: "No LLM calls in last hour" }
        : { icon: CircleSlash, color: "stat-icon-red", label: "Stale", note: "No traffic in 24h" };
  const HealthIcon = healthBadge.icon;
  const now = tick;

  return (
    <div className="space-y-8">
      <div className="page-header">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="page-title">Dashboard</h1>
            <p className="page-subtitle">
              Bhai admin overview &middot; production deployment{" "}
              <span className="font-mono text-xs">avid-finch-726</span>
            </p>
            <p className="text-xs text-[--text-muted] mt-1">
              Live signals every {Math.floor(HEARTBEAT_MS / 1000)}s &middot; full refresh every{" "}
              {Math.floor(FULL_REFRESH_MS / 60_000)}m &middot; last full update {relTime(lastFullFetchedAt, now)}
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <ConnectivityPill
              state={connectivity}
              lastFetchedAt={heartbeat?.now ?? lastFullFetchedAt}
              now={tick}
              onRefresh={() => refreshFull(false)}
              refreshing={refreshingFull}
            />
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
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
        <KpiCard
          label="Bhai Users"
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
          value={fmtN(liveTotalLlmCalls)}
          sub={`last: ${relTime(liveLastLlmCallAt, now)}`}
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
          value={fmtN(liveErrorCount)}
          sub={liveErrorCount === 0 ? "all clear" : "review below"}
          icon={AlertTriangle}
          color={liveErrorCount > 0 ? "stat-icon-red" : "stat-icon-green"}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
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
                          {relTime(m.lastCalledAt, now)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="glass-card-static p-6">
          <h2 className="text-lg font-semibold text-[--text-primary] mb-5">Account distribution</h2>
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

        <div className="glass-card-static p-6">
          <h2 className="text-lg font-semibold text-[--text-primary] mb-5">Recent errors</h2>
          {data.recentErrors.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-[--text-muted]">
              <CircleCheck className="h-10 w-10 text-green-500 mb-2" />
              <p className="text-sm">No errors logged in the last 500 activity entries.</p>
            </div>
          ) : (
            <ul className="space-y-3 max-h-72 overflow-y-auto">
              {data.recentErrors.map((e) => (
                <li key={e.id} className="text-sm border-l-2 border-red-400 pl-3 py-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium capitalize">{e.type}</span>
                    <span className="text-xs text-[--text-muted]">{relTime(e.timestamp, now)}</span>
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

function ConnectivityPill({
  state,
  lastFetchedAt,
  now,
  onRefresh,
  refreshing,
}: {
  state: Connectivity;
  lastFetchedAt: number;
  now: number;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const elapsedS = Math.max(0, Math.floor((now - lastFetchedAt) / 1000));
  const elapsedLabel = elapsedS < 60 ? `${elapsedS}s ago` : `${Math.floor(elapsedS / 60)}m ago`;

  const cfg =
    state === "online"
      ? {
          Icon: Wifi,
          dotClass: "bg-emerald-500",
          ringClass: "ring-emerald-200",
          textClass: "text-emerald-700",
          bgClass: "bg-emerald-50",
          label: "Online",
          sub: `Signal ${elapsedLabel}`,
        }
      : state === "checking"
        ? {
            Icon: RefreshCw,
            dotClass: "bg-amber-400",
            ringClass: "ring-amber-200",
            textClass: "text-amber-700",
            bgClass: "bg-amber-50",
            label: "Checking…",
            sub: "Verifying connection",
          }
        : {
            Icon: WifiOff,
            dotClass: "bg-red-500",
            ringClass: "ring-red-200",
            textClass: "text-red-700",
            bgClass: "bg-red-50",
            label: "Offline",
            sub: lastFetchedAt ? `Last signal ${elapsedLabel}` : "No connection",
          };

  const { Icon, dotClass, ringClass, textClass, bgClass, label, sub } = cfg;

  return (
    <div
      className={`flex items-center gap-3 ${bgClass} rounded-xl px-4 py-2.5 ring-1 ${ringClass}`}
      title={state === "offline" ? "Browser offline or admin panel unreachable" : undefined}
    >
      <div className="relative">
        <Icon className={`h-5 w-5 ${textClass} ${state === "checking" ? "animate-spin" : ""}`} />
        <span
          className={`absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full ${dotClass} ${
            state === "online" ? "animate-pulse" : ""
          }`}
        />
      </div>
      <div className="leading-tight">
        <p className={`text-sm font-semibold ${textClass}`}>{label}</p>
        <p className="text-[11px] text-[--text-muted]">{sub}</p>
      </div>
      {onRefresh && (
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="ml-1 p-1 rounded-md hover:bg-black/5 disabled:opacity-50"
          title="Refresh full overview now"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""} ${textClass}`} />
        </button>
      )}
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
  total: _total,
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
    <Link href={href} className="block glass-card-static p-4 hover:shadow-md transition-shadow">
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
