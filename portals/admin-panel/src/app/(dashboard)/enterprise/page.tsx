"use client";

import { useEffect, useState } from "react";
import {
  Plus,
  Ban,
  Copy,
  Check,
  AlertCircle,
  Building2,
  BarChart3,
  Activity,
  RefreshCw,
} from "lucide-react";

interface License {
  _id: string;
  licenseKey: string;
  clientId: string;
  clientName: string;
  contactEmail: string;
  status: "active" | "suspended" | "revoked" | "expired";
  seatLimit: number;
  features: string[];
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
  revokedReason?: string;
}

interface UsageEntry {
  license_id: string;
  license_key: string;
  client_name: string;
  contact_email: string;
  license_status: string;
  seat_limit: number;
  total_calls: number;
  active_days: number;
  last_active_day: string | null;
  top_tools: Array<{ tool_name: string; count: number }>;
}

const statusPill: Record<string, string> = {
  active: "bg-green-50 text-green-700 border-green-200",
  suspended: "bg-yellow-50 text-yellow-700 border-yellow-200",
  revoked: "bg-red-50 text-red-700 border-red-200",
  expired: "bg-gray-100 text-gray-600 border-gray-200",
};

export default function EnterprisePage() {
  const [tab, setTab] = useState<"licenses" | "usage">("licenses");
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Building2 className="w-6 h-6 text-primary-600" />
            <h1 className="text-2xl font-bold text-gray-900">Enterprise</h1>
          </div>
          <p className="text-gray-600 text-sm">
            ATLAS Tools MCP — manage customer licenses and usage on the isolated
            <span className="font-mono text-gray-800 ml-1">sincere-caiman-611</span> Convex deployment.
          </p>
        </div>
        {tab === "licenses" && (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Customer License
          </button>
        )}
      </div>

      <div className="flex items-center gap-1 border-b border-gray-200">
        <TabButton
          active={tab === "licenses"}
          onClick={() => setTab("licenses")}
          icon={<Building2 className="w-4 h-4" />}
        >
          Licenses
        </TabButton>
        <TabButton
          active={tab === "usage"}
          onClick={() => setTab("usage")}
          icon={<BarChart3 className="w-4 h-4" />}
        >
          Usage
        </TabButton>
      </div>

      {tab === "licenses" ? (
        <LicensesView
          showCreate={showCreate}
          onShowCreate={setShowCreate}
        />
      ) : (
        <UsageView />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "text-primary-700 border-primary-600"
          : "text-gray-600 hover:text-gray-900 border-transparent"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

// ─── Licenses ─────────────────────────────────────────────────────────

function LicensesView({
  showCreate,
  onShowCreate,
}: {
  showCreate: boolean;
  onShowCreate: (v: boolean) => void;
}) {
  const [licenses, setLicenses] = useState<License[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "revoked" | "expired">("all");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/enterprise/licenses");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { licenses: License[] };
      setLicenses(data.licenses.sort((a, b) => b.issuedAt - a.issuedAt));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load licenses");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleRevoke = async (licenseKey: string) => {
    const reason = prompt(
      `Revoke license ${licenseKey}?\n\nReason (optional):`,
      "admin_revoked",
    );
    if (reason === null) return;
    try {
      const res = await fetch(`/api/enterprise/licenses/${encodeURIComponent(licenseKey)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to revoke");
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(text);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {}
  };

  const visible = filter === "all" ? licenses : licenses.filter((l) => l.status === filter);
  const activeCount = licenses.filter((l) => l.status === "active").length;
  const revokedCount = licenses.filter((l) => l.status === "revoked").length;
  const totalSeats = licenses
    .filter((l) => l.status === "active")
    .reduce((s, l) => s + l.seatLimit, 0);

  return (
    <>
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Active licenses" value={activeCount} />
        <StatCard label="Total active seats" value={totalSeats} />
        <StatCard label="Revoked" value={revokedCount} />
      </div>

      <div className="flex items-center gap-2">
        {(["all", "active", "revoked", "expired"] as const).map((f) => (
          <button
            type="button"
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 text-sm font-medium rounded-lg capitalize transition-colors ${
              filter === f
                ? "bg-primary-600 text-white"
                : "bg-white text-gray-700 hover:bg-gray-50 border border-gray-200"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-gray-500">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            No licenses yet. Click <span className="text-gray-900 font-medium">New Customer License</span> to issue one.
          </div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Customer</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">License Key</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Seats</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Features</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Issued</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Expires</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {visible.map((l) => (
                <tr key={l._id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="text-sm font-medium text-gray-900">{l.clientName}</div>
                    <div className="text-xs text-gray-500">{l.contactEmail}</div>
                  </td>
                  <td className="px-6 py-4">
                    <button
                      type="button"
                      onClick={() => copy(l.licenseKey)}
                      className="flex items-center gap-2 font-mono text-xs text-gray-900 hover:text-primary-700"
                      title="Copy"
                    >
                      <span>{l.licenseKey}</span>
                      {copiedKey === l.licenseKey ? (
                        <Check className="w-3.5 h-3.5 text-green-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5 text-gray-400" />
                      )}
                    </button>
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`inline-block px-2 py-0.5 text-xs font-medium rounded border ${statusPill[l.status]}`}
                    >
                      {l.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-700">{l.seatLimit}</td>
                  <td className="px-6 py-4 text-xs text-gray-600">{l.features.join(", ")}</td>
                  <td className="px-6 py-4 text-xs text-gray-500">
                    {new Date(l.issuedAt).toISOString().slice(0, 10)}
                  </td>
                  <td className="px-6 py-4 text-xs text-gray-500">
                    {new Date(l.expiresAt).toISOString().slice(0, 10)}
                  </td>
                  <td className="px-6 py-4 text-right">
                    {l.status === "active" ? (
                      <button
                        type="button"
                        onClick={() => handleRevoke(l.licenseKey)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
                      >
                        <Ban className="w-3.5 h-3.5" />
                        Revoke
                      </button>
                    ) : (
                      <span className="text-xs text-gray-400">
                        {l.revokedReason ? `revoked: ${l.revokedReason}` : "—"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showCreate && (
        <CreateLicenseModal
          onClose={() => onShowCreate(false)}
          onCreated={async () => {
            onShowCreate(false);
            await load();
          }}
        />
      )}
    </>
  );
}

// ─── Usage ────────────────────────────────────────────────────────────

function UsageView() {
  const [usage, setUsage] = useState<UsageEntry[]>([]);
  const [windowDays, setWindowDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (days: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/enterprise/usage?days=${days}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { usage: UsageEntry[]; window_days: number };
      setUsage(data.usage);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load usage");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(windowDays);
  }, [windowDays]);

  const totalCalls = usage.reduce((s, u) => s + u.total_calls, 0);
  const activeCustomers = usage.filter((u) => u.total_calls > 0).length;
  const totalLicenses = usage.length;

  return (
    <>
      <div className="grid grid-cols-3 gap-4">
        <StatCard label={`Tool calls (last ${windowDays}d)`} value={totalCalls} />
        <StatCard label="Active customers" value={activeCustomers} />
        <StatCard label="Total licenses tracked" value={totalLicenses} />
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500 uppercase tracking-wide mr-1 font-medium">Window</span>
        {[7, 14, 30, 90, 365].map((d) => (
          <button
            type="button"
            key={d}
            onClick={() => setWindowDays(d)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              windowDays === d
                ? "bg-primary-600 text-white"
                : "bg-white text-gray-700 hover:bg-gray-50 border border-gray-200"
            }`}
          >
            {d}d
          </button>
        ))}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void load(windowDays)}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 border border-gray-200 rounded-lg transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-gray-500">Loading…</div>
        ) : usage.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            No licenses or usage data yet.
          </div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Customer</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">License</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Total Calls</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Active Days</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Last Active</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Top Tools</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {usage.map((u) => (
                <tr key={u.license_id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="text-sm font-medium text-gray-900">{u.client_name}</div>
                    <div className="text-xs text-gray-500">{u.contact_email}</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="font-mono text-xs text-gray-900">{u.license_key}</div>
                    <div className="mt-1">
                      <span
                        className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded border ${
                          statusPill[u.license_status] ?? statusPill.expired
                        }`}
                      >
                        {u.license_status}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <span
                      className={`font-mono text-sm ${
                        u.total_calls > 0 ? "text-gray-900 font-medium" : "text-gray-300"
                      }`}
                    >
                      {u.total_calls.toLocaleString()}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <span className="font-mono text-sm text-gray-700">{u.active_days}</span>
                    <span className="text-xs text-gray-400">/{windowDays}</span>
                  </td>
                  <td className="px-6 py-4 text-xs text-gray-600">
                    {u.last_active_day ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Activity className="w-3 h-3 text-green-600" />
                        {u.last_active_day}
                      </span>
                    ) : (
                      <span className="text-gray-400">never</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {u.top_tools.length === 0 ? (
                      <span className="text-gray-300 text-xs">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {u.top_tools.slice(0, 4).map((t) => (
                          <span
                            key={t.tool_name}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md bg-gray-100 border border-gray-200 text-gray-700"
                            title={`${t.count} calls`}
                          >
                            <span className="font-mono">{t.tool_name}</span>
                            <span className="text-gray-500">{t.count}</span>
                          </span>
                        ))}
                        {u.top_tools.length > 4 && (
                          <span className="text-[10px] text-gray-500 self-center">
                            +{u.top_tools.length - 4}
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────────

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
      <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
      <div>
        <div className="font-medium text-red-800 mb-1">
          Failed to talk to enterprise Convex
        </div>
        <div className="text-sm text-red-700">{message}</div>
        <div className="text-xs text-red-600 mt-2">
          Check that <code className="font-mono bg-red-100 px-1 rounded">ATLAS_MCP_ADMIN_KEY</code> and{" "}
          <code className="font-mono bg-red-100 px-1 rounded">ATLAS_MCP_CONVEX_SITE_URL</code> are set in the admin-panel env.
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-5 border border-gray-100">
      <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
        {label}
      </div>
      <div className="text-2xl font-bold text-gray-900">{value.toLocaleString()}</div>
    </div>
  );
}

function CreateLicenseModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [clientName, setClientName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [plan, setPlan] = useState<"pilot" | "standard" | "enterprise">("pilot");
  const [seatLimit, setSeatLimit] = useState(5);
  const [lifetimeDays, setLifetimeDays] = useState(365);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{
    license_key: string;
    expires_at: number;
    features: string[];
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/enterprise/licenses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: clientName,
          contact_email: contactEmail,
          plan,
          seat_limit: seatLimit,
          lifetime_days: lifetimeDays,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const result = (await res.json()) as {
        license_key: string;
        expires_at: number;
        features: string[];
      };
      setIssued(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to issue license");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-gray-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-md w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {issued ? (
          <div>
            <h2 className="text-xl font-bold text-gray-900 mb-2">License issued</h2>
            <p className="text-gray-600 text-sm mb-4">
              Send this key to the customer along with the install package.
            </p>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 mb-4">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                License key
              </div>
              <div className="font-mono text-gray-900 text-sm break-all">
                {issued.license_key}
              </div>
            </div>
            <div className="text-xs text-gray-600 mb-4">
              Features: <span className="text-gray-900">{issued.features.join(", ")}</span> · Expires:{" "}
              <span className="text-gray-900">{new Date(issued.expires_at).toISOString().slice(0, 10)}</span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(issued.license_key);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch {}
                }}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-white text-gray-700 hover:bg-gray-50 border border-gray-200 text-sm font-medium rounded-lg transition-colors"
              >
                {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                {copied ? "Copied" : "Copy key"}
              </button>
              <button
                type="button"
                onClick={() => void onCreated()}
                className="flex-1 px-3 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <h2 className="text-xl font-bold text-gray-900 mb-1">New Enterprise Customer</h2>
            <p className="text-gray-600 text-sm mb-4">
              Issue a license key. The customer activates it from their MCP install.
            </p>
            {error && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {error}
              </div>
            )}
            <div className="space-y-3">
              <Field label="Client name">
                <input
                  required
                  maxLength={200}
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Acme Corp"
                />
              </Field>
              <Field label="Contact email">
                <input
                  required
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="ops@acme.com"
                />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Plan">
                  <select
                    value={plan}
                    onChange={(e) => setPlan(e.target.value as typeof plan)}
                    className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  >
                    <option value="pilot">Pilot</option>
                    <option value="standard">Standard</option>
                    <option value="enterprise">Enterprise</option>
                  </select>
                </Field>
                <Field label="Seats">
                  <input
                    required
                    type="number"
                    min={1}
                    max={10000}
                    value={seatLimit}
                    onChange={(e) => setSeatLimit(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                </Field>
                <Field label="Days">
                  <input
                    required
                    type="number"
                    min={1}
                    max={3650}
                    value={lifetimeDays}
                    onChange={(e) => setLifetimeDays(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                </Field>
              </div>
            </div>
            <div className="flex gap-2 mt-6">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-3 py-2 bg-white text-gray-700 hover:bg-gray-50 border border-gray-200 text-sm font-medium rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="flex-1 px-3 py-2 bg-primary-600 hover:bg-primary-700 disabled:bg-primary-300 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {submitting ? "Issuing…" : "Issue License"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  );
}
