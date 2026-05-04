// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Usage:  OPENROUTER_API_KEY=sk-or-... tsx scripts/audit-openrouter.ts
//
// Probes OpenRouter's /v1/models + /v1/credits with the supplied key and
// diffs the returned model list against the IDs referenced from src/llm.ts.
// Output: gap table + credit/plan summary + suggested substitutes.

import { MODELS, MODEL_DISPLAY } from "../src/llm.js";

interface ORModel {
    id: string;
    pricing?: { prompt?: string; completion?: string };
    context_length?: number;
}

interface ORCredits {
    data?: { total_credits?: number; total_usage?: number };
}

async function fetchJson<T>(url: string, key: string): Promise<T> {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
}

function fmtUSD(n: number | undefined): string {
    return n == null ? "—" : `$${n.toFixed(4)}`;
}

async function main() {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
        console.error("✗ OPENROUTER_API_KEY not set. Run:");
        console.error("    OPENROUTER_API_KEY=sk-or-... npx tsx scripts/audit-openrouter.ts");
        process.exit(2);
    }

    console.log("— OpenRouter availability audit —\n");

    try {
        const credits = await fetchJson<ORCredits>(
            "https://openrouter.ai/api/v1/credits",
            key,
        );
        const total = credits.data?.total_credits ?? 0;
        const used = credits.data?.total_usage ?? 0;
        console.log(`Credits: $${total.toFixed(2)} total, $${used.toFixed(2)} used, $${(total - used).toFixed(2)} remaining\n`);
    } catch (err) {
        console.warn(`⚠ /v1/credits failed: ${(err as Error).message}\n`);
    }

    const { data: models } = await fetchJson<{ data: ORModel[] }>(
        "https://openrouter.ai/api/v1/models",
        key,
    );
    const availableIds = new Set(models.map((m) => m.id));
    console.log(`Provider exposes ${models.length} models.\n`);

    console.log("— ATLAS referenced models —");
    const referenced = Object.entries(MODELS) as Array<[keyof typeof MODELS, string]>;
    const missing: Array<{ slot: string; id: string }> = [];
    for (const [slot, id] of referenced) {
        const ok = availableIds.has(id);
        const m = ok ? models.find((x) => x.id === id) : undefined;
        const mark = ok ? "✓" : "✗";
        const ctx = m?.context_length ? `ctx=${(m.context_length / 1000).toFixed(0)}k` : "";
        const price = m?.pricing?.prompt
            ? `in=${fmtUSD(Number(m.pricing.prompt) * 1000)}/1k out=${fmtUSD(Number(m.pricing.completion) * 1000)}/1k`
            : "";
        console.log(`  ${mark} ${String(slot).padEnd(20)} ${id.padEnd(48)} ${ctx.padEnd(10)} ${price}`);
        if (!ok) missing.push({ slot: String(slot), id });
    }

    if (missing.length === 0) {
        console.log("\nAll referenced models available on this key.");
        return;
    }

    console.log(`\n⚠ ${missing.length} model(s) NOT available — fallback will kick in on these:`);
    for (const r of missing) {
        const [provider] = r.id.split("/");
        const family = models
            .filter((m) => m.id.startsWith(`${provider}/`))
            .map((m) => m.id)
            .sort();
        console.log(`\n  ✗ ${r.id}  (slot ${r.slot})`);
        if (family.length > 0) {
            console.log(`     try: ${family.slice(0, 5).join(", ")}${family.length > 5 ? ", …" : ""}`);
        } else {
            console.log(`     no models from provider "${provider}" on this key`);
        }
    }
}

main().catch((err) => {
    console.error("✗ Audit failed:", (err as Error).message);
    process.exit(1);
});
