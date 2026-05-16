"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  Zap,
  RefreshCw,
  Search,
  Filter,
  ChevronDown,
  ChevronRight,
  Image as ImageIcon,
  AlertCircle,
  Clock,
} from "lucide-react";

interface LlmCallRow {
  _id: string;
  accountId?: string;
  otplessUserId?: string;
  model: string;
  status: "success" | "failed" | "rejected";
  credits: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  errorMessage?: string;
  hasMedia?: boolean;
  timestamp: number;
}

interface LlmStats {
  windowMs: number;
  scanCapped: boolean;
  totalCalls: number;
  successes: number;
  failures: number;
  rejections: number;
  successRate: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  perModel: Array<{
    model: string;
    calls: number;
    successRate: number;
    failures: number;
    rejections: number;
    avgLatencyMs: number;
    creditsCharged: number;
  }>;
}

const WINDOWS = [
  { label: "Last 1h", ms: 60 * 60_000 },
  { label: "Last 24h", ms: 24 * 60 * 60_000 },
  { label: "Last 7d", ms: 7 * 24 * 60 * 60_000 },
  { label: "Last 30d", ms: 30 * 24 * 60 * 60_000 },
];

const STATUSES: Array<{ value: "" | "success" | "failed" | "rejected"; label: string }> = [
  { value: "", label: "All" },
  { value: "success", label: "Success" },
  { value: "failed", label: "Failed" },
  { value: "rejected", label: "Rejected" },
];

const statusColors: Record<string, string> = {
  success: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
  rejected: "bg-amber-100 text-amber-700",
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

function fmtN(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  return new Intl.NumberFormat().format(n);
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtMs(n: number): string {
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

export default function LlmLogsPage() {
  const [rows, setRows] = useState<LlmCallRow[]>([]);
  const [stats, setStats] = useState<LlmStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowMs, setWindowMs] = useState<number>(24 * 60 * 60_000);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [modelFilter, setModelFilter] = useState<string>("");
  const [searchUser, setSearchUser] = useState<string>("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set("sinceMs", String(windowMs));
      qs.set("limit", "200");
      if (statusFilter) qs.set("status", statusFilter);
      if (modelFilter) qs.set("model", modelFilter);

      const [logsResp, statsResp] = await Promise.allSettled([
        fetch(`/api/llm-logs?${qs.toString()}`, { cache: "no-store" }),
        fetch(`/api/llm-logs/stats?sinceMs=${windowMs}`, { cache: "no-store" }),
      ]);

      if (logsResp.status === "fulfilled" && logsResp.value.ok) {
        const data = (await logsResp.value.json()) as { entries: LlmCallRow[] };
        setRows(data.entries ?? []);
      } else if (logsResp.status === "fulfilled") {
        const text = await logsResp.value.text();
        throw new Error(`logs ${logsResp.value.status}: ${text.slice(0, 100)}`);
      }
      if (statsResp.status === "fulfilled" && statsResp.value.ok) {
        const data = (await statsResp.value.json()) as { stats: LlmStats };
        setStats(data.stats);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [windowMs, statusFilter, modelFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!searchUser.trim()) return rows;
    const q = searchUser.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (r.otplessUserId ?? "").toLowerCase().includes(q) ||
        (r.accountId ?? "").toLowerCase().includes(q),
    );
  }, [rows, searchUser]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Zap className="h-6 w-6 text-amber-500" /> LLM Logs
          </h1>
          <p className="text-gray-600 text-sm">Per-call audit trail for /api/llm/chat</p>
        </div>
        <button
          onClick={load}
          className="flex items-center px-3 py-2 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 text-sm"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {/* Stats strip */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          <StatTile label="Total calls" value={fmtN(stats.totalCalls)} sub={stats.scanCapped ? "5000+ (capped)" : ""} />
          <StatTile label="Success rate" value={fmtPct(stats.successRate)} sub={`${fmtN(stats.successes)} / ${fmtN(stats.totalCalls)}`} ok={stats.successRate >= 0.95} />
          <StatTile label="Failures" value={fmtN(stats.failures)} bad={stats.failures > 0} />
          <StatTile label="P50 latency" value={fmtMs(stats.latencyP50)} />
          <StatTile label="P95 latency" value={fmtMs(stats.latencyP95)} bad={stats.latencyP95 > 8000} />
          <StatTile label="P99 latency" value={fmtMs(stats.latencyP99)} bad={stats.latencyP99 > 15000} />
        </div>
      )}

      {/* Per-model breakdown */}
      {stats && stats.perModel.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b text-sm font-semibold text-gray-700">Per-model breakdown ({stats.perModel.length} models)</div>
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Model</th>
                <th className="px-4 py-2 text-right">Calls</th>
                <th className="px-4 py-2 text-right">Success</th>
                <th className="px-4 py-2 text-right">Avg latency</th>
                <th className="px-4 py-2 text-right">Credits</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-sm">
              {stats.perModel.map((m) => (
                <tr key={m.model} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono text-xs">{m.model}</td>
                  <td className="px-4 py-2 text-right">{fmtN(m.calls)}</td>
                  <td className={`px-4 py-2 text-right ${m.successRate < 0.9 ? "text-red-600" : "text-emerald-600"}`}>
                    {fmtPct(m.successRate)}
                  </td>
                  <td className="px-4 py-2 text-right">{fmtMs(m.avgLatencyMs)}</td>
                  <td className="px-4 py-2 text-right">{fmtN(m.creditsCharged)}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => setModelFilter(m.model === modelFilter ? "" : m.model)}
                      className={`text-xs px-2 py-0.5 rounded ${m.model === modelFilter ? "bg-blue-100 text-blue-700" : "bg-gray-100 hover:bg-gray-200 text-gray-700"}`}
                    >
                      {m.model === modelFilter ? "Clear filter" : "Filter"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Filter row */}
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
        <div className="flex gap-1">
          {STATUSES.map((s) => (
            <button
              key={s.value}
              onClick={() => setStatusFilter(s.value)}
              className={`px-3 py-1 text-xs rounded ${s.value === statusFilter ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-700"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 flex-1 min-w-[200px]">
          <Search className="h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Filter by user id or account id"
            value={searchUser}
            onChange={(e) => setSearchUser(e.target.value)}
            className="text-sm px-2 py-1 border border-gray-200 rounded flex-1"
          />
        </div>
        {modelFilter && (
          <div className="text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded flex items-center gap-1">
            model: <span className="font-mono">{modelFilter}</span>
            <button onClick={() => setModelFilter("")} className="ml-1 hover:text-blue-900">×</button>
          </div>
        )}
      </div>

      {/* Logs table */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {error && (
          <div className="p-4 bg-red-50 border-b border-red-100 text-red-700 text-sm flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No calls in this window. Trigger an LLM call from the client to populate.
          </div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
              <tr>
                <th className="px-3 py-2 text-left w-8"></th>
                <th className="px-3 py-2 text-left">Time</th>
                <th className="px-3 py-2 text-left">User</th>
                <th className="px-3 py-2 text-left">Model</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-right">Latency</th>
                <th className="px-3 py-2 text-right">Credits</th>
                <th className="px-3 py-2 text-right">Tokens</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((r) => (
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
                    <td className="px-3 py-2 font-mono text-xs text-gray-700">
                      {(r.otplessUserId ?? r.accountId ?? "—").slice(0, 18)}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs flex items-center gap-1">
                      {r.model}
                      {r.hasMedia && <ImageIcon className="h-3 w-3 text-purple-500" />}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 text-xs rounded-full ${statusColors[r.status] ?? "bg-gray-100 text-gray-700"}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-gray-700">{fmtMs(r.latencyMs)}</td>
                    <td className="px-3 py-2 text-right text-gray-700">{r.credits}</td>
                    <td className="px-3 py-2 text-right text-gray-500 text-xs">
                      {r.inputTokens || r.outputTokens
                        ? `${fmtN(r.inputTokens)} / ${fmtN(r.outputTokens)}`
                        : "—"}
                    </td>
                  </tr>
                  {expanded.has(r._id) && (
                    <tr className="bg-gray-50">
                      <td colSpan={8} className="px-6 py-3 text-xs">
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                          <div><span className="text-gray-500">id:</span> <span className="font-mono">{r._id}</span></div>
                          <div><span className="text-gray-500">timestamp:</span> {new Date(r.timestamp).toISOString()}</div>
                          <div><span className="text-gray-500">accountId:</span> <span className="font-mono">{r.accountId ?? "—"}</span></div>
                          <div><span className="text-gray-500">otplessUserId:</span> <span className="font-mono">{r.otplessUserId ?? "—"}</span></div>
                          {r.errorMessage && (
                            <div className="col-span-2 text-red-700">
                              <span className="text-gray-500">error:</span> <span className="font-mono">{r.errorMessage}</span>
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

function StatTile({
  label,
  value,
  sub,
  ok,
  bad,
}: {
  label: string;
  value: string;
  sub?: string;
  ok?: boolean;
  bad?: boolean;
}) {
  const valueColor = bad ? "text-red-600" : ok ? "text-emerald-600" : "text-gray-900";
  return (
    <div className="bg-white rounded-xl shadow-sm p-4">
      <div className="text-xs text-gray-500 uppercase">{label}</div>
      <div className={`text-2xl font-bold ${valueColor}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}
