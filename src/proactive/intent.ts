// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { generateUUID } from "../utils/uuid.js";

export type IntentSource =
  | "latent_topic_monitor" | "memory_anticipation" | "calendar_fact_check"
  | "calendar_fusion" | "stale_todo" | "meeting_followup"
  | "habit_anomaly" | "env_context" | "long_task_status"
  | "convex_notification"
  | "calendar_morning" | "calendar_prep" | "tasks_morning"
  | "tasks_deadline" | "goals_morning" | "weather_morning"
  | "news_morning" | "stale_email" | "deep_work_gap"
  | "onboarding_graduation";   // W3: Day-2/3/5 wizard graduation nudges

export type Channel =
  | "whatsapp" | "telegram" | "discord" | "slack"
  | "matrix" | "email" | "overlay";

export type ProactiveMode = "fyi" | "question" | "review";
export type Urgency = "urgent" | "normal" | "ambient";

export type Evidence = {
  label: string;
  value: string;
  source?: string;
};

export type SuggestedToolCall = {
  toolName: string;
  args: Record<string, unknown>;
};

export type SuggestedAction = {
  toolCalls: SuggestedToolCall[];
  summary: string;
};

export type ProactiveIntent = {
  id: string;
  source: IntentSource;
  mode: ProactiveMode;
  urgency: Urgency;
  channelPreference: Channel | "any";
  topic: string;
  topicEmbedding: number[];
  evidence: Evidence[];
  payload: { kind: string; [k: string]: unknown };
  suggestedAction?: SuggestedAction;
  createdAt: number;
  expiresAt: number;
  scheduledFor?: number;
  payloadKind?: string;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

const VALID_SOURCES: IntentSource[] = [
  "latent_topic_monitor", "memory_anticipation", "calendar_fact_check",
  "calendar_fusion", "stale_todo", "meeting_followup",
  "habit_anomaly", "env_context", "long_task_status",
  "convex_notification",
  "calendar_morning", "calendar_prep", "tasks_morning",
  "tasks_deadline", "goals_morning", "weather_morning",
  "news_morning", "stale_email", "deep_work_gap",
  "onboarding_graduation",
];
const VALID_MODES: ProactiveMode[] = ["fyi", "question", "review"];
const VALID_URGENCIES: Urgency[] = ["urgent", "normal", "ambient"];

export function validateIntent(i: ProactiveIntent): ValidationResult {
  if (!i.id || typeof i.id !== "string") return { ok: false, error: "id missing" };
  if (!VALID_SOURCES.includes(i.source)) return { ok: false, error: `bad source: ${i.source}` };
  if (!VALID_MODES.includes(i.mode)) return { ok: false, error: `bad mode: ${i.mode}` };
  if (!VALID_URGENCIES.includes(i.urgency)) return { ok: false, error: `bad urgency: ${i.urgency}` };
  if (!Array.isArray(i.topicEmbedding) || i.topicEmbedding.length !== 384) {
    return { ok: false, error: "embedding must be length 384" };
  }
  if (!i.payload?.kind) return { ok: false, error: "payload.kind missing" };
  if (typeof i.createdAt !== "number") return { ok: false, error: "createdAt missing" };
  if (typeof i.expiresAt !== "number") return { ok: false, error: "expiresAt missing" };
  if (i.expiresAt <= i.createdAt) return { ok: false, error: "expiresAt <= createdAt" };
  if (i.mode === "review" && !i.suggestedAction) {
    return { ok: false, error: "review mode requires suggestedAction" };
  }
  return { ok: true };
}

export function makeIntentId(source: IntentSource): string {
  return `${source}_${Date.now()}_${generateUUID().slice(0, 8)}`;
}
