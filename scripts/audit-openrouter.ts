// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Usage:  ADMIN_API_KEY=... npx tsx scripts/audit-openrouter.ts
// Optional:  BHAI_ENV=prod            # probe the prod Convex deployment
//            CONVEX_SITE_URL=https://...  # override the endpoint URL
//
// Calls the admin-gated /api/llm/audit Convex route; the server holds the
// OpenRouter key and returns /v1/models + /v1/credits. This script diffs
// the catalog against the model IDs Bhai references in src/llm.ts and
// reports gaps + same-provider alternates.

import "../src/config/env-compat.js"; // first: .env + ATLAS_* → BHAI_* mirror
import { MODELS } from "../src/llm.js";
import { getConvexSiteUrl } from "../src/config/keys.js";

interface ORModel {
    id: string;
    pricing?: { prompt?: string; completion?: string };
    context_length?: number;
}

interface ProbeResponse {
    models: { ok: boolean; status: number; data: { data?: ORModel[]; error?: unknown } };
    credits: { ok: boolean; status: number; data: { data?: { total_credits?: number; total_usage?: number }; error?: unknown } };
}

function fmtUSDPerMTok(rate: number | undefined): string {
    if (rate == null || Number.isNaN(rate)) return "—";
    return `$${(rate * 1_000_000).toFixed(2)}/M`;
}

async function main() {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey) {
        console.error("✗ ADMIN_API_KEY not set. Run:");
        console.error("    ADMIN_API_KEY=... npx tsx scripts/audit-openrouter.ts");
        process.exit(2);
    }

    const url = `${getConvexSiteUrl()}/api/llm/audit`;
    console.log(`— OpenRouter availability audit via ${url} —\n`);

    const r = await fetch(url, { headers: { Authorization: `Bearer ${adminKey}` } });
    if (!r.ok) {
        const body = await r.text();
        console.error(`✗ ${r.status} ${r.statusText}\n${body}`);
        process.exit(1);
    }
    const probe = (await r.json()) as ProbeResponse;

    if (probe.credits.ok && probe.credits.data.data) {
        const total = probe.credits.data.data.total_credits ?? 0;
        const used = probe.credits.data.data.total_usage ?? 0;
        console.log(`Credits: $${total.toFixed(2)} total, $${used.toFixed(2)} used, $${(total - used).toFixed(2)} remaining\n`);
    } else {
        console.warn(`⚠ /v1/credits: status=${probe.credits.status} ${JSON.stringify(probe.credits.data)}\n`);
    }

    if (!probe.models.ok || !probe.models.data.data) {
        console.error(`✗ /v1/models: status=${probe.models.status} ${JSON.stringify(probe.models.data)}`);
        process.exit(1);
    }
    const models = probe.models.data.data;
    const availableIds = new Set(models.map((m) => m.id));
    console.log(`Provider exposes ${models.length} models.\n`);

    console.log("— Bhai referenced models —");
    const referenced = Object.entries(MODELS) as Array<[string, string]>;
    const missing: Array<{ slot: string; id: string }> = [];
    for (const [slot, id] of referenced) {
        const ok = availableIds.has(id);
        const m = ok ? models.find((x) => x.id === id) : undefined;
        const mark = ok ? "✓" : "✗";
        const ctx = m?.context_length ? `ctx=${(m.context_length / 1000).toFixed(0)}k` : "";
        const pIn = m?.pricing?.prompt ? Number(m.pricing.prompt) : undefined;
        const pOut = m?.pricing?.completion ? Number(m.pricing.completion) : undefined;
        const price = pIn != null ? `in=${fmtUSDPerMTok(pIn)} out=${fmtUSDPerMTok(pOut)}` : "";
        console.log(`  ${mark} ${slot.padEnd(22)} ${id.padEnd(54)} ${ctx.padEnd(10)} ${price}`);
        if (!ok) missing.push({ slot, id });
    }

    if (missing.length === 0) {
        console.log("\nAll referenced models available on this key.");
        return;
    }

    console.log(`\n⚠ ${missing.length} model(s) NOT available — horizontal-failover kicks in on these:`);
    for (const r of missing) {
        const [provider] = r.id.split("/");
        const family = models
            .filter((m) => m.id.startsWith(`${provider}/`))
            .map((m) => m.id)
            .sort();
        console.log(`\n  ✗ ${r.id}  (slot ${r.slot})`);
        if (family.length > 0) {
            const suggest = family.slice(0, 6).join(", ");
            console.log(`     same-provider options: ${suggest}${family.length > 6 ? ", …" : ""}`);
        } else {
            console.log(`     no models from provider "${provider}" on this key`);
        }
    }
}

main().catch((err) => {
    console.error("✗ Audit failed:", (err as Error).message);
    process.exit(1);
});
