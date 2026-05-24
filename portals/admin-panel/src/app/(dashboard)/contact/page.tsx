"use client";

import { useEffect, useState, useCallback } from "react";
import type {
  ContactEntry,
  ContactStats,
  ContactListResponse,
  ContactStatus,
  ContactInquiry,
} from "@/lib/types";
import {
  Check,
  Archive,
  Trash2,
  Mail,
  Download,
  RefreshCw,
  MessageSquare,
  ExternalLink,
} from "lucide-react";

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

const STATUS_FILTERS: Array<ContactStatus | "all"> = ["new", "replied", "archived", "all"];
const INQUIRY_FILTERS: Array<ContactInquiry | "all"> = [
  "all",
  "partnerships",
  "enterprise",
  "investors",
  "press",
  "hiring",
  "other",
];

const statusColors: Record<ContactStatus, string> = {
  new: "bg-blue-100 text-blue-800",
  replied: "bg-green-100 text-green-800",
  archived: "bg-gray-100 text-gray-700",
};

const inquiryColors: Record<ContactInquiry, string> = {
  partnerships: "bg-purple-50 text-purple-700",
  enterprise: "bg-amber-50 text-amber-700",
  investors: "bg-emerald-50 text-emerald-700",
  press: "bg-rose-50 text-rose-700",
  hiring: "bg-sky-50 text-sky-700",
  other: "bg-gray-50 text-gray-700",
};

function csvEscape(value: unknown): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(entries: ContactEntry[]): void {
  const header = [
    "submittedAt",
    "name",
    "email",
    "company",
    "inquiry",
    "message",
    "status",
    "adminNotes",
    "ipAddress",
    "referrer",
    "origin",
  ];
  const rows = entries.map((e) =>
    [
      new Date(e.submittedAt).toISOString(),
      e.name,
      e.email,
      e.company ?? "",
      e.inquiry,
      e.message,
      e.status,
      e.adminNotes ?? "",
      e.ipAddress ?? "",
      e.referrer ?? "",
      e.origin ?? "",
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
  link.download = `xagilab-contact-${ts}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function ContactPage() {
  const [entries, setEntries] = useState<ContactEntry[]>([]);
  const [stats, setStats] = useState<ContactStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<ContactStatus | "all">("new");
  const [inquiryFilter, setInquiryFilter] = useState<ContactInquiry | "all">("all");
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "xagilab" | "tryatlasagi" | "other">("all");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(
    async (status: ContactStatus | "all", inquiry: ContactInquiry | "all") => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams();
        if (status !== "all") qs.set("status", status);
        if (inquiry !== "all") qs.set("inquiry", inquiry);
        qs.set("limit", "200");
        const [listR, statsR] = await Promise.allSettled([
          fetchJson<ContactListResponse>(`/api/contact?${qs.toString()}`),
          fetchJson<{ stats: ContactStats }>("/api/contact/stats"),
        ]);
        if (listR.status === "fulfilled") {
          setEntries(listR.value.entries);
        } else {
          setEntries([]);
          setError(listR.reason instanceof Error ? listR.reason.message : "Failed to load list");
        }
        setStats(statsR.status === "fulfilled" ? statsR.value.stats : null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    load(statusFilter, inquiryFilter);
  }, [statusFilter, inquiryFilter, load]);

  const updateEntry = async (
    entryId: string,
    patch: { status?: ContactStatus; adminNotes?: string },
  ) => {
    try {
      await fetchJson<{ success: boolean }>("/api/contact/update", {
        method: "POST",
        body: JSON.stringify({ entryId, ...patch }),
      });
      load(statusFilter, inquiryFilter);
    } catch (err) {
      alert(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const deleteEntry = async (entryId: string, email: string) => {
    if (!confirm(`Delete contact submission from ${email}? This can't be undone.`)) return;
    try {
      await fetchJson<{ success: boolean }>("/api/contact/delete", {
        method: "POST",
        body: JSON.stringify({ entryId }),
      });
      load(statusFilter, inquiryFilter);
    } catch (err) {
      alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  function entryMatchesSource(e: ContactEntry): boolean {
    if (sourceFilter === "all") return true;
    const host = (e.origin || "").toLowerCase();
    if (sourceFilter === "xagilab") return host.includes("xagilab");
    if (sourceFilter === "tryatlasagi") return host.includes("tryatlasagi");
    if (sourceFilter === "other") return !host.includes("xagilab") && !host.includes("tryatlasagi");
    return true;
  }

  const filtered = entries
    .filter(entryMatchesSource)
    .filter((e) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        e.email.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        (e.company ?? "").toLowerCase().includes(q) ||
        e.message.toLowerCase().includes(q)
      );
    });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Contact inbox</h1>
          <p className="text-gray-600">Submissions from xagilab.com/contact</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load(statusFilter, inquiryFilter)}
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

      {stats && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard
              label="Total"
              value={stats.total}
              hint={stats.scanCapped ? "≥ 2000 (capped)" : undefined}
            />
            <StatCard label="New" value={stats.new} accent="bg-blue-50 text-blue-700" />
            <StatCard label="Replied" value={stats.replied} accent="bg-green-50 text-green-700" />
            <StatCard label="Last 24h" value={stats.last24h} />
            <StatCard label="Last 7d" value={stats.last7d} />
          </div>
          {stats.bySource && (
            <div className="grid grid-cols-3 gap-3">
              <StatCard
                label="From xagilab.com"
                value={stats.bySource.xagilab}
                accent="bg-amber-50 text-amber-700"
              />
              <StatCard
                label="From tryatlasagi.com"
                value={stats.bySource.tryatlasagi}
                accent="bg-blue-50 text-blue-700"
              />
              <StatCard
                label="Other origins"
                value={stats.bySource.other}
              />
            </div>
          )}
        </>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className={`px-4 py-2 text-sm font-medium rounded-lg capitalize transition-colors ${
              statusFilter === f
                ? "bg-primary-600 text-white"
                : "bg-white text-gray-700 hover:bg-gray-50 border border-gray-200"
            }`}
          >
            {f}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as typeof sourceFilter)}
            className="px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white"
            title="Filter by source site"
          >
            <option value="all">All sources</option>
            <option value="xagilab">xagilab.com</option>
            <option value="tryatlasagi">tryatlasagi.com</option>
            <option value="other">Other</option>
          </select>
          <select
            value={inquiryFilter}
            onChange={(e) => setInquiryFilter(e.target.value as ContactInquiry | "all")}
            className="px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white capitalize"
          >
            {INQUIRY_FILTERS.map((f) => (
              <option key={f} value={f} className="capitalize">
                {f === "all" ? "All inquiries" : f}
              </option>
            ))}
          </select>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name/email/company/message…"
            className="px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white w-80"
          />
        </div>
      </div>

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
            {filtered.map((e) => {
              const isOpen = expanded.has(e._id);
              return (
                <div key={e._id} className="p-6 hover:bg-gray-50">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4 flex-1 min-w-0">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white font-semibold shrink-0">
                        {(e.name[0] || "?").toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-medium text-gray-900">{e.name}</h3>
                          <span
                            className={`px-2 py-0.5 text-xs font-medium rounded-full ${statusColors[e.status] ?? "bg-gray-100 text-gray-700"}`}
                          >
                            {e.status}
                          </span>
                          <span
                            className={`px-2 py-0.5 text-xs font-medium rounded-full capitalize ${inquiryColors[e.inquiry] ?? "bg-gray-50 text-gray-600"}`}
                          >
                            {e.inquiry}
                          </span>
                          {(() => {
                            const host = (e.origin || "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "");
                            if (!host) return null;
                            const isAtlas = host.includes("tryatlasagi");
                            const isXagi = host.includes("xagilab");
                            const cls = isAtlas
                              ? "bg-blue-50 text-blue-700 border-blue-200"
                              : isXagi
                                ? "bg-amber-50 text-amber-700 border-amber-200"
                                : "bg-gray-50 text-gray-700 border-gray-200";
                            return (
                              <span className={`px-2 py-0.5 text-xs font-medium rounded-full border ${cls}`} title={`Submitted from ${host}`}>
                                {host}
                              </span>
                            );
                          })()}
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-sm text-gray-600">
                          <Mail className="h-3.5 w-3.5" />
                          <a href={`mailto:${e.email}`} className="hover:underline">
                            {e.email}
                          </a>
                          {e.company && <span className="text-gray-400">· {e.company}</span>}
                        </div>
                        <p
                          className={`text-sm text-gray-700 mt-2 whitespace-pre-wrap ${isOpen ? "" : "line-clamp-2"}`}
                        >
                          {e.message}
                        </p>
                        {e.message.length > 160 && (
                          <button
                            onClick={() => toggleExpand(e._id)}
                            className="text-xs font-medium text-primary-600 hover:text-primary-800 mt-1"
                          >
                            {isOpen ? "Show less" : "Show more"}
                          </button>
                        )}
                        {e.adminNotes && (
                          <p className="text-sm text-gray-600 mt-2 italic">
                            Notes: {e.adminNotes}
                          </p>
                        )}
                        <p className="text-xs text-gray-400 mt-2">
                          {new Date(e.submittedAt).toLocaleString()}
                          {e.ipAddress ? ` · IP ${e.ipAddress}` : ""}
                          {e.origin ? ` · ${e.origin.replace(/^https?:\/\//, "")}` : ""}
                          {e.referrer ? (
                            <>
                              {" · "}
                              <a
                                href={e.referrer}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-0.5 hover:underline"
                              >
                                ref <ExternalLink className="h-3 w-3" />
                              </a>
                            </>
                          ) : null}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {e.status !== "replied" && (
                        <button
                          onClick={() => updateEntry(e._id, { status: "replied" })}
                          className="p-2 text-green-600 hover:bg-green-50 rounded-lg"
                          title="Mark replied"
                        >
                          <Check className="h-5 w-5" />
                        </button>
                      )}
                      {e.status !== "archived" && (
                        <button
                          onClick={() => updateEntry(e._id, { status: "archived" })}
                          className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg"
                          title="Archive"
                        >
                          <Archive className="h-5 w-5" />
                        </button>
                      )}
                      <button
                        onClick={() => {
                          const notes = prompt(
                            "Notes (saved on this entry):",
                            e.adminNotes ?? "",
                          );
                          if (notes !== null) updateEntry(e._id, { adminNotes: notes });
                        }}
                        className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg"
                        title="Add notes"
                      >
                        <MessageSquare className="h-5 w-5" />
                      </button>
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
              );
            })}
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
