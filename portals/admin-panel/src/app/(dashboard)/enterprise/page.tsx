"use client";

import { useEffect, useState } from "react";
import { Plus, Ban, Copy, Check, AlertCircle, Building2 } from "lucide-react";

interface License {
  _id: string;
  licenseKey: string;
  clientId: string;
  status: "active" | "suspended" | "revoked" | "expired";
  seatLimit: number;
  features: string[];
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
  revokedReason?: string;
}

const statusColors: Record<string, string> = {
  active: "bg-green-500/10 text-green-300 border-green-500/20",
  suspended: "bg-yellow-500/10 text-yellow-300 border-yellow-500/20",
  revoked: "bg-red-500/10 text-red-300 border-red-500/20",
  expired: "bg-gray-500/10 text-gray-300 border-gray-500/20",
};

export default function EnterprisePage() {
  const [licenses, setLicenses] = useState<License[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "revoked" | "expired">("all");
  const [showCreate, setShowCreate] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/enterprise/licenses");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { licenses: License[] };
      setLicenses(
        data.licenses.sort((a, b) => b.issuedAt - a.issuedAt),
      );
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
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Building2 className="w-7 h-7 text-blue-400" />
            <h1 className="text-3xl font-semibold text-white">Enterprise Licenses</h1>
          </div>
          <p className="text-white/60 text-sm">
            ATLAS Tools MCP — manage enterprise customer licenses on the isolated
            <span className="font-mono text-white/80 ml-1">sincere-caiman-611</span> Convex deployment.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition"
        >
          <Plus className="w-4 h-4" />
          New Customer License
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard label="Active licenses" value={activeCount} />
        <StatCard label="Total active seats" value={totalSeats} />
        <StatCard label="Revoked" value={revokedCount} />
      </div>

      <div className="flex items-center gap-2 mb-4">
        {(["all", "active", "revoked", "expired"] as const).map((f) => (
          <button
            type="button"
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 text-sm rounded-md transition ${
              filter === f
                ? "bg-white/10 text-white"
                : "text-white/60 hover:text-white hover:bg-white/[0.04]"
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-red-300 mb-1">Failed to talk to enterprise Convex</div>
            <div className="text-sm text-red-300/80">{error}</div>
            <div className="text-xs text-red-300/60 mt-2">
              Check that <code>ATLAS_MCP_ADMIN_KEY</code> and <code>ATLAS_MCP_CONVEX_SITE_URL</code> are set in the admin-panel env.
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-white/60 text-center py-12">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="text-white/60 text-center py-12 border border-white/[0.08] rounded-lg">
          No licenses yet. Click <span className="text-white">New Customer License</span> to issue one.
        </div>
      ) : (
        <div className="border border-white/[0.08] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.03] text-white/60 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left font-medium">License Key</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Seats</th>
                <th className="px-4 py-3 text-left font-medium">Features</th>
                <th className="px-4 py-3 text-left font-medium">Issued</th>
                <th className="px-4 py-3 text-left font-medium">Expires</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {visible.map((l) => (
                <tr key={l._id} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => copy(l.licenseKey)}
                      className="flex items-center gap-2 font-mono text-xs text-white/90 hover:text-white"
                      title="Copy"
                    >
                      <span>{l.licenseKey}</span>
                      {copiedKey === l.licenseKey ? (
                        <Check className="w-3.5 h-3.5 text-green-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5 text-white/40" />
                      )}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 text-xs rounded border ${statusColors[l.status]}`}
                    >
                      {l.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-white/80">{l.seatLimit}</td>
                  <td className="px-4 py-3 text-white/70 text-xs">{l.features.join(", ")}</td>
                  <td className="px-4 py-3 text-white/60 text-xs">
                    {new Date(l.issuedAt).toISOString().slice(0, 10)}
                  </td>
                  <td className="px-4 py-3 text-white/60 text-xs">
                    {new Date(l.expiresAt).toISOString().slice(0, 10)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {l.status === "active" ? (
                      <button
                        type="button"
                        onClick={() => handleRevoke(l.licenseKey)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10 rounded transition"
                      >
                        <Ban className="w-3.5 h-3.5" />
                        Revoke
                      </button>
                    ) : (
                      <span className="text-xs text-white/40">
                        {l.revokedReason ? `revoked: ${l.revokedReason}` : "—"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateLicenseModal
          onClose={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="p-4 border border-white/[0.08] rounded-lg bg-white/[0.02]">
      <div className="text-xs text-white/50 uppercase tracking-wide mb-1">{label}</div>
      <div className="text-2xl font-semibold text-white">{value}</div>
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
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-white/10 rounded-xl max-w-md w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {issued ? (
          <div>
            <h2 className="text-xl font-semibold text-white mb-2">License issued</h2>
            <p className="text-white/60 text-sm mb-4">
              Send this key to the customer along with the install package.
            </p>
            <div className="bg-black/40 border border-white/10 rounded-lg p-3 mb-4">
              <div className="text-xs text-white/50 mb-1">License key</div>
              <div className="font-mono text-white text-sm break-all">{issued.license_key}</div>
            </div>
            <div className="text-xs text-white/60 mb-4">
              Features: {issued.features.join(", ")} • Expires:{" "}
              {new Date(issued.expires_at).toISOString().slice(0, 10)}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(issued.license_key);
                  } catch {}
                }}
                className="flex-1 px-3 py-2 bg-white/10 hover:bg-white/15 text-white text-sm rounded-lg"
              >
                Copy key
              </button>
              <button
                type="button"
                onClick={() => void onCreated()}
                className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <h2 className="text-xl font-semibold text-white mb-4">New Enterprise Customer</h2>
            {error && (
              <div className="mb-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-300">
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
                  className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500/50"
                  placeholder="Acme Corp"
                />
              </Field>
              <Field label="Contact email">
                <input
                  required
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500/50"
                  placeholder="ops@acme.com"
                />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Plan">
                  <select
                    value={plan}
                    onChange={(e) => setPlan(e.target.value as typeof plan)}
                    className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500/50"
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
                    className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500/50"
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
                    className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500/50"
                  />
                </Field>
              </div>
            </div>
            <div className="flex gap-2 mt-6">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-3 py-2 bg-white/5 hover:bg-white/10 text-white text-sm rounded-lg"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-900 text-white text-sm rounded-lg"
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
      <label className="block text-xs text-white/60 mb-1">{label}</label>
      {children}
    </div>
  );
}
