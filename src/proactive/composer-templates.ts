// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ProactiveIntent, Channel } from "./intent.js";

type TemplateFn = (i: ProactiveIntent) => string | null;

// Templates return null when required payload fields are missing.
// This falls through to the LLM path; for deterministic intents that
// missed required fields, the caller sees "null" and suppresses the send.
export const TEMPLATES: Record<string, Partial<Record<Channel, TemplateFn>>> = {
    long_task_status: {
        whatsapp: (i) => {
            const { task, summary } = i.payload as { task?: string; summary?: string };
            if (!task || !summary) return null;
            return `Done with ${task}. ${summary}`;
        },
        telegram: (i) => {
            const { task, summary } = i.payload as { task?: string; summary?: string };
            if (!task || !summary) return null;
            return `Done with ${task}. ${summary}`;
        },
    },
    convex_notification: {
        whatsapp: (i) => {
            const { warning } = i.payload as { warning?: string };
            if (!warning) return null;
            return `Heads up — ${warning}`;
        },
        telegram: (i) => {
            const { warning } = i.payload as { warning?: string };
            if (!warning) return null;
            return `Heads up — ${warning}`;
        },
    },
    stale_todo_simple: {
        whatsapp: (i) => {
            const { days, deadline, todo } = i.payload as { days?: number; deadline?: string; todo?: string };
            if (days == null || !deadline || !todo) return null;
            return `${days}d to ${deadline}. ${todo}`;
        },
    },
    calendar_fusion: {
        whatsapp: (i) => {
            const { event, newTime, impacted } = i.payload as { event?: string; newTime?: string; impacted?: string };
            if (!event || !newTime || !impacted) return null;
            return `${event} moved to ${newTime} — your ${impacted} now overlaps`;
        },
    },
};

export function tryTemplate(intent: ProactiveIntent, channel: Channel): string | null {
    const fn = TEMPLATES[intent.payload.kind]?.[channel];
    return fn ? fn(intent) : null;
}
