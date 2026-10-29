// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── User Model ───────────────────────────────────
 * Centralized user profile aggregating signals from multiple memory subsystems.
 * Provides a single getUserModel() function for proactive and agent systems.
 *
 * Builds on: identity.ts, traits.ts, emotional.ts, episodic.ts, relationship.ts.
 * Adds: routine detection, communication style tracking, need prediction.
 */

import type { Database } from "./sqlite.js";
import { embedText, cosineSimilarity, isReady as isEmbeddingsReady } from "./embeddings.js";
import { getTimezone } from "../location/index.js";

// ── Types ─────────────────────────────────────

export interface UserModel {
    // Static profile
    name: string;
    role: string;
    timezone: string;

    // Dynamic state
    currentProjects: Array<{ name: string; status: string; lastMentioned: string }>;
    activeInterests: Array<{ topic: string; intensity: number; trend: "rising" | "stable" | "declining" }>;

    // Routines
    dailyPatterns: Array<{ timeBucket: string; typicalActivity: string; confidence: number }>;

    // Communication style
    preferredMessageLength: "terse" | "normal" | "detailed";
    formalityLevel: number;
    emojiFrequency: number;
    responseTimeExpectation: "instant" | "quick" | "relaxed";

    // Predictions
    likelyNeeds: Array<{ need: string; confidence: number; basis: string }>;
}

// ── State ─────────────────────────────────────

let db: Database | null = null;

// ── Init ──────────────────────────────────────

export function initUserModel(database: Database): void {
    db = database;

    // Create user model cache table
    db.run(`
        CREATE TABLE IF NOT EXISTS user_model_cache (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `);

    console.log("[USER-MODEL] Initialized");
}

// ── Get Model ─────────────────────────────────

/**
 * Build a comprehensive user model from all available memory signals.
 */
export async function getUserModel(): Promise<UserModel> {
    const model: UserModel = {
        name: "",
        role: "",
        timezone: getTimezone(),
        currentProjects: [],
        activeInterests: [],
        dailyPatterns: [],
        preferredMessageLength: "normal",
        formalityLevel: 0.5,
        emojiFrequency: 0,
        responseTimeExpectation: "quick",
        likelyNeeds: [],
    };

    // ── Identity ──
    try {
        const { getIdentityProfile, getFieldValue } = await import("./identity.js");
        const identity = getIdentityProfile();
        if (identity) {
            // Fields may be { value, verified } (wizard, OS location), not plain strings.
            model.name = getFieldValue((identity as any).name) || "";
            model.role = getFieldValue((identity as any).role) || "";
            model.timezone = (identity as any).location?.timezone || getTimezone();
        }
    } catch { /* */ }

    // ── Current projects from knowledge graph ──
    try {
        const { findEntities } = await import("./knowledge-graph.js");
        const { getRawDb } = await import("./sqlite.js");
        const memDb = getRawDb();
        if (memDb) {
            const projects = findEntities(memDb as any, "project", "project");
            if (projects && projects.length > 0) {
                model.currentProjects = projects.slice(0, 5).map((p: any) => ({
                    name: p.name,
                    status: p.context || "unknown",
                    lastMentioned: p.updatedAt || "",
                }));
            }
        }
    } catch { /* */ }

    // ── Active interests from traits ──
    try {
        const { getHighConfidenceTraits } = await import("./traits.js");
        const traits = getHighConfidenceTraits(0.5);
        if (traits && traits.length > 0) {
            model.activeInterests = traits
                .filter((t: any) => t.key?.includes("interest") || t.key?.includes("topic"))
                .slice(0, 10)
                .map((t: any) => ({
                    topic: t.value,
                    intensity: t.confidence || 0.5,
                    trend: "stable" as const,
                }));
        }
    } catch { /* */ }

    // ── Routines from native module ──
    try {
        const native = loadNative();
        if (native && db) {
            const events = getInteractionEvents();
            if (events.length > 5) {
                const routines = native.detectRoutines(events);
                model.dailyPatterns = routines.map((r: any) => ({
                    timeBucket: r.time_bucket,
                    typicalActivity: r.typical_topics?.join(", ") || "general",
                    confidence: r.confidence,
                }));
            }
        }
    } catch { /* */ }

    // ── Communication style ──
    try {
        const native = loadNative();
        if (native) {
            const events = getInteractionEvents();
            if (events.length > 5) {
                const style = native.analyzeCommunicationStyle(events);
                model.preferredMessageLength = style.preferred_length;
                model.formalityLevel = style.formality_score;
                model.emojiFrequency = style.emoji_frequency;
                model.responseTimeExpectation = style.response_time_expectation;
            }
        }
    } catch { /* */ }

    // ── Semantic topic enrichment (augment interests from recent messages) ──
    try {
        if (model.activeInterests.length < 3 && db) {
            const results = db.exec(
                `SELECT content FROM conversations
                 WHERE role = 'user' AND timestamp > datetime('now', '-7 days')
                 ORDER BY timestamp DESC LIMIT 20`,
                []
            );
            if (results[0]?.values) {
                const topicCounts = new Map<string, number>();
                const topics = await Promise.all(
                    results[0].values
                        .map(r => (r[0] as string) || "")
                        .filter(c => c.length > 10)
                        .slice(0, 10)
                        .map(c => extractTopicSemantic(c))
                );
                for (const topic of topics) {
                    if (topic !== "general") {
                        topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
                    }
                }
                const existingTopics = new Set(model.activeInterests.map(i => i.topic));
                for (const [topic, count] of topicCounts) {
                    if (!existingTopics.has(topic) && count >= 2) {
                        model.activeInterests.push({
                            topic,
                            intensity: Math.min(1, count / 5),
                            trend: "stable",
                        });
                    }
                }
            }
        }
    } catch { /* semantic enrichment non-fatal */ }

    return model;
}

/**
 * Get a compact string summary of the user model for prompt injection.
 * Budget: ~300 tokens.
 */
export async function getUserModelSnippet(): Promise<string> {
    const model = await getUserModel();
    const parts: string[] = [];

    if (model.name) parts.push(`Name: ${model.name}`);
    if (model.role) parts.push(`Role: ${model.role}`);

    if (model.currentProjects.length > 0) {
        parts.push(`Active projects: ${model.currentProjects.map(p => p.name).join(", ")}`);
    }

    if (model.activeInterests.length > 0) {
        const top = model.activeInterests.filter(i => i.intensity > 0.3).slice(0, 5);
        if (top.length > 0) {
            parts.push(`Active interests: ${top.map(i => i.topic).join(", ")}`);
        }
    }

    if (model.dailyPatterns.length > 0) {
        const top = model.dailyPatterns.filter(r => r.confidence > 0.5).slice(0, 3);
        if (top.length > 0) {
            parts.push(`Routines: ${top.map(r => `${r.timeBucket}: ${r.typicalActivity}`).join("; ")}`);
        }
    }

    if (model.preferredMessageLength !== "normal") {
        parts.push(`Communication: prefers ${model.preferredMessageLength} messages`);
    }

    if (model.likelyNeeds.length > 0) {
        parts.push(`Likely needs: ${model.likelyNeeds.slice(0, 2).map(n => n.need).join("; ")}`);
    }

    return parts.length > 0
        ? `USER MODEL:\n${parts.map(p => `- ${p}`).join("\n")}`
        : "";
}

// ── Interaction Event Collection ──────────────

function getInteractionEvents(): any[] {
    if (!db) return [];

    try {
        const results = db.exec(
            `SELECT
                c.timestamp as ts,
                c.role,
                LENGTH(c.content) as msg_len,
                c.content
             FROM conversations c
             WHERE c.role = 'user'
             AND c.timestamp > datetime('now', '-14 days')
             ORDER BY c.timestamp DESC
             LIMIT 200`,
            []
        );

        if (!results[0]?.values) return [];

        return results[0].values.map(row => {
            const ts = new Date(row[0] as string);
            const content = (row[3] as string) || "";
            return {
                timestamp_ms: ts.getTime(),
                hour_of_day: ts.getHours() + ts.getMinutes() / 60,
                day_of_week: ts.getDay(),
                topic: extractTopic(content),
                message_length: row[2] as number,
                had_emoji: /[\u{1F600}-\u{1F9FF}]/u.test(content),
                response_time_ms: -1, // Would need paired analysis
            };
        });
    } catch { return []; }
}

// ── Topic Classification (embedding-based with keyword fallback) ──

const TOPIC_DESCRIPTIONS: Record<string, string> = {
    coding: "programming, code, software development, debugging, fixing bugs, implementing features, refactoring",
    email: "email, inbox, mail, sending messages, replying to emails, drafts",
    calendar: "calendar, meetings, schedule, appointments, events, reminders",
    research: "research, searching, investigating, looking up information, analysis, deep dive",
    writing: "writing, drafting, composing, editing text, documents, articles, content creation",
    design: "design, UI, UX, layout, mockup, wireframe, styling, visual",
    devops: "deployment, CI/CD, Docker, server, infrastructure, monitoring, hosting",
    data: "data, database, SQL, analytics, charts, visualization, metrics, statistics",
    planning: "planning, roadmap, strategy, goals, tasks, project management, organizing",
    communication: "chat, messaging, Telegram, Slack, notifications, announcements",
    finance: "money, payment, invoice, budget, expense, billing, subscription",
    learning: "learning, tutorial, course, documentation, how to, explain, understand",
    general: "general conversation, casual chat, greeting, small talk",
};

let _topicEmbeddings: Map<string, Float32Array> | null = null;
let _topicEmbeddingsLoading = false;

async function ensureTopicEmbeddings(): Promise<Map<string, Float32Array> | null> {
    if (_topicEmbeddings) return _topicEmbeddings;
    if (_topicEmbeddingsLoading) return null;
    if (!isEmbeddingsReady()) return null;

    _topicEmbeddingsLoading = true;
    try {
        const map = new Map<string, Float32Array>();
        const entries = Object.entries(TOPIC_DESCRIPTIONS);
        const embeddings = await Promise.all(
            entries.map(([, desc]) => embedText(desc, "document"))
        );
        for (let i = 0; i < entries.length; i++) {
            map.set(entries[i][0], embeddings[i]);
        }
        _topicEmbeddings = map;
        return map;
    } catch {
        return null;
    } finally {
        _topicEmbeddingsLoading = false;
    }
}

function extractTopicKeyword(content: string): string {
    const lower = content.toLowerCase();
    if (lower.includes("code") || lower.includes("fix") || lower.includes("bug") || lower.includes("function") || lower.includes("error")) return "coding";
    if (lower.includes("email") || lower.includes("mail") || lower.includes("inbox")) return "email";
    if (lower.includes("meeting") || lower.includes("calendar") || lower.includes("schedule")) return "calendar";
    if (lower.includes("research") || lower.includes("search") || lower.includes("investigate")) return "research";
    if (lower.includes("write") || lower.includes("draft") || lower.includes("compose") || lower.includes("article")) return "writing";
    if (lower.includes("design") || lower.includes("layout") || lower.includes("ui") || lower.includes("ux")) return "design";
    if (lower.includes("deploy") || lower.includes("docker") || lower.includes("server") || lower.includes("ci/cd")) return "devops";
    if (lower.includes("data") || lower.includes("database") || lower.includes("sql") || lower.includes("chart")) return "data";
    if (lower.includes("plan") || lower.includes("roadmap") || lower.includes("task") || lower.includes("goal")) return "planning";
    if (lower.includes("money") || lower.includes("payment") || lower.includes("invoice") || lower.includes("budget")) return "finance";
    if (lower.includes("learn") || lower.includes("tutorial") || lower.includes("explain") || lower.includes("how to")) return "learning";
    return "general";
}

function extractTopic(content: string): string {
    // Synchronous path: use keyword fallback (called from getInteractionEvents which is sync)
    return extractTopicKeyword(content);
}

/**
 * Async topic classification using embedding similarity.
 * Falls back to keyword matching if embeddings aren't ready.
 */
async function extractTopicSemantic(content: string): Promise<string> {
    if (content.length < 5) return "general";

    try {
        const topicMap = await ensureTopicEmbeddings();
        if (!topicMap) return extractTopicKeyword(content);

        const queryEmb = await embedText(content.substring(0, 500), "query");
        let bestTopic = "general";
        let bestScore = -1;

        for (const [topic, topicEmb] of topicMap) {
            const score = cosineSimilarity(queryEmb, topicEmb);
            if (score > bestScore) {
                bestScore = score;
                bestTopic = topic;
            }
        }

        // Require minimum similarity to avoid false positives
        return bestScore > 0.3 ? bestTopic : "general";
    } catch {
        return extractTopicKeyword(content);
    }
}

// ── Native Module ─────────────────────────────

let _native: any = null;
let _nativeLoaded = false;

function loadNative(): any {
    if (_nativeLoaded) return _native;
    _nativeLoaded = true;
    try {
        const { createRequire } = require("node:module");
        const nativeRequire = createRequire(import.meta.url);
        const path = require("node:path");
        _native = nativeRequire(path.join(process.cwd(), "native", "index.js"));
        return _native;
    } catch { return null; }
}
