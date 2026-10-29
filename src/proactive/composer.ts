// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { fetchSystemPrompt } from "../config/system-prompts.js";
import { getToneReminder } from "../setup/personality-sync.js";
import type { LLMClient } from "../llm.js";
import { extractJSON } from "../utils/json-extract.js";
import { tryTemplate } from "./composer-templates.js";
import type { Channel, ProactiveIntent, ProactiveMode } from "./intent.js";
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
    "might be useful",
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
        // The digest quotes stored memories word for word ("User prefers…"): showing exactly what is kept is the point.
        if (intent.payload.kind !== "memory_digest" && (containsBannedPhrase(tpl) || mentionsThirdPerson(tpl))) {
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
            modelOverride: "openai/gpt-4.1-nano",
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

export async function composeMorningBatch(
    intents: ProactiveIntent[],
    _channel: Channel,
    recentSends: string[],
    deps: { llm: LLMClient | null },
): Promise<{ text: string; modeTag: "fyi" | "question" | "review" } | null> {
    if (intents.length === 0 || !deps.llm) return null;

    const sections: string[] = [];
    for (const intent of intents) {
        const kind = intent.payloadKind ?? (intent.payload?.kind as string) ?? "";
        const p = intent.payload as Record<string, unknown>;
        switch (kind) {
            case "calendar_today_summary": {
                const events = (p.events as Array<{ title: string; start_ms: number }> | undefined) ?? [];
                const conflicts = (p.conflicts as Array<unknown> | undefined) ?? [];
                const parts = [`${events.length} events today`];
                if (conflicts.length > 0) parts.push(`${conflicts.length} overlap`);
                if (events[0]) {
                    const t = new Date(events[0].start_ms);
                    parts.push(`first at ${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`);
                }
                sections.push(`[calendar] ${parts.join(". ")}`);
                break;
            }
            case "tasks_today": {
                const urgent = (p.urgent as Array<{ title: string }> | undefined) ?? [];
                const normal = (p.normal as Array<{ title: string }> | undefined) ?? [];
                const overdue = (p.overdue as Array<{ title: string }> | undefined) ?? [];
                const parts: string[] = [];
                if (urgent.length > 0)
                    parts.push(
                        `${urgent.length} urgent (${urgent
                            .slice(0, 2)
                            .map((t) => `"${t.title}"`)
                            .join(", ")})`,
                    );
                if (normal.length > 0) parts.push(`${normal.length} normal`);
                if (overdue.length > 0) parts.push(`${overdue.length} overdue`);
                sections.push(`[tasks] ${parts.join(", ")}`);
                break;
            }
            case "goals_status": {
                const goals = (p.goals as Array<{ title: string; progress: number }> | undefined) ?? [];
                sections.push(`[goals] ${goals.map((g) => `"${g.title}" at ${g.progress}%`).join("; ")}`);
                break;
            }
            case "weather_today": {
                const summary = (p.summary as string) ?? "";
                const temp = (p.temp_c as number) ?? 0;
                const rain = (p.rain_prob as number) ?? 0;
                const parts = [`${summary}, ${temp}°C`];
                if (rain > 0.3) parts.push(`rain ${Math.round(rain * 100)}%`);
                sections.push(`[weather] ${parts.join(", ")}`);
                break;
            }
            case "news_today": {
                const headlines = (p.headlines as Array<{ title: string }> | undefined) ?? [];
                sections.push(
                    `[news] ${headlines
                        .slice(0, 2)
                        .map((h) => h.title)
                        .join(" | ")}`,
                );
                break;
            }
            case "habit_anomaly": {
                const activity = (p.activity as string) ?? "";
                const hour = (p.expectedHour as number) ?? 0;
                sections.push(`[habit] usually ${activity} ~${hour}am; empty today`);
                break;
            }
            default:
                sections.push(`[${kind}] ${intent.topic}`);
        }
    }

    const recentBlock =
        recentSends.length > 0
            ? `\n\nRecent messages to this channel (avoid repeating verbatim):\n${recentSends
                  .slice(0, 5)
                  .map((r) => `- ${r}`)
                  .join("\n")}`
            : "";

    // The user's Settings tone wins over the casual default (Professional got
    // "lowercase casual" briefings with emoji).
    const tone = getToneReminder();
    const style = tone ? `Short and specific. ${tone}` : "Short, warm, specific. Lowercase casual tone.";
    const prompt = `You're texting your close friend their morning briefing. Weave these signals into ONE natural message. ${style} No "here's your daily briefing" preamble. No bullet lists unless signals exceed 4 items. Second-person ("you"); never third-person ("the user").

Signals:
${sections.join("\n")}
${recentBlock}

Output ONLY the message text, nothing else.`;

    let content: string | undefined;
    try {
        const res = await deps.llm.chat({
            messages: [{ role: "user", content: prompt }],
            modelOverride: "openai/gpt-4.1-nano",
        });
        content = res?.choices?.[0]?.message?.content?.trim();
    } catch (e) {
        debugProactive("morning_batch_llm_failed", { err: (e as Error).message });
        return null;
    }
    if (!content) {
        debugProactive("morning_batch_empty_llm", {});
        return null;
    }

    if (containsBannedPhrase(content) || mentionsThirdPerson(content)) {
        debugProactive("morning_batch_post_filter_rejected", {});
        return null;
    }

    return { text: content, modeTag: "fyi" };
}
