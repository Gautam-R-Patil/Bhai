// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient } from "../../llm.js";
import { fetchSystemPrompt } from "../../config/system-prompts.js";
import { extractJSON } from "../../utils/json-extract.js";
import { debugProactive } from "../kill-switches.js";
import type { Channel } from "../intent.js";
import type { MonitorRuleInput } from "./monitor-store.js";

export type ParseResult =
    | { kind: "ok"; input: MonitorRuleInput }
    | { kind: "clarify"; question: string }
    | { kind: "error"; error: string };

const VALID_CHANNELS = new Set<string>([
    "whatsapp", "telegram", "discord", "slack", "matrix", "email", "overlay", "*",
]);
const VALID_URGENCIES = new Set(["urgent", "normal", "ambient"]);
const VALID_MODES = new Set(["fyi", "question", "review"]);

// Embed the topic before writing to storage. Accept either number[] or Float32Array
// so the caller can hand in either (embedText returns Float32Array; tests pass arrays).
export type EmbedFn = (text: string) => Promise<Float32Array | number[]>;

export async function parseMonitorRule(
    userPhrase: string,
    deps: { llm: LLMClient; embedText: EmbedFn },
): Promise<ParseResult> {
    if (!userPhrase?.trim()) {
        return { kind: "error", error: "empty user phrase" };
    }

    let systemPrompt: string;
    try {
        systemPrompt = await fetchSystemPrompt("monitor-rule-parser");
    } catch (e) {
        debugProactive("monitor_parser_prompt_fetch_failed", { err: (e as Error).message });
        return { kind: "error", error: `prompt fetch failed: ${(e as Error).message}` };
    }

    let content: string | undefined;
    try {
        const res = await deps.llm.chat({
            messages: [{ role: "user", content: userPhrase }],
            systemPrompt,
            modelOverride: "anthropic/claude-haiku-4.5",
            responseFormat: "json_object",
        });
        content = res?.choices?.[0]?.message?.content?.trim();
    } catch (e) {
        debugProactive("monitor_parser_llm_failed", { err: (e as Error).message });
        return { kind: "error", error: `llm error: ${(e as Error).message}` };
    }
    if (!content) {
        debugProactive("monitor_parser_empty_llm", {});
        return { kind: "error", error: "empty LLM response" };
    }

    const jsonStr = extractJSON(content);
    if (!jsonStr) {
        debugProactive("monitor_parser_no_json", { preview: content.slice(0, 120) });
        return { kind: "error", error: "could not extract JSON from LLM output" };
    }

    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(jsonStr);
    } catch (e) {
        return { kind: "error", error: `bad JSON: ${(e as Error).message}` };
    }

    // Clarification branch
    if (typeof parsed.needsClarification === "string" && parsed.needsClarification.trim()) {
        return { kind: "clarify", question: parsed.needsClarification };
    }

    // Validate + coerce
    const v = validateParsed(parsed);
    if (v.kind !== "ok") {
        debugProactive("monitor_parser_validation_failed", { error: v.error });
        return v;
    }
    const validated = v.parsed;

    // Embed the topic
    let embedding: number[];
    try {
        const raw = await deps.embedText(validated.topic);
        embedding = Array.isArray(raw) ? raw : Array.from(raw);
    } catch (e) {
        return { kind: "error", error: `embed failed: ${(e as Error).message}` };
    }
    if (embedding.length !== 384) {
        return { kind: "error", error: `embedding length ${embedding.length} != 384` };
    }

    const input: MonitorRuleInput = {
        userPhrase,
        topic: validated.topic,
        topicEmbedding: embedding,
        scope: validated.scope,
        urgency: validated.urgency,
        action: validated.action,
        threshold: validated.threshold,
        cooldownMinutes: validated.cooldownMinutes,
        expiresAt: validated.expiresAt,
    };
    return { kind: "ok", input };
}

// ── Internal validation ──────────────────────────

type ValidatedRule = Omit<MonitorRuleInput, "userPhrase" | "topicEmbedding">;

type ValidateResult =
    | { kind: "ok"; parsed: ValidatedRule }
    | { kind: "error"; error: string };

function validateParsed(p: Record<string, unknown>): ValidateResult {
    if (typeof p.topic !== "string" || !p.topic.trim()) {
        return { kind: "error", error: "missing or empty topic" };
    }
    const topic = p.topic;

    // Scope
    if (!p.scope || typeof p.scope !== "object") {
        return { kind: "error", error: "missing scope" };
    }
    const s = p.scope as Record<string, unknown>;
    const channels = Array.isArray(s.channels) && s.channels.length > 0 ? s.channels : ["*"];
    for (const ch of channels as unknown[]) {
        if (typeof ch !== "string" || !VALID_CHANNELS.has(ch)) {
            return { kind: "error", error: `invalid channel: ${String(ch)}` };
        }
    }
    const excludeSelf = typeof s.excludeSelf === "boolean" ? s.excludeSelf : true;
    const groups = Array.isArray(s.groups) ? (s.groups as unknown[]).filter((g): g is string => typeof g === "string") : undefined;
    const senders = Array.isArray(s.senders) ? (s.senders as unknown[]).filter((g): g is string => typeof g === "string") : undefined;

    // Urgency
    const urgency = typeof p.urgency === "string" && VALID_URGENCIES.has(p.urgency) ? p.urgency : "normal";

    // Action
    let action: ValidatedRule["action"] = { defaultMode: "question" };
    if (p.action && typeof p.action === "object") {
        const a = p.action as Record<string, unknown>;
        const defaultMode = typeof a.defaultMode === "string" && VALID_MODES.has(a.defaultMode) ? a.defaultMode : "question";
        const suggestedFollowup = typeof a.suggestedFollowup === "string" ? a.suggestedFollowup : undefined;
        action = { defaultMode: defaultMode as "fyi" | "question" | "review", suggestedFollowup };
    }

    // Threshold: clamp to [0.6, 0.95], default 0.82
    const rawThreshold = typeof p.threshold === "number" ? p.threshold : 0.82;
    const threshold = Math.min(0.95, Math.max(0.6, rawThreshold));

    // Cooldown: ≥5 minutes, default 60
    const rawCooldown = typeof p.cooldownMinutes === "number" ? p.cooldownMinutes : 60;
    const cooldownMinutes = Math.max(5, Math.floor(rawCooldown));

    const expiresAt = typeof p.expiresAt === "number" && p.expiresAt > 0 ? p.expiresAt : undefined;

    return {
        kind: "ok",
        parsed: {
            topic,
            scope: {
                channels: channels as Channel[] | ["*"],
                groups: groups && groups.length > 0 ? groups : undefined,
                senders: senders && senders.length > 0 ? senders : undefined,
                excludeSelf,
            },
            urgency: urgency as ValidatedRule["urgency"],
            action,
            threshold,
            cooldownMinutes,
            expiresAt,
        },
    };
}
