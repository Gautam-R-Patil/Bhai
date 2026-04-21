// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient } from "../llm.js";
import { fetchSystemPrompt } from "../config/system-prompts.js";
import { extractJSON } from "../utils/json-extract.js";
import type { ProactiveIntent, Channel, ProactiveMode } from "./intent.js";
import { tryTemplate } from "./composer-templates.js";
import { debugProactive } from "./kill-switches.js";

export type Persona = { tone: string };
export type ComposerResult = { text: string; modeTag: ProactiveMode };

const BANNED_PHRASES = [
    "might be worth",
    "probably useful",
    "worth a quick recap",
    "been away for",
    "could be helpful",
    "just checking in",
    "wanted to ask",
    "a quick thought",
    "might be good to",
    "worth checking",
];

export async function compose(
    intent: ProactiveIntent,
    channel: Channel,
    persona: Persona,
    recentSends: string[],
    deps: { llm: LLMClient | null },
): Promise<ComposerResult | null> {
    // 1. Template fast path
    const tpl = tryTemplate(intent, channel);
    if (tpl !== null) {
        if (containsBannedPhrase(tpl) || mentionsThirdPerson(tpl)) {
            debugProactive("composer_template_rejected", { id: intent.id, reason: "post_filter" });
            return null;
        }
        return { text: tpl, modeTag: intent.mode };
    }

    // 2. LLM fallback
    if (!deps.llm) {
        debugProactive("composer_skipped_no_llm", { id: intent.id, kind: intent.payload.kind });
        return null;
    }

    let systemPrompt: string;
    try {
        systemPrompt = await fetchSystemPrompt("proactive-composer");
    } catch (e) {
        debugProactive("composer_prompt_fetch_failed", { id: intent.id, err: (e as Error).message });
        return null;
    }

    const userPayload = {
        intent: {
            source: intent.source,
            mode: intent.mode,
            urgency: intent.urgency,
            topic: intent.topic,
            evidence: intent.evidence,
            payload: intent.payload,
        },
        channel,
        personaTone: persona.tone,
        recentSends,
        timeOfDay: hourBucket(),
    };

    let content: string | undefined;
    try {
        const res = await deps.llm.chat({
            messages: [{ role: "user", content: JSON.stringify(userPayload) }],
            systemPrompt,
            modelOverride: "anthropic/claude-haiku-4.5",
            responseFormat: "json_object",
        });
        content = res?.choices?.[0]?.message?.content?.trim();
    } catch (e) {
        debugProactive("composer_llm_failed", { id: intent.id, err: (e as Error).message });
        return null;
    }
    if (!content) {
        debugProactive("composer_empty_llm", { id: intent.id });
        return null;
    }

    const jsonStr = extractJSON(content);
    if (!jsonStr) {
        debugProactive("composer_no_json", { id: intent.id });
        return null;
    }

    let parsed: { text?: string; modeTag?: ProactiveMode; skip?: boolean };
    try {
        parsed = JSON.parse(jsonStr);
    } catch {
        debugProactive("composer_bad_json", { id: intent.id });
        return null;
    }

    if (parsed.skip === true || !parsed.text) {
        debugProactive("composer_skip", { id: intent.id, hasText: !!parsed.text, skip: parsed.skip });
        return null;
    }

    const text = parsed.text.trim();
    if (containsBannedPhrase(text) || mentionsThirdPerson(text)) {
        debugProactive("composer_post_filter_rejected", { id: intent.id });
        return null;
    }

    return { text, modeTag: parsed.modeTag ?? intent.mode };
}

function containsBannedPhrase(text: string): boolean {
    const lower = text.toLowerCase();
    return BANNED_PHRASES.some((p) => lower.includes(p));
}

function mentionsThirdPerson(text: string): boolean {
    const lower = text.toLowerCase();
    if (/\bthe user\b/.test(lower)) return true;
    if (/\buser (is|has|was|will|would|might|should|could|seems)\b/.test(lower)) return true;
    return false;
}

function hourBucket(): string {
    const h = new Date().getHours();
    if (h < 5) return "late_night";
    if (h < 12) return "morning";
    if (h < 17) return "afternoon";
    if (h < 22) return "evening";
    return "late_night";
}
