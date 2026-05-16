"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  RefreshCw,
  Filter,
  ChevronDown,
  ChevronRight,
  Clock,
} from "lucide-react";

interface ErrorRow {
  _id: string;
  source: string;
  type: string;
  message: string;
  metadata?: string;
  accountId?: string;
  otplessUserId?: string;
  ipAddress?: string;
  severity: string;
  timestamp: number;
}

const SOURCES = ["", "llm_proxy", "auth", "session", "waitlist", "store", "admin", "system", "otpless"];
const SEVERITIES = ["", "error", "warning", "info"];

const WINDOWS = [
  { label: "Last 1h", ms: 60 * 60_000 },
  { label: "Last 24h", ms: 24 * 60 * 60_000 },
  { label: "Last 7d", ms: 7 * 24 * 60 * 60_000 },
  { label: "Last 30d", ms: 30 * 24 * 60 * 60_000 },
];

const severityColors: Record<string, string> = {
  error: "bg-red-100 text-red-700",
  warning: "bg-amber-100 text-amber-700",
  info: "bg-blue-100 text-blue-700",
};

const sourceColors: Record<string, string> = {
  llm_proxy: "bg-amber-50 text-amber-700",
  auth: "bg-purple-50 text-purple-700",
  session: "bg-indigo-50 text-indigo-700",
  waitlist: "bg-pink-50 text-pink-700",
  store: "bg-blue-50 text-blue-700",
  admin: "bg-gray-100 text-gray-700",
  system: "bg-slate-100 text-slate-700",
  otpless: "bg-emerald-50 text-emerald-700",
};

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
  return `${d}d ago`;
}

export default function ErrorLogsPage() {
  const [rows, setRows] = useState<ErrorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowMs, setWindowMs] = useState<number>(24 * 60 * 60_000);
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [severityFilter, setSeverityFilter] = useState<string>("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set("sinceMs", String(windowMs));
      qs.set("limit", "200");
      if (sourceFilter) qs.set("source", sourceFilter);
      if (severityFilter) qs.set("severity", severityFilter);

      const resp = await fetch(`/api/error-logs?${qs.toString()}`, { cache: "no-store" });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`${resp.status}: ${text.slice(0, 200)}`);
      }
      const data = (await resp.json()) as { entries: ErrorRow[] };
      setRows(data.entries ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [windowMs, sourceFilter, severityFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const byKind = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.source] = (acc[r.source] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <AlertTriangle className="h-6 w-6 text-red-500" /> Error Logs
          </h1>
          <p className="text-gray-600 text-sm">Backend errors across all subsystems</p>
        </div>
        <button
          onClick={load}
          className="flex items-center px-3 py-2 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 text-sm"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm p-4 flex flex-wrap items-center gap-3">
        <Filter className="h-4 w-4 text-gray-400" />
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.ms}
              onClick={() => setWindowMs(w.ms)}
              className={`px-3 py-1 text-xs rounded ${w.ms === windowMs ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-700"}`}
            >
              {w.label}
            </button>
          ))}
        </div>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="text-sm px-2 py-1 border border-gray-200 rounded"
        >
          {SOURCES.map((s) => (
            <option key={s || "all"} value={s}>
              {s ? `source: ${s}` : "source: all"}
            </option>
          ))}
        </select>
        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value)}
          className="text-sm px-2 py-1 border border-gray-200 rounded"
        >
          {SEVERITIES.map((s) => (
            <option key={s || "all"} value={s}>
              {s ? `severity: ${s}` : "severity: all"}
            </option>
          ))}
        </select>
      </div>

      {/* Source distribution */}
      {Object.keys(byKind).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(byKind)
            .sort((a, b) => b[1] - a[1])
            .map(([src, count]) => (
              <button
                key={src}
                onClick={() => setSourceFilter(src === sourceFilter ? "" : src)}
                className={`px-3 py-1 rounded-full text-xs ${sourceColors[src] ?? "bg-gray-100 text-gray-700"} ${src === sourceFilter ? "ring-2 ring-offset-1 ring-blue-400" : ""}`}
              >
                {src} <span className="font-semibold">{count}</span>
              </button>
            ))}
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {error && (
          <div className="p-4 bg-red-50 border-b border-red-100 text-red-700 text-sm">
            {error}
          </div>
        )}
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No errors in this window. (That's a good sign.)
          </div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
              <tr>
                <th className="px-3 py-2 text-left w-8"></th>
                <th className="px-3 py-2 text-left">Time</th>
                <th className="px-3 py-2 text-left">Source</th>
                <th className="px-3 py-2 text-left">Severity</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <Fragment key={r._id}>
                  <tr className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => toggleExpand(r._id)} className="text-gray-400 hover:text-gray-700">
                        {expanded.has(r._id) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <Clock className="h-3 w-3 text-gray-400" />
                        {relTime(r.timestamp)}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 text-xs rounded-full ${sourceColors[r.source] ?? "bg-gray-100 text-gray-700"}`}>
                        {r.source}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 text-xs rounded-full ${severityColors[r.severity] ?? "bg-gray-100 text-gray-700"}`}>
                        {r.severity}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-700">{r.type}</td>
                    <td className="px-3 py-2 text-gray-700 truncate max-w-md">{r.message}</td>
                  </tr>
                  {expanded.has(r._id) && (
                    <tr className="bg-gray-50">
                      <td colSpan={6} className="px-6 py-3 text-xs">
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                          <div><span className="text-gray-500">id:</span> <span className="font-mono">{r._id}</span></div>
                          <div><span className="text-gray-500">timestamp:</span> {new Date(r.timestamp).toISOString()}</div>
                          <div><span className="text-gray-500">accountId:</span> <span className="font-mono">{r.accountId ?? "—"}</span></div>
                          <div><span className="text-gray-500">otplessUserId:</span> <span className="font-mono">{r.otplessUserId ?? "—"}</span></div>
                          <div><span className="text-gray-500">ipAddress:</span> <span className="font-mono">{r.ipAddress ?? "—"}</span></div>
                          <div className="col-span-2"><span className="text-gray-500">message:</span> {r.message}</div>
                          {r.metadata && (
                            <div className="col-span-2 mt-1">
                              <span className="text-gray-500">metadata:</span>
                              <pre className="mt-1 p-2 bg-white border border-gray-200 rounded text-xs overflow-x-auto">{r.metadata}</pre>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
