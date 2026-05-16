"use client";

import { useCallback, useEffect, useState } from "react";
import {
  KeyRound,
  RefreshCw,
  CircleCheck,
  CircleAlert,
  Pencil,
  Trash2,
  X,
  ShieldAlert,
} from "lucide-react";

// Display metadata for each known env var. Anything missing here will still
// render — the name + a generic icon — so adding a new allowlist entry in
// the API route doesn't break the UI.
const META: Record<string, { group: string; label: string }> = {
  OPENROUTER_API_KEY: { group: "LLM provider", label: "OpenRouter API key" },
  HCAPTCHA_SECRET: { group: "Spam protection", label: "hCaptcha secret" },
  SMTP_HOST: { group: "Email (waitlist)", label: "SMTP host" },
  SMTP_PORT: { group: "Email (waitlist)", label: "SMTP port" },
  SMTP_USER: { group: "Email (waitlist)", label: "SMTP user" },
  SMTP_PASS: { group: "Email (waitlist)", label: "SMTP password" },
  WAITLIST_NOTIFY_EMAIL: { group: "Email (waitlist)", label: "Notify-to address" },
  WAITLIST_NOTIFY_FROM: { group: "Email (waitlist)", label: "Notify-from address" },
  ADMIN_API_KEY: { group: "Admin", label: "Admin API key" },
  OTPLESS_CLIENT_ID: { group: "Auth (OTPless)", label: "Client ID" },
  OTPLESS_CLIENT_SECRET: { group: "Auth (OTPless)", label: "Client secret" },
  OTPLESS_APP_ID: { group: "Auth (OTPless)", label: "App ID" },
  TAVILY_API_KEY: { group: "Search", label: "Tavily" },
  EXA_API_KEY: { group: "Search", label: "Exa" },
  GOOGLE_API_KEY: { group: "Voice / vision", label: "Google API key" },
  OPENAI_API_KEY: { group: "Voice / vision", label: "OpenAI API key" },
  DEEPGRAM_API_KEY: { group: "Voice / vision", label: "Deepgram" },
  HF_TOKEN: { group: "Voice / vision", label: "Hugging Face" },
  NOPECHA_API_KEY: { group: "CAPTCHA solving", label: "NopeCHA" },
  CAPTCHA_API_KEY: { group: "CAPTCHA solving", label: "2Captcha" },
  SPOTIFY_CLIENT_ID: { group: "Music", label: "Spotify client ID" },
  SPOTIFY_CLIENT_SECRET: { group: "Music", label: "Spotify client secret" },
  GH_TOKEN: { group: "GitHub", label: "GH token" },
};

const SENSITIVE_KEYS = new Set([
  "OPENROUTER_API_KEY",
  "HCAPTCHA_SECRET",
  "SMTP_PASS",
  "ADMIN_API_KEY",
  "OTPLESS_CLIENT_SECRET",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "DEEPGRAM_API_KEY",
  "HF_TOKEN",
  "NOPECHA_API_KEY",
  "CAPTCHA_API_KEY",
  "SPOTIFY_CLIENT_SECRET",
  "GH_TOKEN",
]);

interface IntegrationStatus {
  name: string;
  present: boolean;
}

export default function IntegrationsCard({ canEdit }: { canEdit: boolean }) {
  const [statuses, setStatuses] = useState<IntegrationStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ name: string; kind: "ok" | "err"; msg: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const resp = await fetch("/api/admin/integrations");
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
      setStatuses(data.integrations);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canEdit) load();
  }, [canEdit, load]);

  const openEdit = (name: string) => {
    setEditing(name);
    setDraft("");
    setShow(false);
    setFlash(null);
  };

  const closeEdit = () => {
    setEditing(null);
    setDraft("");
    setBusy(false);
  };

  const rotate = async () => {
    if (!editing || draft.length === 0) return;
    setBusy(true);
    try {
      const resp = await fetch("/api/admin/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editing, value: draft }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
      setFlash({ name: editing, kind: "ok", msg: "Updated on Convex prod" });
      closeEdit();
      load();
    } catch (err) {
      setFlash({
        name: editing,
        kind: "err",
        msg: err instanceof Error ? err.message : "Rotation failed",
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    if (!confirm(`Remove ${name} from Convex prod? This will disable any feature that depends on it.`)) return;
    try {
      const resp = await fetch("/api/admin/integrations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
      setFlash({ name, kind: "ok", msg: "Removed" });
      load();
    } catch (err) {
      setFlash({
        name,
        kind: "err",
        msg: err instanceof Error ? err.message : "Remove failed",
      });
    }
  };

  if (!canEdit) {
    return (
      <div className="rounded-xl bg-yellow-50 border border-yellow-200 p-4 flex items-start gap-3">
        <ShieldAlert className="h-5 w-5 text-yellow-700 flex-shrink-0" />
        <div className="text-sm text-yellow-900">
          <p className="font-semibold">super_admin role required</p>
          <p className="text-yellow-800 mt-0.5">
            Server-side integration keys can only be viewed or rotated by a super admin.
            Ask one to grant you the role or rotate on your behalf.
          </p>
        </div>
      </div>
    );
  }

  // Group by `META[name].group` for the rendered list
  const groups: Record<string, IntegrationStatus[]> = {};
  (statuses ?? []).forEach((s) => {
    const g = META[s.name]?.group || "Other";
    if (!groups[g]) groups[g] = [];
    groups[g].push(s);
  });

  return (
    <section className="glass-card-static p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <KeyRound className="h-5 w-5 text-[--accent-primary]" />
          <h2 className="text-lg font-semibold text-[--text-primary]">Server-side integrations</h2>
        </div>
        <button
          onClick={load}
          className="text-xs flex items-center gap-1.5 text-[--text-muted] hover:text-[--text-primary]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>
      <p className="text-sm text-[--text-muted] mb-5">
        Stored on the Convex deployment. Values are never sent to the browser — rotations spawn
        <code className="font-mono text-xs mx-1">npx convex env set</code> on the admin server.
      </p>

      {loading ? (
        <p className="text-sm text-[--text-muted]">Reading Convex env…</p>
      ) : loadError ? (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {loadError}
        </div>
      ) : (
        <div className="space-y-5">
          {Object.entries(groups).map(([groupName, rows]) => (
            <div key={groupName}>
              <p className="text-xs uppercase tracking-wide font-semibold text-[--text-muted] mb-2">
                {groupName}
              </p>
              <div className="space-y-2">
                {rows.map((row) => (
                  <div
                    key={row.name}
                    className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm text-[--text-primary]">
                        {META[row.name]?.label || row.name}
                      </p>
                      <p className="text-xs text-[--text-muted] font-mono truncate">{row.name}</p>
                    </div>
                    <div
                      className={`flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full ${
                        row.present
                          ? "bg-green-100 text-green-700"
                          : "bg-yellow-100 text-yellow-700"
                      }`}
                    >
                      {row.present ? (
                        <>
                          <CircleCheck className="h-3 w-3" />
                          Set
                        </>
                      ) : (
                        <>
                          <CircleAlert className="h-3 w-3" />
                          Not set
                        </>
                      )}
                    </div>
                    <button
                      onClick={() => openEdit(row.name)}
                      className="p-1.5 rounded-md text-gray-500 hover:text-[--accent-primary] hover:bg-white"
                      title="Set / rotate value"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    {row.present && (
                      <button
                        onClick={() => remove(row.name)}
                        className="p-1.5 rounded-md text-gray-500 hover:text-red-600 hover:bg-white"
                        title="Remove"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {flash && rows.some((r) => r.name === flash.name) && (
                <p
                  className={`text-xs mt-2 ${
                    flash.kind === "ok" ? "text-green-600" : "text-red-600"
                  }`}
                >
                  {flash.name}: {flash.msg}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Rotate modal */}
      {editing && (
        <div className="modal-overlay" onClick={closeEdit}>
          <div
            className="modal-glass p-6 w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-[--text-primary]">
                Set {META[editing]?.label || editing}
              </h3>
              <button onClick={closeEdit} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-sm text-[--text-muted] mb-4">
              Sets <code className="font-mono text-xs">{editing}</code> on the Convex production
              deployment. The new value takes effect immediately for any subsequent handler invocation.
            </p>

            <label className="block text-xs uppercase tracking-wide font-semibold text-[--text-muted] mb-1">
              New value
            </label>
            <div className="relative">
              <input
                type={SENSITIVE_KEYS.has(editing) && !show ? "password" : "text"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
                disabled={busy}
                className="input-glass pr-20 font-mono text-sm"
                placeholder="Paste the new value"
              />
              {SENSITIVE_KEYS.has(editing) && (
                <button
                  type="button"
                  onClick={() => setShow(!show)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-[--text-muted] hover:text-[--text-primary] px-2"
                >
                  {show ? "Hide" : "Show"}
                </button>
              )}
            </div>
            <p className="text-xs text-[--text-muted] mt-2">
              Characters: <strong>{draft.length}</strong>. Empty values are rejected — use Remove
              instead to unset a key.
            </p>

            {flash && flash.name === editing && flash.kind === "err" && (
              <div className="rounded-lg bg-red-50 border border-red-200 p-2 text-xs text-red-700 mt-3">
                {flash.msg}
              </div>
            )}

            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={closeEdit}
                disabled={busy}
                className="btn-glass btn-glass-secondary"
              >
                Cancel
              </button>
              <button
                onClick={rotate}
                disabled={busy || draft.length === 0}
                className="btn-glass btn-glass-primary disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save & rotate"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
