"use client";

import { useEffect, useState, useCallback } from "react";
import type {
  WaitlistEntry,
  WaitlistStats,
  WaitlistListResponse,
  WaitlistStatus,
} from "@/lib/types";

// Same-origin proxies — client components can't read ATLAS_ADMIN_KEY,
// so the /api/waitlist/* Next.js routes (server-side) hold the key and
// forward to Convex's admin-gated endpoints. See src/app/api/waitlist/*.
async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!resp.ok) {
    let msg = `${resp.status}`;
    try {
      const data = await resp.json();
      if (data?.error) msg = data.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await resp.json()) as T;
}
import {
  Check,
  X,
  MessageSquare,
  Trash2,
  Mail,
  Download,
  RefreshCw,
} from "lucide-react";

const STATUS_FILTERS: Array<WaitlistStatus | "all"> = [
  "new",
  "contacted",
  "accepted",
  "rejected",
  "all",
];

const statusColors: Record<WaitlistStatus, string> = {
  new: "bg-blue-100 text-blue-800",
  contacted: "bg-yellow-100 text-yellow-800",
  accepted: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

function csvEscape(value: unknown): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(entries: WaitlistEntry[]): void {
  const header = [
    "submittedAt",
    "firstName",
    "lastName",
    "email",
    "role",
    "company",
    "useCase",
    "status",
    "adminNotes",
    "ipAddress",
    "referrer",
  ];
  const rows = entries.map((e) =>
    [
      new Date(e.submittedAt).toISOString(),
      e.firstName,
      e.lastName,
      e.email,
      e.role,
      e.company ?? "",
      e.useCase,
      e.status,
      e.adminNotes ?? "",
      e.ipAddress ?? "",
      e.referrer ?? "",
    ]
      .map(csvEscape)
      .join(","),
  );
  const csv = [header.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  link.href = url;
  link.download = `atlas-waitlist-${ts}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function WaitlistPage() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [stats, setStats] = useState<WaitlistStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] =
    useState<WaitlistStatus | "all">("new");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (status: WaitlistStatus | "all") => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (status !== "all") qs.set("status", status);
      qs.set("limit", "200");
      // Render whichever half succeeds — see users/page.tsx for rationale.
      const [listR, statsR] = await Promise.allSettled([
        fetchJson<WaitlistListResponse>(`/api/waitlist?${qs.toString()}`),
        fetchJson<{ stats: WaitlistStats }>("/api/waitlist/stats"),
      ]);
      if (listR.status === "fulfilled") {
        setEntries(listR.value.entries);
      } else {
        setEntries([]);
        setError(listR.reason instanceof Error ? listR.reason.message : "Failed to load list");
      }
      setStats(statsR.status === "fulfilled" ? statsR.value.stats : null);
      if (statsR.status === "rejected") console.error("[waitlist] stats failed:", statsR.reason);
    } catch (err) {
      console.error("Failed to load waitlist:", err);
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(activeFilter);
  }, [activeFilter, load]);

  const updateEntry = async (
    entryId: string,
    patch: { status?: WaitlistStatus; adminNotes?: string },
  ) => {
    try {
      await fetchJson<{ success: boolean }>("/api/waitlist/update", {
        method: "POST",
        body: JSON.stringify({ entryId, ...patch }),
      });
      load(activeFilter);
    } catch (err) {
      alert(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const deleteEntry = async (entryId: string, email: string) => {
    if (!confirm(`Delete waitlist entry for ${email}? This can't be undone.`)) return;
    try {
      await fetchJson<{ success: boolean }>("/api/waitlist/delete", {
        method: "POST",
        body: JSON.stringify({ entryId }),
      });
      load(activeFilter);
    } catch (err) {
      alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const filtered = search
    ? entries.filter((e) => {
        const q = search.toLowerCase();
        return (
          e.email.toLowerCase().includes(q) ||
          e.firstName.toLowerCase().includes(q) ||
          e.lastName.toLowerCase().includes(q) ||
          (e.company ?? "").toLowerCase().includes(q)
        );
      })
    : entries;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Waitlist</h1>
          <p className="text-gray-600">Signups from tryatlasagi.com/waitlist</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load(activeFilter)}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-white text-gray-700 hover:bg-gray-50 border border-gray-200"
            title="Reload"
          >
            <RefreshCw className="h-4 w-4" />
            Reload
          </button>
          <button
            onClick={() => downloadCsv(filtered)}
            disabled={filtered.length === 0}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Export current view as CSV"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Stats strip */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label="Total" value={stats.total} hint={stats.scanCapped ? "≥ 2000 (capped)" : undefined} />
          <StatCard label="New" value={stats.new} accent="bg-blue-50 text-blue-700" />
          <StatCard label="Contacted" value={stats.contacted} accent="bg-yellow-50 text-yellow-700" />
          <StatCard label="Last 24h" value={stats.last24h} />
          <StatCard label="Last 7d" value={stats.last7d} />
        </div>
      )}

      {/* Filter pills + search */}
      <div className="flex flex-wrap gap-2 items-center">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setActiveFilter(f)}
            className={`px-4 py-2 text-sm font-medium rounded-lg capitalize transition-colors ${
              activeFilter === f
                ? "bg-primary-600 text-white"
                : "bg-white text-gray-700 hover:bg-gray-50 border border-gray-200"
            }`}
          >
            {f}
          </button>
        ))}
        <div className="ml-auto">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name/email/company…"
            className="px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white w-72"
          />
        </div>
      </div>

      {/* List */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {error ? (
          <div className="p-8 text-center text-red-600">{error}</div>
        ) : loading ? (
          <div className="p-8 text-center text-gray-500">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {search ? "No matches for that search." : "No entries in this view."}
          </div>
        ) : (
          <div className="divide-y divide-gray-200">
            {filtered.map((e) => (
              <div key={e._id} className="p-6 hover:bg-gray-50">
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-semibold">
                      {(e.firstName[0] || "?").toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium text-gray-900">
                          {e.firstName} {e.lastName}
                        </h3>
                        <span
                          className={`px-2 py-0.5 text-xs font-medium rounded-full ${statusColors[e.status] || "bg-gray-100 text-gray-700"}`}
                        >
                          {e.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-sm text-gray-600">
                        <Mail className="h-3.5 w-3.5" />
                        <a href={`mailto:${e.email}`} className="hover:underline">
                          {e.email}
                        </a>
                      </div>
                      <p className="text-sm text-gray-500 mt-1">
                        {e.role}
                        {e.company ? ` · ${e.company}` : ""}
                      </p>
                      <p className="text-sm text-gray-600 mt-2">
                        <span className="text-gray-500">Use case:</span> {e.useCase}
                      </p>
                      {e.adminNotes && (
                        <p className="text-sm text-gray-600 mt-1 italic">
                          Notes: {e.adminNotes}
                        </p>
                      )}
                      <p className="text-xs text-gray-400 mt-2">
                        Submitted {new Date(e.submittedAt).toLocaleString()}
                        {e.ipAddress ? ` · IP ${e.ipAddress}` : ""}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    {e.status !== "contacted" && (
                      <button
                        onClick={() => updateEntry(e._id, { status: "contacted" })}
                        className="p-2 text-yellow-600 hover:bg-yellow-50 rounded-lg"
                        title="Mark Contacted"
                      >
                        <MessageSquare className="h-5 w-5" />
                      </button>
                    )}
                    {e.status !== "accepted" && (
                      <button
                        onClick={() => updateEntry(e._id, { status: "accepted" })}
                        className="p-2 text-green-600 hover:bg-green-50 rounded-lg"
                        title="Accept"
                      >
                        <Check className="h-5 w-5" />
                      </button>
                    )}
                    {e.status !== "rejected" && (
                      <button
                        onClick={() => {
                          const notes = prompt("Reason (optional):") || undefined;
                          updateEntry(e._id, { status: "rejected", adminNotes: notes });
                        }}
                        className="p-2 text-red-600 hover:bg-red-50 rounded-lg"
                        title="Reject"
                      >
                        <X className="h-5 w-5" />
                      </button>
                    )}
                    <button
                      onClick={() => deleteEntry(e._id, e.email)}
                      className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                      title="Delete"
                    >
                      <Trash2 className="h-5 w-5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: number;
  hint?: string;
  accent?: string;
}) {
  return (
    <div className={`bg-white rounded-lg p-4 border border-gray-100 ${accent ?? ""}`}>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {hint && <div className="text-xs text-gray-400 mt-1">{hint}</div>}
    </div>
  );
}
