// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.

// Memory Studio AI insights — four cards summarizing the user's recent
// activity (mood / recurring theme / avoidance / most-discussed). Runs
// inside the nightly dream-replay job; one LLM call per pass for the
// recurring-theme labelling, everything else is templated SQL.

import { extractJSON } from "../utils/json-extract.js";
import type { LLMClient } from "../llm.js";
import { getRawDb } from "./sqlite.js";

export type InsightKind = "mood" | "recurring_theme" | "avoidance" | "most_discussed";

interface InsightRow {
    kind: InsightKind;
    title: string;
    body: string;
    evidenceIds: { kind: string; id: string }[];
    metricValue?: number;
    metricUnit?: string;
}

const POSITIVE = new Set(["happy", "joy", "calm", "excited", "proud", "grateful", "content", "hopeful", "amused"]);
const NEGATIVE = new Set([
    "sad", "angry", "frustrated", "anxious", "tired", "stressed", "scared", "lonely", "disappointed", "overwhelmed",
]);

function clampStr(s: string, max = 200): string {
    if (!s) return "";
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function persistInsight(windowDays: number, insight: InsightRow): void {
    const db = getRawDb();
    if (!db) return;
    db.prepare(
        `INSERT INTO memory_insights (kind, title, body, evidence_ids, metric_value, metric_unit, window_days)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        insight.kind,
        insight.title,
        insight.body,
        JSON.stringify(insight.evidenceIds),
        insight.metricValue ?? null,
        insight.metricUnit ?? null,
        windowDays,
    );
}

function computeMood(windowDays: number): InsightRow | null {
    const db = getRawDb();
    if (!db) return null;
    let rows: { id: string; emotion: string; intensity: number }[] = [];
    try {
        rows = db
            .prepare(
                `SELECT id, emotion, COALESCE(intensity, 0.5) AS intensity
                 FROM emotional_memory
                 WHERE timestamp > datetime('now', ?)`,
            )
            .all(`-${windowDays} days`) as { id: string; emotion: string; intensity: number }[];
    } catch {
        return null;
    }
    if (rows.length < 2) return null;

    let sum = 0;
    let count = 0;
    const evidence: { kind: string; id: string }[] = [];
    for (const r of rows) {
        const e = (r.emotion || "").toLowerCase();
        const polarity = POSITIVE.has(e) ? 1 : NEGATIVE.has(e) ? -1 : 0;
        sum += polarity * (r.intensity ?? 0.5);
        count += 1;
        if (evidence.length < 6) evidence.push({ kind: "emotion", id: r.id });
    }
    const valence = count > 0 ? sum / count : 0;

    let title: string;
    let body: string;
    if (valence > 0.4) {
        title = "A bright stretch";
        body = `Your week leaned warm — positive notes outnumbered the rough ones across ${count} moments.`;
    } else if (valence > 0.1) {
        title = "Mostly steady";
        body = `Tone was even-keeled this week with a slight lift. ${count} emotional notes recorded.`;
    } else if (valence > -0.1) {
        title = "Mixed but balanced";
        body = `${count} emotional notes this week — a roughly even split between bright and heavy moments.`;
    } else if (valence > -0.4) {
        title = "Heavier than usual";
        body = `The tone tipped toward strain this week across ${count} emotional notes.`;
    } else {
        title = "A hard week";
        body = `Most of the week's emotional notes leaned negative (${count} recorded). Worth a check-in.`;
    }

    return {
        kind: "mood",
        title,
        body,
        evidenceIds: evidence,
        metricValue: valence,
        metricUnit: "valence",
    };
}

async function computeRecurringTheme(llm: LLMClient | null, windowDays: number): Promise<InsightRow | null> {
    const db = getRawDb();
    if (!db) return null;
    type CountRow = { token: string; cnt: number };
    let rows: CountRow[] = [];
    try {
        rows = db
            .prepare(
                `SELECT category AS token, COUNT(*) AS cnt
                 FROM memories
                 WHERE consolidated_into IS NULL
                   AND created_at > datetime('now', ?)
                   AND category IS NOT NULL AND category != ''
                 GROUP BY category
                 ORDER BY cnt DESC
                 LIMIT 5`,
            )
            .all(`-${windowDays} days`) as CountRow[];
    } catch {
        return null;
    }
    if (rows.length === 0) return null;

    const top = rows[0];
    let title = top.token.replace(/_/g, " ");
    let body = `${top.cnt} memories landed under "${top.token}" in the last ${windowDays} days — your most-touched theme.`;

    // Optional: one LLM call to give the theme a friendlier label.
    if (llm) {
        try {
            const response = await llm.chat({
                messages: [
                    {
                        role: "user",
                        content: `Given these memory categories with counts, pick the top theme and produce a short human-readable label (2-4 words) plus a one-sentence body (≤180 chars). Output ONLY JSON like {"title":"...","body":"..."}.\n\n${rows
                            .map((r) => `- ${r.token} × ${r.cnt}`)
                            .join("\n")}`,
                    },
                ],
                systemPrompt: "You produce concise, friendly summaries. Output strict JSON only.",
                modelOverride: "openai/gpt-4.1-nano",
                responseFormat: "json_object",
            });
            const text = response.choices?.[0]?.message?.content || "";
            const jsonStr = extractJSON(text);
            if (jsonStr) {
                const parsed = JSON.parse(jsonStr) as { title?: unknown; body?: unknown };
                if (typeof parsed.title === "string" && parsed.title.trim()) title = clampStr(parsed.title.trim(), 40);
                if (typeof parsed.body === "string" && parsed.body.trim()) body = clampStr(parsed.body.trim(), 200);
            }
        } catch {
            /* fall through to template */
        }
    }

    // Pull a few evidence memory ids for this category.
    const evidenceRows = (() => {
        try {
            return db
                .prepare(
                    `SELECT id FROM memories
                     WHERE consolidated_into IS NULL AND category = ?
                       AND created_at > datetime('now', ?)
                     ORDER BY (importance * 0.6 + decay_score * 0.4) DESC LIMIT 5`,
                )
                .all(top.token, `-${windowDays} days`) as { id: number }[];
        } catch {
            return [];
        }
    })();

    return {
        kind: "recurring_theme",
        title,
        body,
        evidenceIds: evidenceRows.map((r) => ({ kind: "memory", id: String(r.id) })),
        metricValue: top.cnt,
        metricUnit: "count",
    };
}

function computeAvoidance(windowDays: number): InsightRow | null {
    const db = getRawDb();
    if (!db) return null;
    try {
        type Row = { token: string; cnt: number };
        const before = db
            .prepare(
                `SELECT category AS token, COUNT(*) AS cnt
                 FROM memories
                 WHERE consolidated_into IS NULL
                   AND created_at < datetime('now', ?)
                   AND created_at > datetime('now', ?)
                   AND category IS NOT NULL AND category != ''
                 GROUP BY category
                 HAVING cnt >= 3`,
            )
            .all(`-${windowDays} days`, `-${windowDays * 5} days`) as Row[];

        if (before.length === 0) return null;

        const recent = db
            .prepare(
                `SELECT category AS token FROM memories
                 WHERE consolidated_into IS NULL
                   AND created_at > datetime('now', ?)
                   AND category IS NOT NULL`,
            )
            .all(`-${windowDays} days`) as { token: string }[];
        const recentSet = new Set(recent.map((r) => r.token));
        const dropped = before
            .filter((b) => !recentSet.has(b.token))
            .sort((a, b) => b.cnt - a.cnt);
        if (dropped.length === 0) return null;
        const top = dropped[0];
        return {
            kind: "avoidance",
            title: top.token.replace(/_/g, " "),
            body: `You used to log "${top.token}" memories often (${top.cnt} in the prior month) but haven't this week.`,
            evidenceIds: [],
            metricValue: top.cnt,
            metricUnit: "count",
        };
    } catch {
        return null;
    }
}

function computeMostDiscussed(windowDays: number): InsightRow | null {
    const db = getRawDb();
    if (!db) return null;
    try {
        type EntRow = { id: number; name: string };
        const top = db
            .prepare(
                `SELECT id, name FROM entities
                 WHERE last_accessed_at > datetime('now', ?)
                 ORDER BY last_accessed_at DESC
                 LIMIT 1`,
            )
            .get(`-${windowDays} days`) as EntRow | undefined;
        if (!top) return null;
        const sample = db
            .prepare(
                `SELECT id, content FROM memories
                 WHERE (',' || lower(tags) || ',') LIKE ('%,' || lower(?) || ',%')
                   AND consolidated_into IS NULL
                 ORDER BY accessed_at DESC LIMIT 5`,
            )
            .all(top.name) as { id: number; content: string }[];
        return {
            kind: "most_discussed",
            title: top.name,
            body: sample.length > 0
                ? `${top.name} keeps coming up — surfaced in ${sample.length} recent memories.`
                : `${top.name} was the most-touched person/thing this week.`,
            evidenceIds: [
                { kind: "entity", id: String(top.id) },
                ...sample.slice(0, 3).map((s) => ({ kind: "memory", id: String(s.id) })),
            ],
            metricValue: sample.length,
            metricUnit: "frequency",
        };
    } catch {
        return null;
    }
}

export async function runStudioInsights(llm: LLMClient | null, windowDays = 7): Promise<{ generated: number }> {
    const insights: InsightRow[] = [];

    const mood = computeMood(windowDays);
    if (mood) insights.push(mood);

    const theme = await computeRecurringTheme(llm, windowDays);
    if (theme) insights.push(theme);

    const avoidance = computeAvoidance(windowDays);
    if (avoidance) insights.push(avoidance);

    const discussed = computeMostDiscussed(windowDays);
    if (discussed) insights.push(discussed);

    for (const i of insights) {
        try {
            persistInsight(windowDays, i);
        } catch {
            /* persistence failure shouldn't kill the rest */
        }
    }

    return { generated: insights.length };
}

export interface StudioInsightCard {
    id: number;
    kind: InsightKind;
    title: string;
    body: string;
    evidenceIds: { kind: string; id: string }[];
    metricValue: number | null;
    metricUnit: string | null;
    computedAt: string;
    windowDays: number;
}

export function getLatestInsights(): StudioInsightCard[] {
    const db = getRawDb();
    if (!db) return [];
    try {
        const rows = db
            .prepare(
                `SELECT id, kind, title, body, evidence_ids, metric_value, metric_unit, computed_at, window_days
                 FROM memory_insights
                 WHERE id IN (SELECT MAX(id) FROM memory_insights GROUP BY kind)
                 ORDER BY CASE kind
                     WHEN 'mood' THEN 1
                     WHEN 'recurring_theme' THEN 2
                     WHEN 'avoidance' THEN 3
                     WHEN 'most_discussed' THEN 4
                     ELSE 5 END`,
            )
            .all() as {
            id: number;
            kind: InsightKind;
            title: string;
            body: string;
            evidence_ids: string;
            metric_value: number | null;
            metric_unit: string | null;
            computed_at: string;
            window_days: number;
        }[];
        return rows.map((r) => {
            let evidenceIds: { kind: string; id: string }[] = [];
            try {
                const parsed = JSON.parse(r.evidence_ids || "[]");
                if (Array.isArray(parsed)) {
                    evidenceIds = parsed.filter(
                        (e) => e && typeof e === "object" && typeof e.kind === "string" && typeof e.id === "string",
                    );
                }
            } catch {
                /* corrupt JSON — skip */
            }
            return {
                id: r.id,
                kind: r.kind,
                title: r.title,
                body: r.body,
                evidenceIds,
                metricValue: r.metric_value,
                metricUnit: r.metric_unit,
                computedAt: r.computed_at,
                windowDays: r.window_days,
            };
        });
    } catch {
        return [];
    }
}
