"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { storeProxy } from "@/lib/convex";
import type { ActivityLog } from "@/lib/types";
import {
  Download,
  Upload,
  Star,
  Check,
  User,
  Package,
  Trash2,
  Search,
  Filter,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Activity as ActivityIcon,
  AlertCircle,
  FileDown,
} from "lucide-react";

const activityIcons: Record<string, React.ElementType> = {
  install: Download,
  uninstall: Trash2,
  update: Upload,
  review: Star,
  submission: Package,
  approval: Check,
  registration: User,
};

const activityColors: Record<string, string> = {
  install: "bg-green-100 text-green-600",
  uninstall: "bg-red-100 text-red-600",
  update: "bg-blue-100 text-blue-600",
  review: "bg-yellow-100 text-yellow-600",
  submission: "bg-purple-100 text-purple-600",
  approval: "bg-emerald-100 text-emerald-600",
  registration: "bg-gray-100 text-gray-600",
};

const FILTERS = ["all", "install", "uninstall", "update", "review", "submission", "approval", "registration"];
const PAGE_SIZE = 25;

function relTime(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 0) return "in the future";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatActivityMessage(type: string, m: Record<string, unknown>): string {
  switch (type) {
    case "install":
      return `Installed "${m.itemName || "an app"}"`;
    case "uninstall":
      return `Uninstalled "${m.itemName || "an app"}"`;
    case "update":
      return `Updated "${m.itemName || "app"}" to v${m.version || "?"}`;
    case "review":
      return `Review on "${m.itemName || "an app"}" (${m.rating || "?"}★)`;
    case "submission":
      return `New submission: "${m.name || "Unknown"}"`;
    case "approval":
      return `"${m.name || "Item"}" was ${m.action || "approved"}`;
    case "registration":
      return `Developer registered: ${m.email || "Unknown"}`;
    default:
      return `Activity: ${type}`;
  }
}

function isErrorLog(metadata: string | null | undefined): boolean {
  if (!metadata) return false;
  try {
    const m = JSON.parse(metadata);
    return m.error || m.status === "error" || m.status === "failed";
  } catch {
    return metadata.toLowerCase().includes("error");
  }
}

function csvEscape(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(logs: ActivityLog[]) {
  const header = ["timestamp", "type", "userId", "developerId", "itemId", "adminId", "metadata"];
  const rows = logs.map((l) =>
    [
      new Date(l.timestamp).toISOString(),
      l.type,
      l.userId ?? "",
      l.developerId ?? "",
      l.itemId ?? "",
      l.adminId ?? "",
      l.metadata ?? "",
    ]
      .map(csvEscape)
      .join(","),
  );
  const csv = [header.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `atlas-activity-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function ActivityPage() {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await storeProxy<ActivityLog[]>("query", "store/admins:getActivityLogs", {
        type: typeFilter === "all" ? undefined : typeFilter,
        limit: 500,
      });
      setLogs(result);
      setPage(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [typeFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs.filter((l) => {
      if (errorsOnly && !isErrorLog(l.metadata)) return false;
      if (!q) return true;
      const hay = [
        l.type,
        l.userId,
        l.developerId,
        l.itemId,
        l.adminId,
        l.metadata,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [logs, search, errorsOnly]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageStart = page * PAGE_SIZE;
  const pageLogs = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const stats = useMemo(() => {
    const total = filtered.length;
    const errors = filtered.filter((l) => isErrorLog(l.metadata)).length;
    const byType: Record<string, number> = {};
    for (const l of filtered) byType[l.type] = (byType[l.type] || 0) + 1;
    return { total, errors, byType };
  }, [filtered]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">Activity Logs</h1>
          <p className="page-subtitle">All store activity, last 500 events</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="btn-glass btn-glass-secondary flex items-center gap-2">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            onClick={() => downloadCsv(filtered)}
            disabled={filtered.length === 0}
            className="btn-glass btn-glass-primary flex items-center gap-2 disabled:opacity-50"
          >
            <FileDown className="h-4 w-4" /> Export CSV
          </button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        <div className="stat-card-glass">
          <div className="stat-icon stat-icon-blue">
            <ActivityIcon className="h-5 w-5" />
          </div>
          <div>
            <p className="stat-label">Total</p>
            <p className="stat-value text-xl">{stats.total}</p>
          </div>
        </div>
        <div className="stat-card-glass">
          <div className="stat-icon stat-icon-red">
            <AlertCircle className="h-5 w-5" />
          </div>
          <div>
            <p className="stat-label">Errors</p>
            <p className="stat-value text-xl">{stats.errors}</p>
          </div>
        </div>
        {["install", "submission", "review", "approval"].map((t) => (
          <div key={t} className="stat-card-glass">
            <div className={`stat-icon ${activityColors[t]?.replace("100", "50").replace("600", "500") ?? "stat-icon-blue"}`}>
              {(() => { const I = activityIcons[t] || Package; return <I className="h-5 w-5" />; })()}
            </div>
            <div>
              <p className="stat-label capitalize">{t}</p>
              <p className="stat-value text-xl">{stats.byType[t] || 0}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center">
        <div className="flex flex-wrap gap-2 items-center">
          <Filter className="h-4 w-4 text-[--text-muted]" />
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setTypeFilter(f)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${
                typeFilter === f
                  ? "bg-primary-600 text-white"
                  : "bg-white text-gray-700 hover:bg-gray-50 border border-gray-200"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="flex-1 flex items-center gap-3 ml-auto">
          <div className="relative flex-1 max-w-md ml-auto">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[--text-muted]" />
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="Search type, user, item, metadata…"
              className="input-glass pl-10 w-full"
            />
          </div>
          <label className="flex items-center gap-2 text-sm whitespace-nowrap">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(e) => {
                setErrorsOnly(e.target.checked);
                setPage(0);
              }}
            />
            Errors only
          </label>
        </div>
      </div>

      {/* Logs */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {error ? (
          <div className="p-8 text-center text-red-600">{error}</div>
        ) : loading ? (
          <div className="p-8 text-center text-gray-500">Loading…</div>
        ) : pageLogs.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {search ? "No logs match this search." : "No activity found."}
          </div>
        ) : (
          <div className="divide-y divide-gray-200">
            {pageLogs.map((log) => {
              const Icon = activityIcons[log.type] || Package;
              const colorClass = activityColors[log.type] || "bg-gray-100 text-gray-600";
              let parsedMeta: Record<string, unknown> = {};
              if (log.metadata) {
                try {
                  parsedMeta = JSON.parse(log.metadata);
                } catch {
                  parsedMeta = { raw: log.metadata };
                }
              }
              const isOpen = !!expanded[log._id];
              const isErr = isErrorLog(log.metadata);

              return (
                <div key={log._id} className="hover:bg-gray-50">
                  <button
                    onClick={() => setExpanded({ ...expanded, [log._id]: !isOpen })}
                    className="w-full text-left p-4 flex items-start gap-4"
                  >
                    <div className={`p-2 rounded-lg ${colorClass} flex-shrink-0`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-gray-900">
                          {formatActivityMessage(log.type, parsedMeta)}
                        </p>
                        {isErr && (
                          <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-red-100 text-red-700">
                            ERROR
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        {relTime(log.timestamp)} &middot;{" "}
                        <span className="font-mono">{new Date(log.timestamp).toLocaleString()}</span>
                        {log.userId && <> &middot; user: <span className="font-mono">{log.userId.slice(0, 12)}…</span></>}
                      </p>
                    </div>
                    {log.metadata && (
                      isOpen ? <ChevronDown className="h-4 w-4 text-gray-400 mt-2" /> : <ChevronRight className="h-4 w-4 text-gray-400 mt-2" />
                    )}
                  </button>
                  {isOpen && log.metadata && (
                    <div className="px-4 pb-4 pl-16">
                      <div className="bg-gray-50 rounded-lg p-3 text-xs font-mono text-gray-700 overflow-auto max-h-48 whitespace-pre-wrap break-all">
                        {JSON.stringify(parsedMeta, null, 2)}
                      </div>
                      {(log.userId || log.developerId || log.itemId || log.adminId) && (
                        <div className="mt-2 flex flex-wrap gap-2 text-xs">
                          {log.userId && <Pill label="user" value={log.userId} />}
                          {log.developerId && <Pill label="dev" value={log.developerId} />}
                          {log.itemId && <Pill label="item" value={log.itemId} />}
                          {log.adminId && <Pill label="admin" value={log.adminId} />}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {pageCount > 1 && (
          <div className="flex items-center justify-between p-4 border-t border-gray-200 text-sm">
            <span className="text-gray-500">
              Page {page + 1} of {pageCount} ({filtered.length} matching events)
            </span>
            <div className="flex gap-2">
              <button
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
                className="px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                disabled={page >= pageCount - 1}
                onClick={() => setPage(page + 1)}
                className="px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-gray-100 text-gray-700">
      <span className="font-semibold uppercase tracking-wide text-[10px]">{label}</span>
      <span className="font-mono text-[10px]">{value.slice(0, 18)}…</span>
    </span>
  );
}
