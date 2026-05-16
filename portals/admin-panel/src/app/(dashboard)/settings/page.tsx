import { getSession } from "@/lib/auth";
import { adminHttpGet } from "@/lib/convex";
import type { SystemOverview } from "@/lib/types";
import {
  ShieldCheck,
  TerminalSquare,
  CircleCheck,
  Server,
} from "lucide-react";
import IntegrationsCard from "./integrations-card";

export const dynamic = "force-dynamic";

async function getOverview(): Promise<SystemOverview | null> {
  try {
    const { data } = await adminHttpGet<{ data: SystemOverview }>(
      "/api/admin/observability/system-overview",
    );
    return data;
  } catch {
    return null;
  }
}

export default async function SettingsPage() {
  const session = await getSession();
  const overview = await getOverview();

  const convexCloud = process.env.NEXT_PUBLIC_CONVEX_URL ?? "(unset)";
  const adminApiBase = process.env.NEXT_PUBLIC_ATLAS_ADMIN_API_BASE ?? "(unset)";
  const isProd = convexCloud.includes("avid-oyster-465");

  return (
    <div className="space-y-8">
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">System configuration, environment, and your admin profile</p>
      </div>

      {/* Your profile */}
      <section className="glass-card-static p-6 max-w-3xl">
        <div className="flex items-center gap-3 mb-5">
          <ShieldCheck className="h-5 w-5 text-[--accent-primary]" />
          <h2 className="text-lg font-semibold text-[--text-primary]">Your profile</h2>
        </div>
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <Field label="Name" value={session?.name ?? "—"} />
          <Field label="Email" value={session?.email ?? "—"} />
          <Field
            label="Role"
            value={
              <span className="px-2 py-1 text-xs font-semibold rounded-full bg-purple-100 text-purple-800 capitalize">
                {session?.role?.replace("_", " ") ?? "—"}
              </span>
            }
          />
          <Field
            label="Session"
            value={<span className="text-emerald-600 inline-flex items-center gap-1"><CircleCheck className="h-4 w-4" /> Active</span>}
          />
          <div className="md:col-span-2">
            <dt className="text-xs uppercase tracking-wide text-[--text-muted] mb-1">Permissions</dt>
            <dd className="flex flex-wrap gap-2">
              {session?.role === "super_admin" ? (
                <span className="px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">
                  All Permissions
                </span>
              ) : (
                (session?.permissions ?? []).map((p) => (
                  <span
                    key={p}
                    className="px-2 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-800"
                  >
                    {p}
                  </span>
                ))
              )}
            </dd>
          </div>
        </dl>
      </section>

      {/* Deployment */}
      <section className="glass-card-static p-6 max-w-3xl">
        <div className="flex items-center gap-3 mb-5">
          <Server className="h-5 w-5 text-[--accent-primary]" />
          <h2 className="text-lg font-semibold text-[--text-primary]">Deployment</h2>
        </div>
        <dl className="grid grid-cols-1 gap-4 text-sm">
          <Field
            label="Environment"
            value={
              <span
                className={`px-2 py-1 text-xs font-bold rounded-full ${
                  isProd ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-800"
                }`}
              >
                {isProd ? "PRODUCTION" : "DEV/STAGING"}
              </span>
            }
          />
          <Field label="Convex Cloud URL" value={<code className="font-mono text-xs">{convexCloud}</code>} />
          <Field label="Admin API Base" value={<code className="font-mono text-xs">{adminApiBase}</code>} />
          {overview && (
            <>
              <Field
                label="Backend health"
                value={
                  <span
                    className={`px-2 py-1 text-xs font-semibold rounded-full ${
                      overview.health === "healthy"
                        ? "bg-green-100 text-green-700"
                        : overview.health === "idle"
                          ? "bg-yellow-100 text-yellow-700"
                          : "bg-red-100 text-red-700"
                    }`}
                  >
                    {overview.health.toUpperCase()}
                  </span>
                }
              />
              <Field
                label="Last LLM call"
                value={
                  overview.llm.lastCalledAt
                    ? new Date(overview.llm.lastCalledAt).toLocaleString()
                    : "never"
                }
              />
            </>
          )}
        </dl>
      </section>

      {/* Integrations / Server-side env — editable for super_admin */}
      <IntegrationsCard canEdit={session?.role === "super_admin"} />

      {/* CLI quick reference */}
      <section className="glass-card-static p-6 max-w-3xl">
        <div className="flex items-center gap-3 mb-5">
          <TerminalSquare className="h-5 w-5 text-[--accent-primary]" />
          <h2 className="text-lg font-semibold text-[--text-primary]">Operations</h2>
        </div>
        <div className="space-y-3 text-sm">
          <CodeBlock
            label="List Convex prod env vars"
            cmd={`CONVEX_DEPLOY_KEY="$CONVEX_PROD_DEPLOY_KEY" npx convex env list`}
          />
          <CodeBlock
            label="Set / rotate hCaptcha secret"
            cmd={`CONVEX_DEPLOY_KEY="$CONVEX_PROD_DEPLOY_KEY" npx convex env set HCAPTCHA_SECRET <value>`}
          />
          <CodeBlock
            label="Tail recent prod logs"
            cmd={`CONVEX_DEPLOY_KEY="$CONVEX_PROD_DEPLOY_KEY" npx convex logs --tail`}
          />
          <CodeBlock
            label="Import waitlist from Web3Forms CSV"
            cmd={`ATLAS_ADMIN_BASE=https://avid-oyster-465.convex.site ATLAS_ADMIN_KEY=… npx tsx scripts/import-waitlist-csv.ts <file.csv>`}
          />
          <CodeBlock
            label="Hot-reset admin password (super admin)"
            cmd={`CONVEX_DEPLOY_KEY="$CONVEX_PROD_DEPLOY_KEY" npx convex run 'store/admins:changePassword' '{"adminId":"<id>","newPasswordHash":"<bcrypt-hash>"}'`}
          />
        </div>
      </section>

      <p className="text-xs text-[--text-muted] max-w-3xl">
        This page is read-only by design. Changing secrets requires CLI access so the admin panel
        cannot accidentally leak them to a browser. Adding a feature flag or other safe toggle?
        Add it here as a controlled mutation gated by the <code>manage_settings</code> permission.
      </p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-[--text-muted] mb-1">{label}</dt>
      <dd className="text-[--text-primary]">{value}</dd>
    </div>
  );
}

function CodeBlock({ label, cmd }: { label: string; cmd: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[--text-muted] mb-1">{label}</p>
      <pre className="bg-gray-900 text-gray-100 rounded-lg p-3 text-xs font-mono overflow-x-auto">
        <code>{cmd}</code>
      </pre>
    </div>
  );
}
