// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { listCalendarEventsRaw } from "../../../tools/google-api.js";
import type { CalendarEvent as RustCalendarEvent } from "../../../../native/index.js";

const TTL_MS = 5 * 60_000;

let cache: { events: RustCalendarEvent[]; expires: number } | null = null;

function todayBoundsLocal(): { timeMin: string; timeMax: string } {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

function toRustEvent(item: {
    id: string;
    summary: string;
    start: { dateTime?: string; date?: string };
    end: { dateTime?: string; date?: string };
    location?: string;
    attendees?: Array<{ email?: string }>;
}): RustCalendarEvent {
    const isAllDay = Boolean(item.start?.date && !item.start?.dateTime);
    const startStr = item.start?.dateTime ?? item.start?.date ?? new Date().toISOString();
    const endStr = item.end?.dateTime ?? item.end?.date ?? new Date().toISOString();
    const attendees = item.attendees ?? [];
    return {
        id: item.id ?? "",
        title: item.summary ?? "Untitled",
        startMs: Date.parse(startStr),
        endMs: Date.parse(endStr),
        location: item.location,
        hasAttendees: attendees.length > 1,
        isAllDay,
    };
}

export async function fetchCalendarToday(): Promise<RustCalendarEvent[]> {
    if (cache && cache.expires > Date.now()) return cache.events;
    const { timeMin, timeMax } = todayBoundsLocal();
    const raw = await listCalendarEventsRaw({ timeMin, timeMax, maxResults: 25 });
    const events: RustCalendarEvent[] = raw.map(toRustEvent);
    cache = { events, expires: Date.now() + TTL_MS };
    return events;
}

export function _resetCalendarCache(): void {
    cache = null;
}
