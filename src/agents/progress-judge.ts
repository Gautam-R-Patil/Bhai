// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── P5.3: Adversarial Progress Judge (Metacog Tier B2) ──
// One small, adversarially-framed Haiku call that judges whether the agent is
// actually making progress toward its goal — the antidote to a self-fooling
// loop that the free heuristics can't see. DEFAULT OFF (opt-in via
// ATLAS_PROGRESS_JUDGE=true). When enabled it fires AT MOST ONCE per stuck
// turn; healthy turns never call it, so the default-config cost is ZERO.
//
// COST: exactly ONE anthropic/claude-haiku-4.5 call per stuck turn when the flag
// is on; zero otherwise. Haiku is the cheapest Claude tier and the output is a
// tiny JSON object. Fail-open: any error → null → the caller keeps the
// pre-existing heuristic intervention.
//
// chat() exposes NO temperature and NO direct max_tokens param (max_tokens is
// derived from thinkingLevel server-side; temperature is server-controlled). The
// achievable equivalent of "temp 0, tiny output" is thinkingLevel:"off" (the
// 4096 cap is a ceiling, not a target) + responseFormat:"json_object" + a prompt
// demanding a single minimal object. We do NOT invent a temperature param.

import { type ChatCompletionMessageParam, type LLMClient, MODELS } from "../llm.js";
import { extractJSON } from "../utils/json-extract.js";

export interface ProgressVerdict {
    progress_0_100: number;
    stalled: boolean;
    likely_fix: "retry" | "replan" | "escalate" | "ask_user";
    one_line: string;
}

const ALLOWED_FIXES: ReadonlySet<ProgressVerdict["likely_fix"]> = new Set(["retry", "replan", "escalate", "ask_user"]);

export function progressJudgeEnabled(): boolean {
    return process.env.ATLAS_PROGRESS_JUDGE === "true";
}

// Map the judge verdict onto the existing MetaAssessment.intervention enum that
// applyIntervention dispatches. "retry" has no paid arm → "none" (let the loop
// continue; the free nudge already fired). The judge never emits "critics".
export function judgeFixToIntervention(
    fix: ProgressVerdict["likely_fix"],
): "none" | "escalate" | "replan" | "critics" | "ask_user" {
    switch (fix) {
        case "replan":
            return "replan";
        case "escalate":
            return "escalate";
        case "ask_user":
            return "ask_user";
        default:
            return "none";
    }
}

// Build the last ≤maxPairs (action, observation) digests from the live message
// array. action = assistant text or tool-call names; observation = tool-result
// content head. Kept small so the judge's input stays cheap.
export function buildActionObservationDigests(messages: ChatCompletionMessageParam[], maxPairs = 6): string {
    const lines: string[] = [];
    for (let i = messages.length - 1; i >= 0 && lines.length < maxPairs; i--) {
        const m = messages[i];
        if (m.role === "tool") {
            const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
            lines.unshift(`OBS: ${content.slice(0, 200)}`);
        } else if (m.role === "assistant") {
            const calls = (m as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls;
            if (calls && calls.length > 0) {
                lines.unshift(`ACT: ${calls.map((c) => c.function?.name ?? "?").join(", ")}`);
            } else if (typeof m.content === "string" && m.content.trim()) {
                lines.unshift(`ACT: ${m.content.trim().slice(0, 200)}`);
            }
        }
    }
    return lines.slice(-maxPairs).join("\n");
}

const SYSTEM_PROMPT =
    "You are an adversarial progress auditor. Assume the agent may be fooling itself into thinking it is making progress. Judge ONLY whether real, verifiable progress is being made toward the goal. Output STRICT minimal JSON, no prose.";

export async function runProgressJudge(
    llm: LLMClient,
    goal: string,
    messages: ChatCompletionMessageParam[],
): Promise<ProgressVerdict | null> {
    try {
        const digest = buildActionObservationDigests(messages, 6);
        const user = `GOAL: ${goal}\n\nLAST 6 ACTIONS+OBSERVATIONS:\n${digest}\n\nReturn JSON: {"progress_0_100": <int 0-100>, "stalled": <bool>, "likely_fix": "retry"|"replan"|"escalate"|"ask_user", "one_line": "<≤15 words>"}`;
        const res = await llm.chat({
            messages: [{ role: "user", content: user }],
            systemPrompt: SYSTEM_PROMPT,
            modelOverride: MODELS.HAIKU,
            thinkingLevel: "off",
            responseFormat: "json_object",
        });
        const content = res.choices[0]?.message?.content;
        if (typeof content !== "string") return null;
        const json = extractJSON(content);
        if (!json) return null;
        const parsed = JSON.parse(json) as Record<string, unknown>;
        const fix = parsed.likely_fix;
        if (typeof fix !== "string" || !ALLOWED_FIXES.has(fix as ProgressVerdict["likely_fix"])) return null;
        const rawProgress = Number(parsed.progress_0_100);
        const progress = Number.isFinite(rawProgress) ? Math.max(0, Math.min(100, Math.round(rawProgress))) : 0;
        const oneLine = typeof parsed.one_line === "string" ? parsed.one_line.slice(0, 200) : "";
        return {
            progress_0_100: progress,
            stalled: parsed.stalled === true,
            likely_fix: fix as ProgressVerdict["likely_fix"],
            one_line: oneLine,
        };
    } catch {
        return null; // fail-open — never break a turn over the judge
    }
}
