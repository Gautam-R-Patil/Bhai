// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Counterfactual Memory — Store "what would have happened" for regret-based learning.

import type { Database } from "./sqlite.js";
import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import { extractJSON } from "../utils/json-extract.js";

export interface Counterfactual {
    episodeId: string;
    choiceMade: string;
    alternativeChoice: string;
    predictedOutcome: string;
    actualOutcome: string;
    regret: number;           // 0-1, how much better the alternative would have been
    createdAt: string;
}

let db: Database | null = null;

export function initCounterfactualMemory(database: Database): void {
    db = database;
    db.run(`
        CREATE TABLE IF NOT EXISTS counterfactuals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            episode_id TEXT, choice_made TEXT, alternative_choice TEXT,
            predicted_outcome TEXT, actual_outcome TEXT, regret REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);
}

export function storeCounterfactual(cf: Omit<Counterfactual, "createdAt">): void {
    if (!db) return;
    db.run(
        `INSERT INTO counterfactuals (episode_id, choice_made, alternative_choice, predicted_outcome, actual_outcome, regret)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [cf.episodeId, cf.choiceMade, cf.alternativeChoice, cf.predictedOutcome, cf.actualOutcome, cf.regret]
    );
}

export function getHighRegretCounterfactuals(minRegret = 0.5, limit = 10): Counterfactual[] {
    if (!db) return [];
    const results = db.exec(
        `SELECT episode_id, choice_made, alternative_choice, predicted_outcome, actual_outcome, regret, created_at
         FROM counterfactuals WHERE regret >= ? ORDER BY regret DESC LIMIT ?`,
        [minRegret, limit]
    );
    if (!results[0]?.values) return [];
    return results[0].values.map(r => ({
        episodeId: r[0] as string, choiceMade: r[1] as string, alternativeChoice: r[2] as string,
        predictedOutcome: r[3] as string, actualOutcome: r[4] as string, regret: r[5] as number,
        createdAt: r[6] as string,
    }));
}

// ── LLM-Powered Counterfactual Generation ────

/**
 * Uses the LLM to generate a counterfactual reflection for an episode:
 * "What alternative approach could have worked better?"
 * Parses the response for alternative action, predicted outcome, and regret score,
 * then persists via storeCounterfactual().
 */
export async function generateCounterfactual(
    llm: LLMClient,
    episodeDescription: string,
    choiceMade: string,
    actualOutcome: string,
): Promise<void> {
    if (!db) return;

    try {
        const prompt = `You are analyzing a past decision to learn from it.

Episode: ${episodeDescription}
Choice made: ${choiceMade}
Actual outcome: ${actualOutcome}

Generate a counterfactual analysis. What alternative approach could have been tried instead? How likely is it that the alternative would have produced a better outcome?

Respond with ONLY valid JSON:
{
  "alternativeChoice": "description of what could have been done differently",
  "predictedOutcome": "what would likely have happened with the alternative",
  "regret": 0.0 to 1.0 (0 = no regret, current choice was fine; 1 = strong regret, alternative was clearly better)
}`;

        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt: "You are a reflective analyst. Output valid JSON only. Be honest about regret — only assign high regret when the alternative is clearly superior.",
        });

        const text = response.choices?.[0]?.message?.content || "";
        const jsonStr = extractJSON(text);
        if (!jsonStr) return;

        const parsed = JSON.parse(jsonStr) as {
            alternativeChoice?: string;
            predictedOutcome?: string;
            regret?: number;
        };

        if (!parsed.alternativeChoice || !parsed.predictedOutcome || typeof parsed.regret !== "number") return;

        const episodeId = `cf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

        storeCounterfactual({
            episodeId,
            choiceMade,
            alternativeChoice: parsed.alternativeChoice,
            predictedOutcome: parsed.predictedOutcome,
            actualOutcome,
            regret: Math.max(0, Math.min(1, parsed.regret)),
        });

        console.log(`[COUNTERFACTUAL] Stored reflection (regret: ${parsed.regret.toFixed(2)}) for: ${episodeDescription.substring(0, 60)}...`);
    } catch (err) {
        console.warn("[COUNTERFACTUAL] Generation failed (non-fatal):", (err as Error).message);
    }
}

// ── Context Retrieval for Active Tasks ──────

/**
 * Retrieves relevant counterfactuals for a given task context,
 * formatted as a prompt snippet that can be injected into agent context.
 */
export function getCounterfactualContext(query: string, limit = 3): string {
    if (!db) return "";

    try {
        // Search counterfactuals by keyword overlap with the query
        const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
        if (keywords.length === 0) return "";

        // Build a LIKE-based search across choice_made and alternative_choice
        const conditions = keywords.map(() =>
            `(LOWER(choice_made) LIKE ? OR LOWER(alternative_choice) LIKE ? OR LOWER(actual_outcome) LIKE ?)`
        ).join(" OR ");
        const params = keywords.flatMap(k => [`%${k}%`, `%${k}%`, `%${k}%`]);

        const results = db.exec(
            `SELECT choice_made, alternative_choice, predicted_outcome, actual_outcome, regret
             FROM counterfactuals
             WHERE ${conditions}
             ORDER BY regret DESC
             LIMIT ?`,
            [...params, limit]
        );

        if (!results[0]?.values || results[0].values.length === 0) return "";

        const lessons = results[0].values.map((r, i) => {
            const choiceMade = r[0] as string;
            const alternative = r[1] as string;
            const predicted = r[2] as string;
            const actual = r[3] as string;
            const regret = r[4] as number;
            return `${i + 1}. Previously chose: "${choiceMade.substring(0, 100)}" → Outcome: "${actual.substring(0, 100)}" (regret: ${regret.toFixed(1)}). Better alternative: "${alternative.substring(0, 100)}" → Expected: "${predicted.substring(0, 100)}"`;
        });

        return `[COUNTERFACTUAL LESSONS]:\n${lessons.join("\n")}`;
    } catch {
        return "";
    }
}
