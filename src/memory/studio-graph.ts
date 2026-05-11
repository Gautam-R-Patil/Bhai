// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.

// Memory Studio graph builder. Returns a renderer-friendly snapshot of the
// user's memory: synthetic "you" node + entities, traits, episodes, memories,
// emotions, with KG / mention / provenance edges. The desktop main process
// mirrors this SQL inline so the renderer can fetch without importing TS.

import { getRawDb } from "./sqlite.js";

export type StudioNodeKind =
    | "you"
    | "memory"
    | "entity"
    | "episode"
    | "trait"
    | "emotion"
    | "goal"
    | "task_learning"
    | "world_model"
    | "self_state";

export type StudioEdgeKind = "kg" | "mention" | "provenance" | "similarity";

export interface StudioNode {
    id: string;
    kind: StudioNodeKind;
    label: string;
    fullText: string;
    importance: number;
    recency: number;
    size: number;
    color: string;
    pinned: boolean;
    tags: string[];
    category?: string;
    createdAt: string;
    accessCount?: number;
    meta?: Record<string, unknown>;
}

export interface StudioEdge {
    source: string;
    target: string;
    kind: StudioEdgeKind;
    label?: string;
    strength: number;
    weight: number;
}

export interface StudioGraph {
    nodes: StudioNode[];
    edges: StudioEdge[];
    meta: {
        centerId: string;
        nodeCount: number;
        edgeCount: number;
        truncated: boolean;
        generatedAt: string;
    };
}

export interface BuildGraphOpts {
    centerOnUser?: boolean;
    hops?: number;
    includeAdvanced?: boolean;
    includeSimilarity?: boolean;
    similarityThreshold?: number;
    windowDays?: number | null;
    maxNodes?: number;
    searchQuery?: string;
}

const COLOR_BY_KIND: Record<StudioNodeKind, string> = {
    you: "var(--accent-primary)",
    entity: "var(--orb-mint)",
    trait: "var(--orb-amber)",
    episode: "var(--orb-lavender)",
    memory: "var(--orb-cobalt)",
    emotion: "var(--orb-peach)",
    goal: "var(--text-muted)",
    task_learning: "var(--text-muted)",
    world_model: "var(--text-muted)",
    self_state: "var(--text-muted)",
};

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}

function recencyScore(ts: string | null | undefined): number {
    if (!ts) return 0;
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t)) return 0;
    const days = (Date.now() - t) / 86_400_000;
    if (days <= 1) return 1;
    if (days >= 90) return 0;
    return clamp01(1 - days / 90);
}

// "Active" = the node had user-facing activity in the last 7 days (recency
// 1 - 7/90 ≈ 0.922). Cheap derived flag the renderer uses for the pulse glow.
function isActive(recency: number): boolean {
    return recency >= 0.92;
}

function nodeSize(importance: number, recency: number): number {
    // Wider spread than the original 8-30 so visual hierarchy actually reads:
    // unimportant nodes shrink to ~6, top-tier hubs reach ~38.
    return 6 + clamp01(importance) * 22 + clamp01(recency) * 10;
}

function truncate(text: string, max = 60): string {
    if (!text) return "";
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + "…";
}

function parseTags(raw: unknown): string[] {
    if (!raw || typeof raw !== "string") return [];
    return raw
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
}

export function buildStudioGraph(opts: BuildGraphOpts = {}): StudioGraph {
    const {
        centerOnUser = true,
        includeAdvanced = false,
        windowDays = 90,
        maxNodes = 400,
        searchQuery = "",
    } = opts;

    const db = getRawDb();
    if (!db) {
        return {
            nodes: [],
            edges: [],
            meta: {
                centerId: "you",
                nodeCount: 0,
                edgeCount: 0,
                truncated: false,
                generatedAt: new Date().toISOString(),
            },
        };
    }

    const nodes: StudioNode[] = [];
    const edges: StudioEdge[] = [];
    const memIds = new Set<number>();
    const entIds = new Set<number>();

    if (centerOnUser) {
        nodes.push({
            id: "you",
            kind: "you",
            label: "You",
            fullText: "You",
            importance: 1,
            recency: 1,
            size: 30,
            color: COLOR_BY_KIND.you,
            pinned: true,
            tags: [],
            createdAt: new Date().toISOString(),
        });
    }

    const windowClause = windowDays ? `AND created_at > datetime('now','-${windowDays} days')` : "";

    // ── Memories ──
    const memBudget = Math.max(40, Math.floor(maxNodes * 0.3));
    let memQuery: string;
    let memParams: unknown[] = [];
    if (searchQuery) {
        memQuery = `SELECT id, content, category, tags, importance, created_at, accessed_at, access_count, decay_score
                    FROM memories
                    WHERE consolidated_into IS NULL
                      AND (content LIKE ? OR tags LIKE ?)
                    ORDER BY (importance * 0.6 + decay_score * 0.4) DESC
                    LIMIT ?`;
        const like = `%${searchQuery}%`;
        memParams = [like, like, memBudget];
    } else {
        memQuery = `SELECT id, content, category, tags, importance, created_at, accessed_at, access_count, decay_score
                    FROM memories
                    WHERE consolidated_into IS NULL ${windowClause}
                    ORDER BY (importance * 0.6 + decay_score * 0.4) DESC
                    LIMIT ?`;
        memParams = [memBudget];
    }

    type MemRow = {
        id: number;
        content: string;
        category: string | null;
        tags: string | null;
        importance: number | null;
        created_at: string;
        accessed_at: string | null;
        access_count: number | null;
        decay_score: number | null;
    };

    try {
        const rows = db.prepare(memQuery).all(...memParams) as MemRow[];
        // Group by category so each cluster gets a synthetic anchor and
        // every memory is reachable from "you" via its bucket.
        const buckets = new Map<string, MemRow[]>();
        for (const r of rows) {
            const cat = (r.category || "general").trim() || "general";
            if (!buckets.has(cat)) buckets.set(cat, []);
            buckets.get(cat)!.push(r);
        }
        const anchored = new Set<string>();
        for (const [cat, rs] of buckets) {
            if (rs.length < 2) continue;
            anchored.add(cat);
            const recencyMax = rs.reduce(
                (m, r) => Math.max(m, recencyScore(r.accessed_at || r.created_at)),
                0,
            );
            nodes.push({
                id: `cat:${cat}`,
                kind: "memory",
                label: cat.replace(/_/g, " "),
                fullText: `${rs.length} memories tagged "${cat}"`,
                importance: 0.7,
                recency: recencyMax,
                size: nodeSize(0.55, recencyMax) + 4,
                color: COLOR_BY_KIND.memory,
                pinned: false,
                tags: [cat],
                category: cat,
                createdAt: rs[0].created_at,
                meta: { active: isActive(recencyMax), isCategoryAnchor: true, count: rs.length },
            });
            if (centerOnUser) {
                edges.push({
                    source: "you",
                    target: `cat:${cat}`,
                    kind: "kg",
                    label: "remembers",
                    strength: 0.4 + recencyMax * 0.3,
                    weight: rs.length,
                });
            }
        }
        for (const r of rows) {
            const importance = clamp01((r.importance ?? 5) / 10);
            const recency = recencyScore(r.accessed_at || r.created_at);
            memIds.add(r.id);
            const score = importance * 0.6 + (r.decay_score ?? 1) * 0.4;
            const cat = (r.category || "general").trim() || "general";
            nodes.push({
                id: `mem:${r.id}`,
                kind: "memory",
                label: truncate(r.content),
                fullText: r.content,
                importance,
                recency,
                size: nodeSize(importance, recency),
                color: COLOR_BY_KIND.memory,
                pinned: false,
                tags: parseTags(r.tags),
                category: r.category || undefined,
                createdAt: r.created_at,
                accessCount: r.access_count ?? 0,
                meta: { decayScore: r.decay_score ?? 1, active: isActive(recency) },
            });
            if (anchored.has(cat)) {
                edges.push({
                    source: `cat:${cat}`,
                    target: `mem:${r.id}`,
                    kind: "mention",
                    label: cat,
                    strength: 0.4 + score * 0.3,
                    weight: score,
                });
            } else if (centerOnUser) {
                edges.push({
                    source: "you",
                    target: `mem:${r.id}`,
                    kind: "kg",
                    label: "remembers",
                    strength: 0.18 + score * 0.25,
                    weight: score,
                });
            }
        }
    } catch {
        /* memories table missing — skip */
    }

    // ── Entities ──
    type EntRow = {
        id: number;
        name: string;
        type: string;
        properties: string;
        last_accessed_at: string | null;
        created_at: string;
    };
    const entBudget = Math.max(20, Math.floor(maxNodes * 0.2));
    try {
        const entRows = db
            .prepare(
                `SELECT id, name, type, properties, last_accessed_at, created_at
                 FROM entities
                 ${searchQuery ? "WHERE name LIKE ?" : ""}
                 ORDER BY COALESCE(last_accessed_at, created_at) DESC
                 LIMIT ?`,
            )
            .all(...(searchQuery ? [`%${searchQuery}%`, entBudget] : [entBudget])) as EntRow[];
        for (const r of entRows) {
            entIds.add(r.id);
            const recency = recencyScore(r.last_accessed_at || r.created_at);
            nodes.push({
                id: `ent:${r.id}`,
                kind: "entity",
                label: truncate(r.name, 40),
                fullText: r.name,
                importance: 0.6,
                recency,
                size: nodeSize(0.6, recency),
                color: COLOR_BY_KIND.entity,
                pinned: false,
                tags: [],
                createdAt: r.created_at,
                meta: { entityType: r.type, active: isActive(recency) },
            });
            if (centerOnUser) {
                edges.push({
                    source: "you",
                    target: `ent:${r.id}`,
                    kind: "kg",
                    label: "knows",
                    strength: 0.3 + recency * 0.3,
                    weight: 1,
                });
            }
        }
    } catch {
        /* entities table missing */
    }

    // ── Traits ──
    type TraitRow = {
        trait_key: string;
        value: string;
        confidence: number;
        topics: string | null;
        reinforcement_count: number | null;
        last_seen_ts: string | null;
        created_at: string;
    };
    try {
        const traitRows = db
            .prepare(
                `SELECT trait_key, value, confidence, topics, reinforcement_count, last_seen_ts, created_at
                 FROM behavioral_traits
                 WHERE confidence > 0.3
                 ${searchQuery ? "AND (trait_key LIKE ? OR value LIKE ?)" : ""}
                 ORDER BY confidence DESC
                 LIMIT 40`,
            )
            .all(...(searchQuery ? [`%${searchQuery}%`, `%${searchQuery}%`] : [])) as TraitRow[];
        for (const r of traitRows) {
            const recency = recencyScore(r.last_seen_ts || r.created_at);
            const importance = clamp01(r.confidence);
            nodes.push({
                id: `trait:${r.trait_key}`,
                kind: "trait",
                label: r.trait_key.replace(/_/g, " "),
                fullText: r.value,
                importance,
                recency,
                size: nodeSize(importance, recency),
                color: COLOR_BY_KIND.trait,
                pinned: false,
                tags: r.topics ? safeJsonArray(r.topics) : [],
                createdAt: r.created_at,
                meta: {
                    confidence: r.confidence,
                    reinforcements: r.reinforcement_count ?? 0,
                    active: isActive(recency),
                },
            });
            if (centerOnUser) {
                // Trait→you edges deliberately very weak: traits should orbit
                // at a distance, not collapse into a tight ring around the user.
                edges.push({
                    source: "you",
                    target: `trait:${r.trait_key}`,
                    kind: "kg",
                    label: "trait",
                    strength: 0.05 + clamp01(r.confidence) * 0.05,
                    weight: r.confidence,
                });
            }
        }
    } catch {
        /* traits table missing */
    }

    // ── Episodes ──
    type EpiRow = {
        id: string;
        type: string;
        description: string;
        importance_score: number | null;
        timestamp: string;
    };
    try {
        const epiRows = db
            .prepare(
                `SELECT id, type, description, importance_score, timestamp
                 FROM episodic_memory
                 ${searchQuery ? "WHERE description LIKE ?" : ""}
                 ORDER BY timestamp DESC
                 LIMIT 30`,
            )
            .all(...(searchQuery ? [`%${searchQuery}%`] : [])) as EpiRow[];
        for (const r of epiRows) {
            const importance = clamp01(r.importance_score ?? 0.5);
            const recency = recencyScore(r.timestamp);
            nodes.push({
                id: `epi:${r.id}`,
                kind: "episode",
                label: truncate(r.description, 50),
                fullText: r.description,
                importance,
                recency,
                size: nodeSize(importance, recency),
                color: COLOR_BY_KIND.episode,
                pinned: false,
                tags: [r.type],
                createdAt: r.timestamp,
                meta: { episodeType: r.type, active: isActive(recency) },
            });
            if (centerOnUser) {
                edges.push({
                    source: "you",
                    target: `epi:${r.id}`,
                    kind: "kg",
                    label: "lived",
                    strength: 0.2 + importance * 0.3,
                    weight: importance,
                });
            }
        }
    } catch {
        /* episodic_memory missing */
    }

    // ── Emotions (last 30 days) ──
    type EmoRow = {
        id: string;
        emotion: string;
        context: string;
        intensity: number | null;
        timestamp: string;
    };
    try {
        const emoRows = db
            .prepare(
                `SELECT id, emotion, context, intensity, timestamp
                 FROM emotional_memory
                 WHERE timestamp > datetime('now','-30 days')
                 ORDER BY intensity DESC
                 LIMIT 30`,
            )
            .all() as EmoRow[];
        for (const r of emoRows) {
            const importance = clamp01(r.intensity ?? 0.5);
            const recency = recencyScore(r.timestamp);
            nodes.push({
                id: `emo:${r.id}`,
                kind: "emotion",
                label: r.emotion,
                fullText: `${r.emotion} — ${r.context}`,
                importance,
                recency,
                size: nodeSize(importance, recency),
                color: COLOR_BY_KIND.emotion,
                pinned: false,
                tags: [],
                createdAt: r.timestamp,
                meta: { intensity: r.intensity, active: isActive(recency) },
            });
            if (centerOnUser && (importance > 0.6 || isActive(recency))) {
                edges.push({
                    source: "you",
                    target: `emo:${r.id}`,
                    kind: "kg",
                    label: "felt",
                    strength: 0.15 + importance * 0.2,
                    weight: importance,
                });
            }
        }
    } catch {
        /* emotional_memory missing */
    }

    // ── Advanced kinds (goals, task_learnings, world_model, self_state) ──
    if (includeAdvanced) {
        try {
            type GoalRow = {
                id: number;
                description: string;
                deadline: string | null;
                progress: number | null;
                status: string;
                created_at: string;
            };
            const goalRows = db
                .prepare(
                    `SELECT id, description, deadline, progress, status, created_at
                     FROM goals
                     WHERE status != 'archived'
                     ORDER BY created_at DESC
                     LIMIT 20`,
                )
                .all() as GoalRow[];
            for (const r of goalRows) {
                const importance = 0.5;
                const recency = recencyScore(r.created_at);
                nodes.push({
                    id: `goal:${r.id}`,
                    kind: "goal",
                    label: truncate(r.description, 50),
                    fullText: r.description,
                    importance,
                    recency,
                    size: nodeSize(importance, recency),
                    color: COLOR_BY_KIND.goal,
                    pinned: false,
                    tags: [r.status],
                    createdAt: r.created_at,
                    meta: { progress: r.progress, deadline: r.deadline, status: r.status },
                });
            }
        } catch {
            /* goals table missing */
        }
    }

    // ── KG edges (entity-entity) ──
    if (entIds.size > 0) {
        const idList = Array.from(entIds);
        const placeholders = idList.map(() => "?").join(",");
        try {
            type RelRow = {
                from_id: number;
                to_id: number;
                type: string;
                strength: number | null;
            };
            const relRows = db
                .prepare(
                    `SELECT from_id, to_id, type, COALESCE(strength, 1.0) AS strength
                     FROM relationships
                     WHERE invalid_at IS NULL
                       AND from_id IN (${placeholders})
                       AND to_id IN (${placeholders})`,
                )
                .all(...idList, ...idList) as RelRow[];
            for (const r of relRows) {
                edges.push({
                    source: `ent:${r.from_id}`,
                    target: `ent:${r.to_id}`,
                    kind: "kg",
                    label: r.type,
                    strength: clamp01((r.strength ?? 1) / 2),
                    weight: r.strength ?? 1,
                });
            }
        } catch {
            /* relationships missing */
        }
    }

    // ── Mention edges (memory→entity, fuzzy via tags) ──
    if (memIds.size > 0 && entIds.size > 0) {
        try {
            const entNames = db
                .prepare(`SELECT id, name FROM entities WHERE id IN (${Array.from(entIds).map(() => "?").join(",")})`)
                .all(...Array.from(entIds)) as { id: number; name: string }[];
            const memTags = db
                .prepare(
                    `SELECT id, tags FROM memories WHERE id IN (${Array.from(memIds).map(() => "?").join(",")}) AND tags IS NOT NULL AND tags != ''`,
                )
                .all(...Array.from(memIds)) as { id: number; tags: string }[];
            for (const m of memTags) {
                const tagList = parseTags(m.tags).map((t) => t.toLowerCase());
                if (tagList.length === 0) continue;
                for (const e of entNames) {
                    if (tagList.includes(e.name.toLowerCase())) {
                        edges.push({
                            source: `mem:${m.id}`,
                            target: `ent:${e.id}`,
                            kind: "mention",
                            strength: 0.3,
                            weight: 1,
                        });
                    }
                }
            }
        } catch {
            /* missed mentions are non-fatal */
        }
    }

    // ── Provenance edges (episode → session-summary memory, heuristic) ──
    // Phase 1: timestamp proximity. Phase 4 will add explicit memories.source_episode.
    // Skipped here to keep Phase 1 quick; renderer treats absent provenance as "not yet derivable."

    // ── Neural mesh layer ──
    // Lateral peer-to-peer edges so the graph reads as an interconnected
    // web, not a hub-and-spoke. Same-kind, shared-category, and shared-tag
    // pairings each contribute to overlap weight.
    const peerableKinds = new Set(["memory", "entity", "episode", "trait", "emotion"]);
    const peerable = nodes.filter(
        (n) => peerableKinds.has(n.kind) && !(n.meta && (n.meta as { isCategoryAnchor?: boolean }).isCategoryAnchor),
    );
    const tagsOfNode = (n: StudioNode): Set<string> => {
        const set = new Set<string>();
        for (const t of n.tags || []) set.add(String(t).toLowerCase());
        if (n.category) set.add(String(n.category).toLowerCase());
        const meta = n.meta as Record<string, unknown> | undefined;
        if (meta && typeof meta.entityType === "string") set.add(meta.entityType.toLowerCase());
        if (meta && typeof meta.episodeType === "string") set.add(meta.episodeType.toLowerCase());
        return set;
    };
    const peerTagSets = new Map<string, Set<string>>();
    for (const n of peerable) peerTagSets.set(n.id, tagsOfNode(n));

    const meshKey = new Set<string>();
    for (const e of edges) {
        const s = typeof e.source === "string" ? e.source : (e.source as { id: string }).id;
        const t = typeof e.target === "string" ? e.target : (e.target as { id: string }).id;
        meshKey.add(s < t ? `${s}|${t}` : `${t}|${s}`);
    }

    for (const a of peerable) {
        const aTags = peerTagSets.get(a.id);
        const cands: { b: StudioNode; overlap: number }[] = [];
        for (const b of peerable) {
            if (b.id === a.id) continue;
            const bTags = peerTagSets.get(b.id);
            let overlap = 0;
            if (a.kind === b.kind) overlap += 1;
            if (a.category && b.category && a.category === b.category) overlap += 2;
            if (aTags && bTags) for (const t of aTags) if (bTags.has(t)) overlap += 2;
            if (overlap > 0) cands.push({ b, overlap });
        }
        cands.sort((x, y) => y.overlap - x.overlap);
        for (const { b, overlap } of cands.slice(0, 4)) {
            const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
            if (meshKey.has(key)) continue;
            meshKey.add(key);
            const strength = Math.min(0.45, 0.18 + overlap * 0.06);
            edges.push({
                source: a.id,
                target: b.id,
                kind: "similarity",
                strength,
                weight: overlap,
            });
        }
    }

    // Cap edges at 5× node count.
    const edgeCap = nodes.length * 5;
    if (edges.length > edgeCap) {
        const kgEdges = edges.filter((e) => e.kind !== "similarity");
        const simEdges = edges
            .filter((e) => e.kind === "similarity")
            .sort((a, b) => b.weight - a.weight);
        const simBudget = Math.max(0, edgeCap - kgEdges.length);
        edges.length = 0;
        edges.push(...kgEdges, ...simEdges.slice(0, simBudget));
    }

    const truncated = nodes.length > maxNodes;
    if (truncated) {
        nodes.length = maxNodes;
    }

    return {
        nodes,
        edges,
        meta: {
            centerId: "you",
            nodeCount: nodes.length,
            edgeCount: edges.length,
            truncated,
            generatedAt: new Date().toISOString(),
        },
    };
}

function safeJsonArray(raw: string): string[] {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

export interface StudioYouPayload {
    name: string | null;
    relationship: {
        trustScore: number;
        depthScore: number;
        engagementStreak: number;
        lastInteraction: string | null;
    } | null;
    topTraits: { key: string; value: string; confidence: number }[];
}

export function getStudioYou(): StudioYouPayload {
    const db = getRawDb();
    if (!db) {
        return { name: null, relationship: null, topTraits: [] };
    }

    let name: string | null = null;
    try {
        const row = db.prepare(`SELECT data FROM user_profiles LIMIT 1`).get() as { data?: string } | undefined;
        if (row?.data) {
            const parsed = JSON.parse(row.data) as { name?: string };
            if (parsed && typeof parsed.name === "string") name = parsed.name;
        }
    } catch {
        /* user_profiles may not exist yet */
    }

    let relationship: StudioYouPayload["relationship"] = null;
    try {
        const r = db
            .prepare(
                `SELECT trust_score, depth_score, engagement_streak, last_interaction FROM relationship_state LIMIT 1`,
            )
            .get() as
            | { trust_score: number; depth_score: number; engagement_streak: number; last_interaction: string | null }
            | undefined;
        if (r) {
            relationship = {
                trustScore: r.trust_score,
                depthScore: r.depth_score,
                engagementStreak: r.engagement_streak,
                lastInteraction: r.last_interaction,
            };
        }
    } catch {
        /* relationship_state may not exist */
    }

    let topTraits: StudioYouPayload["topTraits"] = [];
    try {
        topTraits = db
            .prepare(
                `SELECT trait_key AS key, value, confidence FROM behavioral_traits WHERE confidence > 0.5 ORDER BY confidence DESC LIMIT 8`,
            )
            .all() as { key: string; value: string; confidence: number }[];
    } catch {
        /* traits may not exist */
    }

    return { name, relationship, topTraits };
}

export interface StudioStats {
    memories: number;
    entities: number;
    episodes: number;
    traits: number;
    emotions: number;
    categories: Record<string, number>;
}

export function getStudioStats(): StudioStats {
    const db = getRawDb();
    const empty: StudioStats = { memories: 0, entities: 0, episodes: 0, traits: 0, emotions: 0, categories: {} };
    if (!db) return empty;

    const stats = { ...empty };
    const safeCount = (sql: string): number => {
        try {
            const row = db.prepare(sql).get() as { c: number } | undefined;
            return row?.c ?? 0;
        } catch {
            return 0;
        }
    };

    stats.memories = safeCount("SELECT COUNT(*) AS c FROM memories WHERE consolidated_into IS NULL");
    stats.entities = safeCount("SELECT COUNT(*) AS c FROM entities");
    stats.episodes = safeCount("SELECT COUNT(*) AS c FROM episodic_memory");
    stats.traits = safeCount("SELECT COUNT(*) AS c FROM behavioral_traits WHERE confidence > 0.3");
    stats.emotions = safeCount("SELECT COUNT(*) AS c FROM emotional_memory WHERE timestamp > datetime('now','-30 days')");

    try {
        const rows = db
            .prepare(
                `SELECT category, COUNT(*) AS c FROM memories WHERE consolidated_into IS NULL GROUP BY category`,
            )
            .all() as { category: string; c: number }[];
        for (const r of rows) {
            stats.categories[r.category || "general"] = r.c;
        }
    } catch {
        /* */
    }

    return stats;
}
