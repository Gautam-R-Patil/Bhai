// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

// Self-improvement synthesis pipeline. Runs as part of nightly dream replay.
// For each slug with local drafts: fetch the user's current server-side
// addendum, ask Sonnet 4.6 to merge "current + today's drafts" into one
// coherent version, POST the result to /api/user/addendum/upsert, then
// delete the local drafts. Drafts survive across nights on failure.

import type { LLMClient } from "../llm.js";
import { MODELS } from "../llm.js";
import { getDraftSlugs, listDrafts, discardDraftsBySlug, discardStaleDrafts, type DraftRow } from "../memory/self-improvement-drafts.js";
import { getSessionToken, handleAuthError } from "../session.js";
import { getConvexSiteUrl } from "../config/keys.js";
import { encryptedFetch } from "../crypto-transport.js";

// Server-stored addendum returned by GET /api/user/addendum/list
interface ServerAddendum {
    slug: string;
    kind: "personality" | "skill" | "memory";
    title: string;
    content: string;
    version: number;
    isActive: boolean;
}

const MAX_MERGED_BYTES = 50_000;

async function fetchCurrentAddenda(): Promise<ServerAddendum[]> {
    const token = await getSessionToken();
    if (!token) return [];
    const url = `${getConvexSiteUrl()}/api/user/addendum/list`;
    let res = await encryptedFetch(url, {
        method: "GET",
        headers: { "Authorization": `Bearer ${token}` },
    });
    if (res.status === 401) {
        const refreshed = await handleAuthError();
        if (!refreshed) return [];
        res = await encryptedFetch(url, {
            method: "GET",
            headers: { "Authorization": `Bearer ${refreshed}` },
        });
    }
    if (!res.ok) return [];
    const body = await res.json() as { addenda?: ServerAddendum[] };
    return Array.isArray(body.addenda) ? body.addenda : [];
}

async function uploadAddendum(args: {
    slug: string;
    kind: "personality" | "skill" | "memory";
    title: string;
    content: string;
    reason: string;
}): Promise<{ ok: boolean; status?: number; error?: string; version?: number }> {
    const token = await getSessionToken();
    if (!token) return { ok: false, error: "no session token" };
    const url = `${getConvexSiteUrl()}/api/user/addendum/upsert`;
    const send = async (t: string) => encryptedFetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
    });
    let res = await send(token);
    if (res.status === 401) {
        const refreshed = await handleAuthError();
        if (!refreshed) return { ok: false, error: "auth refresh failed" };
        res = await send(refreshed);
    }
    const body = await res.json().catch(() => ({})) as { success?: boolean; error?: string; version?: number };
    if (!res.ok || body.success === false) {
        return { ok: false, status: res.status, error: body.error || `HTTP ${res.status}` };
    }
    return { ok: true, version: body.version };
}

function deriveTitleFromSlug(slug: string, kind: ServerAddendum["kind"]): string {
    if (slug === "self-improvement") return "Self-improvement notes";
    if (slug.startsWith("skill-")) {
        const topic = slug.replace(/^skill-/, "").replace(/-/g, " ");
        return `Skill: ${topic}`;
    }
    if (slug.startsWith("memory-")) {
        const topic = slug.replace(/^memory-/, "").replace(/-/g, " ");
        return `Memory: ${topic}`;
    }
    return `${kind}: ${slug}`;
}

async function synthesizeMergedContent(args: {
    llm: LLMClient;
    slug: string;
    kind: ServerAddendum["kind"];
    currentContent: string;
    drafts: DraftRow[];
}): Promise<string | null> {
    const { llm, slug, kind, currentContent, drafts } = args;
    const draftBlock = drafts
        .map((d, i) => `--- Draft ${i + 1} (reason: ${d.reason})\n${d.content}`)
        .join("\n\n");
    const currentBlock = currentContent.trim().length > 0
        ? `Current addendum (version on server):\n${currentContent}\n\n`
        : "No current addendum exists for this slug yet.\n\n";

    const systemPrompt = `You are merging incremental self-improvement drafts into a single coherent ${kind} addendum that will be appended to the agent's system prompt for this user. Output ONLY the merged markdown body — no preamble, no explanation, no fenced code blocks around the body. Keep it under 6KB. Resolve contradictions by preferring the most recent draft. Deduplicate near-identical points. Drop drafts that turned out to be wrong (e.g. user reverted a behavior change in a later draft).`;

    const userPrompt = `Slug: ${slug}\nKind: ${kind}\n\n${currentBlock}New drafts from today (oldest first):\n\n${draftBlock}\n\nProduce the merged markdown body now:`;

    try {
        const resp = await llm.chat({
            messages: [{ role: "user", content: userPrompt }],
            systemPrompt,
            modelOverride: MODELS.SONNET,
        });
        const text = resp?.choices?.[0]?.message?.content;
        if (typeof text !== "string" || text.trim().length < 10) return null;
        let merged = text.trim();
        // Strip any accidental code-fence wrap
        merged = merged.replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i, "$1").trim();
        // Cap size
        const bytes = new TextEncoder().encode(merged).length;
        if (bytes > MAX_MERGED_BYTES) {
            merged = merged.slice(0, MAX_MERGED_BYTES);
        }
        return merged;
    } catch (err) {
        console.warn(`[SELF-IMPROVE-SYNTH] LLM merge failed for ${slug}:`, (err as Error).message);
        return null;
    }
}

export interface SynthesisResult {
    slug: string;
    draftsProcessed: number;
    success: boolean;
    error?: string;
    version?: number;
}

// Poison-pill TTL — drafts that haven't merged after this long get discarded.
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Sanity cap on slugs processed per night. Bounds Sonnet cost + upload
// volume if an agent drafts to many unique slugs (drift / bug / compromise).
const MAX_SLUGS_PER_NIGHT = 25;

export async function runSelfImprovementSynthesis(llm: LLMClient): Promise<SynthesisResult[]> {
    const results: SynthesisResult[] = [];

    // Evict drafts that have been failing upload for too long.
    try {
        const evicted = discardStaleDrafts(DRAFT_MAX_AGE_MS);
        if (evicted > 0) {
            console.log(`[SELF-IMPROVE-SYNTH] evicted ${evicted} stale draft(s) (>7 days old)`);
        }
    } catch (err) {
        console.warn("[SELF-IMPROVE-SYNTH] stale-draft eviction failed (non-fatal):", (err as Error).message);
    }

    let slugs: string[];
    try {
        slugs = getDraftSlugs();
    } catch (err) {
        console.warn("[SELF-IMPROVE-SYNTH] couldn't list drafts:", (err as Error).message);
        return results;
    }
    if (slugs.length === 0) {
        return results;
    }

    // Cap fanout so a drifted agent can't trigger 1000 Sonnet calls in one night.
    if (slugs.length > MAX_SLUGS_PER_NIGHT) {
        console.warn(`[SELF-IMPROVE-SYNTH] ${slugs.length} slugs exceeds cap of ${MAX_SLUGS_PER_NIGHT}; processing first ${MAX_SLUGS_PER_NIGHT}, deferring rest`);
        slugs = slugs.slice(0, MAX_SLUGS_PER_NIGHT);
    }

    console.log(`[SELF-IMPROVE-SYNTH] 🌙 ${slugs.length} slug(s) with drafts to synthesize`);

    let serverAddenda: ServerAddendum[] = [];
    try {
        serverAddenda = await fetchCurrentAddenda();
    } catch (err) {
        console.warn("[SELF-IMPROVE-SYNTH] fetchCurrentAddenda failed:", (err as Error).message);
        // Continue with empty server state — drafts will become the initial content
    }
    const byslug = new Map<string, ServerAddendum>();
    for (const a of serverAddenda) byslug.set(a.slug, a);

    for (const slug of slugs) {
        const drafts = listDrafts(slug);
        if (drafts.length === 0) continue;
        const kind = drafts[0].kind; // all drafts for a slug share kind by construction
        // Capture the highest draft id at merge-time so we only delete what we
        // actually merged. New drafts inserted during the LLM call / upload
        // survive to the next synthesis cycle. Race fix.
        const maxId = drafts.reduce((m, d) => (d.id > m ? d.id : m), 0);
        const current = byslug.get(slug);
        const currentContent = current?.content ?? "";

        // Strip any leading markdown headers from drafts before merging — the
        // synthesis prompt asks Sonnet to do this but we belt-and-suspender it.
        const sanitizedDrafts = drafts.map((d) => ({
            ...d,
            content: d.content.replace(/^#{1,6}\s+/gm, ""),
        }));

        const merged = await synthesizeMergedContent({ llm, slug, kind, currentContent, drafts: sanitizedDrafts });
        if (!merged) {
            console.warn(`[SELF-IMPROVE-SYNTH] skipping ${slug} — merge returned null`);
            results.push({ slug, draftsProcessed: drafts.length, success: false, error: "merge produced no output" });
            continue;
        }

        const title = current?.title ?? deriveTitleFromSlug(slug, kind);
        // Sanitize reason text — agent-supplied; could contain secrets it
        // accidentally quoted from a tool result.
        let sanitizedReason: string;
        try {
            const { sanitizeSecrets } = await import("../security/secrets-sanitizer.js");
            const raw = `Nightly synthesis of ${drafts.length} draft(s); reasons: ${drafts.map((d) => d.reason).join(" | ").slice(0, 400)}`;
            sanitizedReason = sanitizeSecrets(raw).sanitized.slice(0, 500);
        } catch {
            sanitizedReason = `Nightly synthesis of ${drafts.length} draft(s)`;
        }

        const upload = await uploadAddendum({ slug, kind, title, content: merged, reason: sanitizedReason });
        if (!upload.ok) {
            console.warn(`[SELF-IMPROVE-SYNTH] upload failed for ${slug}: ${upload.error}`);
            results.push({ slug, draftsProcessed: drafts.length, success: false, error: upload.error });
            continue;
        }

        try {
            // Race-safe: only delete rows whose id ≤ maxId. Drafts added during
            // synthesis (id > maxId) persist for the next cycle.
            discardDraftsBySlug(slug, maxId);
        } catch (err) {
            console.warn(`[SELF-IMPROVE-SYNTH] post-upload draft cleanup failed for ${slug}:`, (err as Error).message);
        }
        console.log(`[SELF-IMPROVE-SYNTH] ✅ ${slug}: ${drafts.length} drafts merged → server v${upload.version}`);
        results.push({ slug, draftsProcessed: drafts.length, success: true, version: upload.version });
    }
    return results;
}
