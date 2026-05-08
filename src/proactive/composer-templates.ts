// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { Channel, ProactiveIntent } from "./intent.js";

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
    meeting_prep: {
        telegram: (i) => {
            const { startMs, title, hasAttendees } = i.payload as {
                startMs?: number;
                title?: string;
                hasAttendees?: boolean;
            };
            if (startMs == null || !title) return null;
            const t = new Date(startMs);
            const time = `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`;
            const suffix = hasAttendees ? " want me to pull context?" : "";
            return `${time} — ${title}${hasAttendees ? " with others" : ""}.${suffix}`;
        },
        whatsapp: (i) => {
            const { startMs, title, hasAttendees } = i.payload as {
                startMs?: number;
                title?: string;
                hasAttendees?: boolean;
            };
            if (startMs == null || !title) return null;
            const t = new Date(startMs);
            const time = `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`;
            const suffix = hasAttendees ? " want me to pull context?" : "";
            return `${time} — ${title}${hasAttendees ? " with others" : ""}.${suffix}`;
        },
    },
    meeting_debrief: {
        telegram: (i) => {
            const { title } = i.payload as { title?: string };
            if (!title) return null;
            return `how'd ${title} go? want me to jot notes?`;
        },
        whatsapp: (i) => {
            const { title } = i.payload as { title?: string };
            if (!title) return null;
            return `how'd ${title} go? want me to jot notes?`;
        },
    },
    deadline_imminent: {
        telegram: (i) => {
            const { dueMs, title } = i.payload as { dueMs?: number; title?: string };
            if (dueMs == null || !title) return null;
            const msLeft = dueMs - Date.now();
            const mins = Math.max(0, Math.round(msLeft / 60_000));
            const left = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
            return `${left} left on '${title}'. still doing it today?`;
        },
        whatsapp: (i) => {
            const { dueMs, title } = i.payload as { dueMs?: number; title?: string };
            if (dueMs == null || !title) return null;
            const msLeft = dueMs - Date.now();
            const mins = Math.max(0, Math.round(msLeft / 60_000));
            const left = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
            return `${left} left on '${title}'. still doing it today?`;
        },
    },
    habit_anomaly: {
        telegram: (i) => {
            const { activity, expectedHour } = i.payload as { activity?: string; expectedHour?: number };
            if (!activity || expectedHour == null) return null;
            const timeStr = expectedHour < 12 ? `${expectedHour}am` : `${expectedHour - 12 || 12}pm`;
            return `you usually ${activity} around ${timeStr}. nothing scheduled — blocked?`;
        },
        whatsapp: (i) => {
            const { activity, expectedHour } = i.payload as { activity?: string; expectedHour?: number };
            if (!activity || expectedHour == null) return null;
            const timeStr = expectedHour < 12 ? `${expectedHour}am` : `${expectedHour - 12 || 12}pm`;
            return `you usually ${activity} around ${timeStr}. nothing scheduled — blocked?`;
        },
    },
    focus_block_offer: {
        telegram: (i) => {
            const { durationMin, prevEventTitle, nextEventTitle } = i.payload as {
                durationMin?: number;
                prevEventTitle?: string;
                nextEventTitle?: string;
            };
            if (durationMin == null || !prevEventTitle || !nextEventTitle) return null;
            const durStr = durationMin >= 60 ? `${Math.round(durationMin / 60)}h` : `${durationMin}m`;
            return `got a ${durStr} gap between ${prevEventTitle} and ${nextEventTitle}. block for focus work?`;
        },
        whatsapp: (i) => {
            const { durationMin, prevEventTitle, nextEventTitle } = i.payload as {
                durationMin?: number;
                prevEventTitle?: string;
                nextEventTitle?: string;
            };
            if (durationMin == null || !prevEventTitle || !nextEventTitle) return null;
            const durStr = durationMin >= 60 ? `${Math.round(durationMin / 60)}h` : `${durationMin}m`;
            return `got a ${durStr} gap between ${prevEventTitle} and ${nextEventTitle}. block for focus work?`;
        },
    },
    stale_email_draft: {
        telegram: (i) => {
            const { subject, from, daysStale } = i.payload as { subject?: string; from?: string; daysStale?: number };
            if (!subject || !from || daysStale == null) return null;
            return `'${subject}' from ${from}, ${daysStale}d old. draft a reply?`;
        },
        whatsapp: (i) => {
            const { subject, from, daysStale } = i.payload as { subject?: string; from?: string; daysStale?: number };
            if (!subject || !from || daysStale == null) return null;
            return `'${subject}' from ${from}, ${daysStale}d old. draft a reply?`;
        },
    },
    calendar_today_summary: {
        telegram: (i) => {
            const { events, conflicts } = i.payload as {
                events?: Array<{ start_ms: number }>;
                conflicts?: Array<unknown>;
            };
            if (!events) return null;
            const confs = conflicts ?? [];
            const confSuffix = confs.length > 0 ? ` — ${confs.length} overlap` : "";
            const firstTime = events[0]
                ? (() => {
                      const t = new Date(events[0].start_ms);
                      return `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`;
                  })()
                : "";
            return `${events.length} on calendar today${confSuffix}${firstTime ? `. first at ${firstTime}` : ""}.`;
        },
        whatsapp: (i) => {
            const { events, conflicts } = i.payload as {
                events?: Array<{ start_ms: number }>;
                conflicts?: Array<unknown>;
            };
            if (!events) return null;
            const confs = conflicts ?? [];
            const confSuffix = confs.length > 0 ? ` — ${confs.length} overlap` : "";
            const firstTime = events[0]
                ? (() => {
                      const t = new Date(events[0].start_ms);
                      return `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`;
                  })()
                : "";
            return `${events.length} on calendar today${confSuffix}${firstTime ? `. first at ${firstTime}` : ""}.`;
        },
    },
    tasks_today: {
        telegram: (i) => {
            const { urgent, normal, overdue } = i.payload as {
                urgent?: Array<unknown>;
                normal?: Array<unknown>;
                overdue?: Array<unknown>;
            };
            const u = urgent ?? [];
            const n = normal ?? [];
            const o = overdue ?? [];
            const overdueSuffix = o.length > 0 ? `, ${o.length} overdue` : "";
            return `${u.length} urgent, ${n.length} normal due today${overdueSuffix}.`;
        },
        whatsapp: (i) => {
            const { urgent, normal, overdue } = i.payload as {
                urgent?: Array<unknown>;
                normal?: Array<unknown>;
                overdue?: Array<unknown>;
            };
            const u = urgent ?? [];
            const n = normal ?? [];
            const o = overdue ?? [];
            const overdueSuffix = o.length > 0 ? `, ${o.length} overdue` : "";
            return `${u.length} urgent, ${n.length} normal due today${overdueSuffix}.`;
        },
    },
    goals_status: {
        telegram: (i) => {
            const { goals } = i.payload as { goals?: Array<{ title: string; progress: number }> };
            if (!goals || goals.length === 0) return null;
            const g = goals[0];
            return `'${g.title}' at ${g.progress}%. on track?`;
        },
        whatsapp: (i) => {
            const { goals } = i.payload as { goals?: Array<{ title: string; progress: number }> };
            if (!goals || goals.length === 0) return null;
            const g = goals[0];
            return `'${g.title}' at ${g.progress}%. on track?`;
        },
    },
    weather_today: {
        telegram: (i) => {
            const { summary, temp_c, rain_prob } = i.payload as {
                summary?: string;
                temp_c?: number;
                rain_prob?: number;
            };
            if (!summary || temp_c == null) return null;
            const rain = rain_prob ?? 0;
            const tempNum = Math.round(temp_c);
            let headsUp = "";
            if (rain > 0.3) headsUp = " — bring an umbrella";
            else if (temp_c < 10) headsUp = " — dress warm";
            else if (temp_c > 38) headsUp = " — stay hydrated";
            return `${summary} today, ${tempNum}°${headsUp}`;
        },
        whatsapp: (i) => {
            const { summary, temp_c, rain_prob } = i.payload as {
                summary?: string;
                temp_c?: number;
                rain_prob?: number;
            };
            if (!summary || temp_c == null) return null;
            const rain = rain_prob ?? 0;
            const tempNum = Math.round(temp_c);
            let headsUp = "";
            if (rain > 0.3) headsUp = " — bring an umbrella";
            else if (temp_c < 10) headsUp = " — dress warm";
            else if (temp_c > 38) headsUp = " — stay hydrated";
            return `${summary} today, ${tempNum}°${headsUp}`;
        },
    },
    news_today: {
        telegram: (i) => {
            const { headlines } = i.payload as { headlines?: Array<{ title: string }> };
            if (!headlines || headlines.length === 0) return null;
            const parts = headlines.slice(0, 2).map((h) => h.title);
            return `news you'd care about: ${parts.join(". ")}.`;
        },
        whatsapp: (i) => {
            const { headlines } = i.payload as { headlines?: Array<{ title: string }> };
            if (!headlines || headlines.length === 0) return null;
            const parts = headlines.slice(0, 2).map((h) => h.title);
            return `news you'd care about: ${parts.join(". ")}.`;
        },
    },
};

export function tryTemplate(intent: ProactiveIntent, channel: Channel): string | null {
    const fn = TEMPLATES[intent.payload.kind]?.[channel];
    return fn ? fn(intent) : null;
}
