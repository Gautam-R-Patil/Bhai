// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── App Integration & Window Management Tools ─
// Structured wrappers around system scripting for common app interactions.
// macOS: AppleScript/JXA
// Windows: Tool hints to use powershell_script or browser-based alternatives

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getScreenDimensions, scaleImageToScreen } from "../screen/screen-dimensions.js";
import type { ToolDefinition } from "./get-current-time.js";
import { IS_MAC, IS_WIN, runPowerShellInline } from "./platform.js";

const execFileAsync = promisify(execFile);

// ── Helper: run AppleScript ───────────────────

// 25s: a cold Reminders launch took over 10s, and the kill read as "Command failed" with no
// reason. (Not retried: the first attempt may have gone through, and a retry would duplicate.)
async function runAS(script: string, timeout = 25000): Promise<string> {
    const tmpFile = join(tmpdir(), `atlas_app_${Date.now()}.scpt`);
    try {
        await fs.writeFile(tmpFile, script, "utf-8");
        const { stdout } = await execFileAsync("osascript", [tmpFile], { timeout });
        await fs.unlink(tmpFile).catch(() => {});
        return stdout.trim();
    } catch (err) {
        await fs.unlink(tmpFile).catch(() => {});
        if ((err as { killed?: boolean }).killed)
            throw new Error(`The app didn't answer within ${timeout / 1000}s (it may still be starting). Check whether it happened before trying again.`);
        throw err;
    }
}

// Escape for an AppleScript string literal: backslashes first, then quotes,
// so a trailing backslash in the input cannot end the literal early.
function asStr(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function runJXA(script: string, timeout = 10000): Promise<string> {
    const tmpFile = join(tmpdir(), `atlas_app_${Date.now()}.js`);
    try {
        await fs.writeFile(tmpFile, script, "utf-8");
        const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", tmpFile], { timeout });
        await fs.unlink(tmpFile).catch(() => {});
        return stdout.trim();
    } catch (err) {
        await fs.unlink(tmpFile).catch(() => {});
        throw err;
    }
}

// ═══════════════════════════════════════════════
// 2. MUSIC CONTROL (Apple Music)
// ═══════════════════════════════════════════════

// Storefront for catalog search: the Mac's region (AppleLocale "en_IN" → "IN").
let storefront: string | undefined;
async function getStorefront(): Promise<string> {
    if (storefront) return storefront;
    const { stdout } = await execFileAsync("defaults", ["read", "-g", "AppleLocale"], { timeout: 2000 }).catch(() => ({
        stdout: "",
    }));
    storefront = /_([A-Z]{2})/.exec(stdout)?.[1] ?? "US";
    return storefront;
}

/**
 * Play a song that is not in the library: find it with the public iTunes Search
 * API (no key), open its music:// link (Music selects the track row), then press
 * Return on that row. No screenshot or model call. Needs an Apple Music
 * subscription and Accessibility access; the caller verifies what is playing.
 */
export async function playCatalogTrack(query: string): Promise<{ track: string; artist: string } | { error: string }> {
    const country = await getStorefront();
    // limit=1 often comes back empty for a query limit=5 answers ("blinding lights the
    // weeknd": 0 vs 3), so take five and keep the one whose title and artist the query names.
    const res = await fetch(
        `https://itunes.apple.com/search?entity=song&limit=5&country=${country}&term=${encodeURIComponent(query)}`,
        { signal: AbortSignal.timeout(5000) },
    );
    const results =
        ((await res.json()) as { results?: { trackName: string; artistName: string; trackViewUrl: string }[] }).results ??
        [];
    const words = new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const named = (t: string) => (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => words.has(w)).length;
    const hit = results
        .map((r, i) => ({ r, score: named(r.trackName) * 2 + named(r.artistName) - i * 0.1 }))
        .sort((a, b) => b.score - a.score)[0]?.r;
    if (!hit) return { error: "not found in the Apple Music catalog" };
    if (!hit.trackViewUrl.startsWith("https://music.apple.com/")) return { error: "unexpected catalog link" };
    await execFileAsync("open", [hit.trackViewUrl.replace(/^https:/, "music:")], { timeout: 5000 });
    // Wait for the album page to load with the track row selected, then play it.
    const pressed = await runAS(`
tell application "System Events" to tell process "Music"
    repeat 30 times
        try
            repeat with sa in (scroll areas of splitter group 1 of window 1)
                repeat with t in (tables of sa whose description is "track list")
                    repeat with r in (rows of t whose selected is true)
                        -- The keystroke goes to the frontmost app: make sure that's Music.
                        set frontmost to true
                        set focused of t to true
                        key code 36
                        return "ok"
                    end repeat
                end repeat
            end repeat
        end try
        delay 0.2
    end repeat
    return "no_row"
end tell`);
    if (pressed !== "ok") return { error: "the song page did not load in Music" };
    // Up to ~5s: a cold catalog stream can take that long. Music may title the track a
    // little differently from the search API ("Starboy" vs "Starboy (feat. Daft Punk)").
    const want = hit.trackName.toLowerCase();
    for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const playing = `tell application "Music" to if player state is playing then return name of current track`;
        const now = (await runAS(playing).catch(() => "")).toLowerCase();
        if (now && (now.includes(want) || want.includes(now))) return { track: hit.trackName, artist: hit.artistName };
    }
    return { error: `opened "${hit.trackName}" but it did not start (Apple Music subscription needed?)` };
}

/**
 * What an app shows once it's in front: its front window, or that it has none yet, and
 * any dialog blocking input with its text and buttons. Without this, models typed into
 * TextEdit's file picker, or into an unsaved-changes alert, and reported success.
 * Waits up to ~2s for a just-launched app's first window.
 */
const WINDOW_BUTTONS = /^(close|minimize|full screen|zoom)$/i;
async function describeWindows(pid: number, pressedNew = false): Promise<Record<string, unknown>> {
    const { dumpAccessibilityTree, flattenInteractive, axPerformAction } = await import("../screen/ax-dump.js");
    type Node = import("../screen/ax-dump.js").AxNode;
    for (let i = 0; i < 5; i++) {
        const dump = await dumpAccessibilityTree({ pid, depth: 6, timeoutMs: 3000, budgetMs: 1500 }).catch(() => null);
        if (!dump || dump.error) return {};
        const windows = dump.root.children.filter((n) => n.role === "AXWindow");
        if (!windows.length) {
            await new Promise((r) => setTimeout(r, 250));
            continue;
        }
        const collect = (n: Node, role: string, out: string[]) => {
            const t = (role === "AXButton" ? n.label : n.value || n.label)?.trim();
            if (n.role === role && t && !out.includes(t) && out.length < 6) out.push(t.slice(0, 120));
            for (const c of n.children) collect(c, role, out);
            return out;
        };
        // Alerts, sheets, and the standard file panels (TextEdit opens on its Open panel).
        const dialog =
            windows.find((w) => w.subrole === "AXDialog" || w.subrole === "AXSystemDialog") ??
            windows[0].children.find((c) => c.role === "AXSheet") ??
            (/^(open|save|save as|export|print)$/i.test(windows[0].label ?? "") ? windows[0] : undefined);
        // An app that launches on its Open panel (TextEdit, Preview) is wanted for a new
        // document: given a note to handle the panel, small models typed into its search
        // box or escaped it and typed into no window. Opening a file later replaces the
        // untouched blank document.
        if (!pressedNew && dialog === windows[0] && /^open$/i.test(dialog.label ?? "")) {
            const button = flattenInteractive(dump).find(
                (e) => e.role === "AXButton" && /^new document$/i.test(e.label.trim()),
            );
            if (button && (await axPerformAction(pid, button, "press").catch(() => ({ ok: false }))).ok) {
                await new Promise((r) => setTimeout(r, 300));
                return {
                    ...(await describeWindows(pid, true)),
                    opened: "a new blank document (the app had opened on its Open panel)",
                };
            }
        }
        return {
            window: windows[0].label || "(untitled)",
            ...(dialog
                ? {
                      dialog: {
                          title: dialog.label || undefined,
                          text: collect(dialog, "AXStaticText", []),
                          buttons: collect(dialog, "AXButton", []).filter((b) => !WINDOW_BUTTONS.test(b)),
                      },
                      note: "A dialog is in front and takes the input: handle it first (click one of its buttons, or press escape to cancel it).",
                  }
                : {}),
        };
    }
    return { window: null, note: "The app has no window yet: open one (e.g. os_type combo='command+n')." };
}

export const musicControl: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "music_control",
            description:
                "Control Apple Music: play/pause, skip, previous, get now-playing info, or search and play any song (library first, then the Apple Music catalog, no screenshots needed). Use this when the user asks for Apple Music or Spotify is not available.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["play", "pause", "toggle", "next", "previous", "now_playing", "search_play"],
                        description: "Action to perform",
                    },
                    query: {
                        type: "string",
                        description:
                            "Search query for 'search_play': a song, artist, or one of the user's playlist names (e.g. 'Blinding Lights', 'Taylor Swift', 'Favourite Songs playlist')",
                    },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        if (!IS_MAC) {
            return JSON.stringify({
                success: false,
                error: "music_control is only available on macOS (Apple Music / iTunes).",
            });
        }
        const action = input.action as string;

        try {
            switch (action) {
                case "play":
                    await runAS(`tell application "Music" to play`);
                    return JSON.stringify({ success: true, action: "play" });

                case "pause":
                    await runAS(`tell application "Music" to pause`);
                    return JSON.stringify({ success: true, action: "pause" });

                case "toggle":
                    await runAS(`tell application "Music" to playpause`);
                    return JSON.stringify({ success: true, action: "toggle" });

                case "next":
                    await runAS(`tell application "Music" to next track`);
                    return JSON.stringify({ success: true, action: "next" });

                case "previous":
                    await runAS(`tell application "Music" to previous track`);
                    return JSON.stringify({ success: true, action: "previous" });

                case "now_playing": {
                    const info = await runAS(`
tell application "Music"
    if player state is playing then
        set t to name of current track
        set a to artist of current track
        set al to album of current track
        set d to duration of current track
        set p to player position
        return t & "|" & a & "|" & al & "|" & (d as integer) & "|" & (p as integer)
    else
        return "NOT_PLAYING"
    end if
end tell`);
                    if (info === "NOT_PLAYING") {
                        return JSON.stringify({ success: true, playing: false });
                    }
                    const parts = info.split("|");
                    return JSON.stringify({
                        success: true,
                        playing: true,
                        track: parts[0],
                        artist: parts[1],
                        album: parts[2],
                        duration_sec: parseInt(parts[3]) || 0,
                        position_sec: parseInt(parts[4]) || 0,
                    });
                }

                case "search_play": {
                    const query = input.query as string;
                    if (!query) return JSON.stringify({ error: "Provide 'query' for search_play." });
                    // A playlist of the user's by that name ("my chill playlist"), else the
                    // first library match. AppleScript's "is" ignores case.
                    const listName = query.replace(/^(my|the)\s+/i, "").replace(/\s+playlist$/i, "");
                    const result = await runAS(`
tell application "Music"
    repeat with p in user playlists
        if name of p is "${asStr(listName)}" then
            play p
            -- play returns before playback switches: wait until it plays from this list.
            repeat 30 times
                try
                    if player state is playing and name of current playlist is name of p then
                        return name of current track & "|" & artist of current track & "|" & name of p
                    end if
                end try
                delay 0.1
            end repeat
            return "NOT_STARTED|" & name of p
        end if
    end repeat
    set results to (search playlist "Library" for "${asStr(query)}")
    if (count of results) > 0 then
        play item 1 of results
        set t to name of current track
        set a to artist of current track
        return t & "|" & a
    else
        return "NO_RESULTS"
    end if
end tell`);
                    if (result === "NO_RESULTS") {
                        const catalog = await playCatalogTrack(query).catch((e: Error) => ({ error: e.message }));
                        if ("track" in catalog) {
                            return JSON.stringify({
                                success: true,
                                action: "search_play",
                                source: "catalog",
                                ...catalog,
                            });
                        }
                        return JSON.stringify({
                            success: false,
                            error: `No results for "${query}" in the Apple Music library, and the catalog play failed (${catalog.error}). Try the spotify tool (action='play', query='...') instead, or use os_screenshot + os_click to play it visually in whichever music app is open.`,
                        });
                    }
                    if (result.startsWith("NOT_STARTED|")) {
                        return JSON.stringify({
                            success: false,
                            error: `Asked Music to play the playlist "${result.slice(12)}" but it did not start.`,
                        });
                    }
                    const [track, artist, playlist] = result.split("|");
                    return JSON.stringify({ success: true, action: "search_play", track, artist, playlist });
                }

                default:
                    return JSON.stringify({ error: `Unknown action: ${action}` });
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 3. CALENDAR TOOL
// ═══════════════════════════════════════════════

export const calendarTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "calendar_tool",
            description:
                "Interact with macOS Calendar: list today's events, list events for a specific date, or create a new event.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["today", "list", "create"],
                        description:
                            "Action: 'today' for today's events, 'list' for a specific date, 'create' for new event",
                    },
                    date: {
                        type: "string",
                        description: "Date in YYYY-MM-DD format (for 'list' action)",
                    },
                    title: { type: "string", description: "Event title (for 'create')" },
                    start_time: {
                        type: "string",
                        description: "Start time in 'YYYY-MM-DD HH:MM' 24h format (for 'create')",
                    },
                    end_time: {
                        type: "string",
                        description: "End time in 'YYYY-MM-DD HH:MM' 24h format (for 'create')",
                    },
                    calendar_name: { type: "string", description: "Calendar name (default: first available)" },
                    location: { type: "string", description: "Event location (for 'create')" },
                    notes: { type: "string", description: "Event notes (for 'create')" },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        if (!IS_MAC) {
            return JSON.stringify({
                success: false,
                error: "calendar_tool is only available on macOS (requires the Calendar app).",
            });
        }
        const action = input.action as string;

        try {
            switch (action) {
                case "today":
                case "list": {
                    const dateStr =
                        action === "today"
                            ? new Date().toISOString().split("T")[0]
                            : (input.date as string) || new Date().toISOString().split("T")[0];
                    // Goes into the JXA script as code: a date and nothing else.
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return JSON.stringify({ error: "date must be YYYY-MM-DD." });

                    const result = await runJXA(
                        `
const cal = Application("Calendar");
const targetDate = new Date("${dateStr}T00:00:00");
const nextDay = new Date("${dateStr}T23:59:59");
const events = [];
const calendars = cal.calendars();
for (const c of calendars) {
    const evts = c.events.whose({
        _and: [
            { startDate: { _greaterThan: targetDate } },
            { startDate: { _lessThan: nextDay } }
        ]
    })();
    for (const e of evts) {
        events.push({
            title: e.summary(),
            start: e.startDate().toISOString(),
            end: e.endDate().toISOString(),
            location: e.location() || "",
            calendar: c.name(),
        });
    }
}
JSON.stringify(events);`,
                        10000,
                    );
                    const events = JSON.parse(result || "[]");
                    return JSON.stringify({ success: true, date: dateStr, count: events.length, events });
                }

                case "create": {
                    const title = input.title as string;
                    if (!title) return JSON.stringify({ error: "Provide 'title' for creating an event." });
                    const startTime = input.start_time as string;
                    if (!startTime)
                        return JSON.stringify({ error: "Provide 'start_time' in 'YYYY-MM-DD HH:MM' format." });
                    const endTime =
                        (input.end_time as string) ||
                        (() => {
                            // Default: 1 hour after start
                            const d = new Date(startTime);
                            d.setHours(d.getHours() + 1);
                            return d.toISOString().replace("T", " ").substring(0, 16);
                        })();
                    const calName = (input.calendar_name as string) || "";
                    const location = (input.location as string) || "";
                    const notes = (input.notes as string) || "";
                    // The times go into the JXA script unescaped: only a date and time get in
                    // (x"); ObjC.import("stdlib"); $.system("…"); (" would otherwise run as code).
                    const TIME = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
                    if (!TIME.test(startTime) || !TIME.test(endTime)) {
                        return JSON.stringify({ error: "start_time and end_time must be 'YYYY-MM-DD HH:MM'." });
                    }

                    const escaped = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

                    const result = await runJXA(
                        `
const cal = Application("Calendar");
let targetCal;
if ("${escaped(calName)}") {
    targetCal = cal.calendars.whose({ name: "${escaped(calName)}" })[0];
} else {
    targetCal = cal.calendars[0];
}
const evt = cal.Event({
    summary: "${escaped(title)}",
    startDate: new Date("${startTime}"),
    endDate: new Date("${endTime}"),
    location: "${escaped(location)}",
    description: "${escaped(notes)}",
});
targetCal.events.push(evt);
JSON.stringify({ title: "${escaped(title)}", start: "${startTime}", end: "${endTime}", calendar: targetCal.name() });`,
                        10000,
                    );
                    return JSON.stringify({ success: true, action: "create", ...JSON.parse(result || "{}") });
                }

                default:
                    return JSON.stringify({ error: `Unknown action: ${action}` });
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 4. REMINDERS TOOL
// ═══════════════════════════════════════════════

/**
 * "tomorrow 10am", "today at 5:30 pm", "friday 9am", "in 2 hours", "2026-10-31 10:00" → a local
 * Date, or null. gpt-4.1-nano passed "2023-10-09 10:00" for "tomorrow at 10am" (it had no clock).
 */
export function parseWhen(text: string, now = new Date()): Date | null {
    const t = text.trim().toLowerCase();
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](\d{1,2}):(\d{2}))?/.exec(t);
    if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] ?? 9), +(iso[5] ?? 0));
    const rel = /\bin (\d+) (minute|min|hour|hr|day)s?\b/.exec(t);
    if (rel) {
        const unit = rel[2].startsWith("d") ? 864e5 : rel[2].startsWith("h") ? 36e5 : 6e4;
        return new Date(now.getTime() + Number(rel[1]) * unit);
    }
    const d = new Date(now);
    const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].findIndex((w) =>
        t.includes(w),
    );
    const clock = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(t) ?? /\b(\d{1,2}):(\d{2})\b/.exec(t);
    if (/\btomorrow\b/.test(t)) d.setDate(d.getDate() + 1);
    else if (weekday >= 0) d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7 || 7));
    else if (!/\b(today|tonight|noon)\b/.test(t) && !clock) return null;
    let h = /\bnoon\b/.test(t) ? 12 : /\btonight\b/.test(t) ? 20 : 9;
    let m = 0;
    if (clock) {
        h = Number(clock[1]) % (clock[3] ? 12 : 24);
        if (clock[3] === "pm") h += 12;
        m = Number(clock[2] ?? 0);
    }
    d.setHours(h, m, 0, 0);
    return d;
}

/** The fast way to drive an app, returned when it's brought forward. Given a plan to "click the
 *  buttons", gpt-4.1-nano pressed Calculator's keys one by one in the wrong order. */
const APP_TIPS: Record<string, string> = {
    Calculator:
        "Use the calculator tool (expression '17*23'): it enters it and returns the result. Or type the whole expression in one os_type call (text '17*23', key 'return'). Don't click its buttons one by one.",
};

/** An AppleScript date built field by field: `date "<string>"` parses by the Mac's locale. */
function asDate(d: Date): string {
    return `(my mkDate(${d.getFullYear()}, ${d.getMonth() + 1}, ${d.getDate()}, ${d.getHours()}, ${d.getMinutes()}))`;
}
const AS_MKDATE = `
on mkDate(y, mo, dd, h, mi)
    set d to current date
    set day of d to 1
    set year of d to y
    set month of d to mo
    set day of d to dd
    set hours of d to h
    set minutes of d to mi
    set seconds of d to 0
    return d
end mkDate`;

/** The due date, or why it can't be one. */
function dueFrom(text: string): { date?: Date; error?: string } {
    const now = new Date();
    const date = parseWhen(text, now);
    if (!date) return { error: `Couldn't read "${text}" as a time: use e.g. "tomorrow 10am", "friday 9am", "in 2 hours" or "2026-11-02 14:30".` };
    if (date.getTime() < now.getTime() - 60_000)
        return { error: `${date.toLocaleString()} is in the past (it's ${now.toLocaleString()} now). Use a future time, e.g. "tomorrow 10am".` };
    return { date };
}

export const remindersTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "reminders_tool",
            description: "Interact with macOS Reminders: create a reminder, list reminders, or mark one as complete.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: [
                            "create",
                            "list",
                            "complete",
                            "overdue",
                            "edit",
                            "delete",
                            "lists",
                            "create_list",
                            "delete_list",
                            "rename_list",
                        ],
                        description: "Action to perform",
                    },
                    title: { type: "string", description: "Reminder text (for 'create'), or new title (for 'edit')" },
                    due_date: {
                        type: "string",
                        description:
                            "When it's due, in words or as a date: 'tomorrow 10am', 'friday 9am', 'in 2 hours', '2026-11-02 14:30' (for 'create' or 'edit')",
                    },
                    list_name: { type: "string", description: "Reminders list name (default: default list)" },
                    reminder_name: {
                        type: "string",
                        description: "Name of reminder (for 'complete', 'edit', 'delete')",
                    },
                    new_name: { type: "string", description: "New name (for 'rename_list')" },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        if (!IS_MAC) {
            return JSON.stringify({
                success: false,
                error: "reminders_tool is only available on macOS (requires the Reminders app).",
            });
        }
        const action = input.action as string;

        try {
            switch (action) {
                case "create": {
                    const title = input.title as string;
                    if (!title) return JSON.stringify({ error: "Provide 'title' for the reminder." });
                    const dueDate = input.due_date as string;
                    const listName = (input.list_name as string) || "";
                    const escaped = asStr;

                    let script: string;
                    if (dueDate) {
                        const due = dueFrom(dueDate);
                        if (!due.date) return JSON.stringify({ success: false, error: due.error });
                        script = `${AS_MKDATE}
tell application "Reminders"
    ${listName ? `set targetList to list "${escaped(listName)}"` : "set targetList to default list"}
    tell targetList
        set newReminder to make new reminder with properties {name:"${escaped(title)}", due date:${asDate(due.date)}}
    end tell
    return name of newReminder
end tell`;
                    } else {
                        script = `
tell application "Reminders"
    ${listName ? `set targetList to list "${escaped(listName)}"` : "set targetList to default list"}
    tell targetList
        set newReminder to make new reminder with properties {name:"${escaped(title)}"}
    end tell
    return name of newReminder
end tell`;
                    }
                    const name = await runAS(script);
                    return JSON.stringify({ success: true, action: "create", reminder: name });
                }

                case "list": {
                    const listName = (input.list_name as string) || "";
                    const result = await runAS(`
tell application "Reminders"
    ${listName ? `set targetList to list "${asStr(listName)}"` : "set targetList to default list"}
    set output to ""
    repeat with r in (reminders of targetList whose completed is false)
        set dueStr to ""
        try
            set dueStr to (due date of r as text)
        end try
        set output to output & name of r & "||" & dueStr & "\\n"
    end repeat
    return output
end tell`);
                    const reminders = result
                        .split("\n")
                        .filter(Boolean)
                        .map((line) => {
                            const [name, due] = line.split("||");
                            return { name: name?.trim(), due: due?.trim() || null };
                        });
                    return JSON.stringify({ success: true, count: reminders.length, reminders });
                }

                case "complete": {
                    const reminderName = input.reminder_name as string;
                    if (!reminderName) return JSON.stringify({ error: "Provide 'reminder_name' to complete." });
                    const escaped = asStr(reminderName);
                    await runAS(`
tell application "Reminders"
    set targetReminders to (reminders whose name is "${escaped}" and completed is false)
    if (count of targetReminders) > 0 then
        set completed of item 1 of targetReminders to true
    end if
end tell`);
                    return JSON.stringify({ success: true, action: "complete", reminder: reminderName });
                }

                case "overdue": {
                    const result = await runAS(`
tell application "Reminders"
    set output to ""
    set now to current date
    repeat with r in (every reminder whose completed is false and due date is not missing value)
        if due date of r < now then
            set dueStr to (due date of r as text)
            set listName to name of container of r
            set output to output & name of r & "||" & dueStr & "||" & listName & "\\n"
        end if
    end repeat
    return output
end tell`);
                    const reminders = result
                        .split("\n")
                        .filter(Boolean)
                        .map((line) => {
                            const [name, due, list] = line.split("||");
                            return { name: name?.trim(), due: due?.trim(), list: list?.trim() };
                        });
                    return JSON.stringify({ success: true, count: reminders.length, overdue: reminders });
                }

                case "edit": {
                    const reminderName = input.reminder_name as string;
                    if (!reminderName) return JSON.stringify({ error: "Provide 'reminder_name' to edit." });
                    const newTitle = (input.title as string) || "";
                    const newDueDate = (input.due_date as string) || "";
                    if (!newTitle && !newDueDate)
                        return JSON.stringify({ error: "Provide 'title' and/or 'due_date' to update." });
                    const escapedName = asStr(reminderName);
                    const due = newDueDate ? dueFrom(newDueDate) : {};
                    if (newDueDate && !due.date) return JSON.stringify({ success: false, error: due.error });
                    let editScript = `${AS_MKDATE}
tell application "Reminders"
    set targetReminders to (reminders whose name is "${escapedName}" and completed is false)
    if (count of targetReminders) > 0 then
        set r to item 1 of targetReminders`;
                    if (newTitle) editScript += `\n        set name of r to "${asStr(newTitle)}"`;
                    if (due.date) editScript += `\n        set due date of r to ${asDate(due.date)}`;
                    editScript += `
        return name of r
    else
        return "NOT_FOUND"
    end if
end tell`;
                    const editResult = await runAS(editScript);
                    if (editResult === "NOT_FOUND")
                        return JSON.stringify({ success: false, error: "Reminder not found." });
                    return JSON.stringify({ success: true, action: "edit", reminder: editResult });
                }

                case "delete": {
                    const reminderName = input.reminder_name as string;
                    if (!reminderName) return JSON.stringify({ error: "Provide 'reminder_name' to delete." });
                    await runAS(`
tell application "Reminders"
    set targetReminders to (reminders whose name is "${asStr(reminderName)}")
    if (count of targetReminders) > 0 then
        delete item 1 of targetReminders
    end if
end tell`);
                    return JSON.stringify({ success: true, action: "delete", reminder: reminderName });
                }

                case "lists": {
                    const result = await runAS(`
tell application "Reminders"
    set output to ""
    repeat with l in lists
        set c to count of (reminders of l whose completed is false)
        set output to output & name of l & "||" & c & "\\n"
    end repeat
    return output
end tell`);
                    const lists = result
                        .split("\n")
                        .filter(Boolean)
                        .map((line) => {
                            const [name, count] = line.split("||");
                            return { name: name?.trim(), pending_count: parseInt(count?.trim()) || 0 };
                        });
                    return JSON.stringify({ success: true, lists });
                }

                case "create_list": {
                    const listName = input.list_name as string;
                    if (!listName) return JSON.stringify({ error: "Provide 'list_name' for the new list." });
                    await runAS(`
tell application "Reminders"
    make new list with properties {name:"${asStr(listName)}"}
end tell`);
                    return JSON.stringify({ success: true, action: "create_list", list: listName });
                }

                case "delete_list": {
                    const listName = input.list_name as string;
                    if (!listName) return JSON.stringify({ error: "Provide 'list_name' to delete." });
                    await runAS(`
tell application "Reminders"
    delete list "${asStr(listName)}"
end tell`);
                    return JSON.stringify({ success: true, action: "delete_list", list: listName });
                }

                case "rename_list": {
                    const listName = input.list_name as string;
                    const newName = input.new_name as string;
                    if (!listName || !newName) return JSON.stringify({ error: "Provide 'list_name' and 'new_name'." });
                    await runAS(`
tell application "Reminders"
    set name of list "${asStr(listName)}" to "${asStr(newName)}"
end tell`);
                    return JSON.stringify({ success: true, action: "rename_list", from: listName, to: newName });
                }

                default:
                    return JSON.stringify({ error: `Unknown action: ${action}` });
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 5. MESSAGES TOOL (iMessage)
// ═══════════════════════════════════════════════

export const messagesTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "messages_tool",
            description:
                "Send an iMessage or read recent messages. Requires the Messages app and an active iMessage account.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["send", "read_recent"],
                        description: "Action: 'send' to send a message, 'read_recent' to get recent messages",
                    },
                    to: { type: "string", description: "Phone number or email address to send to (for 'send')" },
                    text: { type: "string", description: "Message text (for 'send')" },
                    count: {
                        type: "number",
                        description: "Number of recent messages to retrieve (default: 10, for 'read_recent')",
                    },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        if (!IS_MAC) {
            return JSON.stringify({
                success: false,
                error: "messages_tool is only available on macOS (requires the Messages app and iMessage).",
            });
        }
        const action = input.action as string;

        try {
            switch (action) {
                case "send": {
                    const to = input.to as string;
                    const text = input.text as string;
                    if (!to) return JSON.stringify({ error: "Provide 'to' (phone number or email)." });
                    if (!text) return JSON.stringify({ error: "Provide 'text' for the message." });
                    const escapedText = asStr(text);
                    const escapedTo = asStr(to);

                    await runAS(
                        `
tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant "${escapedTo}" of targetService
    send "${escapedText}" to targetBuddy
end tell`,
                        15000,
                    );
                    return JSON.stringify({ success: true, action: "send", to, preview: text.substring(0, 50) });
                }

                case "read_recent": {
                    const count = Math.min((input.count as number) || 10, 30);
                    // Read from the Messages SQLite database for reliability
                    const { stdout } = await execFileAsync(
                        "sqlite3",
                        [
                            `${process.env.HOME}/Library/Messages/chat.db`,
                            `-json`,
                            `SELECT 
                            m.text,
                            m.is_from_me,
                            datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as timestamp,
                            h.id as contact
                        FROM message m
                        LEFT JOIN handle h ON m.handle_id = h.ROWID
                        WHERE m.text IS NOT NULL
                        ORDER BY m.date DESC
                        LIMIT ${count}`,
                        ],
                        { timeout: 5000 },
                    );
                    const messages = JSON.parse(stdout || "[]");
                    return JSON.stringify({ success: true, count: messages.length, messages });
                }

                default:
                    return JSON.stringify({ error: `Unknown action: ${action}` });
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 6. WINDOW MANAGEMENT
// ═══════════════════════════════════════════════

export const windowManage: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "window_manage",
            description:
                "Manage macOS windows: move, resize, minimize, fullscreen, or arrange windows on screen (e.g. split screen left/right half).",
            parameters: {
                type: "object",
                properties: {
                    app: {
                        type: "string",
                        description:
                            "Application name (e.g. 'Safari', 'Visual Studio Code'). If omitted, uses frontmost app.",
                    },
                    action: {
                        type: "string",
                        enum: [
                            "left_half",
                            "right_half",
                            "maximize",
                            "minimize",
                            "center",
                            "fullscreen",
                            "move",
                            "restore",
                        ],
                        description: "Window arrangement action",
                    },
                    x: { type: "number", description: "X position (for 'move' action)" },
                    y: { type: "number", description: "Y position (for 'move' action)" },
                    width: { type: "number", description: "Width (for 'move' action)" },
                    height: { type: "number", description: "Height (for 'move' action)" },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        if (!IS_MAC) {
            return JSON.stringify({
                success: false,
                error: "window_manager is only available on macOS. On Windows, use PowerShell with Win32 API or the built-in Snap Layouts (Win+Z).",
            });
        }
        const action = input.action as string;
        const app = (input.app as string) || "";

        try {
            // Get screen dimensions
            const screenInfo = await runJXA(`
const se = Application("System Events");
const screen = se.desktops[0];
// Get screen size from Finder
const finder = Application("Finder");
const bounds = finder.desktop.window.bounds();
JSON.stringify({ w: bounds.width || 1440, h: bounds.height || 900 });`).catch(() => '{"w":1440,"h":900}');

            let screenW: number, screenH: number;
            try {
                const parsed = JSON.parse(screenInfo);
                screenW = parsed.w;
                screenH = parsed.h;
            } catch {
                screenW = 1440;
                screenH = 900;
            }

            // Menu bar height offset
            const menuBarH = 25;
            const appTarget = app ? `tell process "${asStr(app)}"` : `tell (first process whose frontmost is true)`;

            let bounds: { x: number; y: number; w: number; h: number };

            switch (action) {
                case "left_half":
                    bounds = { x: 0, y: menuBarH, w: Math.floor(screenW / 2), h: screenH - menuBarH };
                    break;
                case "right_half":
                    bounds = {
                        x: Math.floor(screenW / 2),
                        y: menuBarH,
                        w: Math.floor(screenW / 2),
                        h: screenH - menuBarH,
                    };
                    break;
                case "maximize":
                    bounds = { x: 0, y: menuBarH, w: screenW, h: screenH - menuBarH };
                    break;
                case "center": {
                    const cw = Math.floor(screenW * 0.6);
                    const ch = Math.floor(screenH * 0.7);
                    bounds = { x: Math.floor((screenW - cw) / 2), y: Math.floor((screenH - ch) / 2), w: cw, h: ch };
                    break;
                }
                case "minimize":
                    await runAS(`
tell application "System Events"
    ${appTarget}
        try
            click button 3 of window 1
        on error
            set miniaturized of window 1 to true
        end try
    end tell
end tell`);
                    return JSON.stringify({ success: true, action: "minimize", app: app || "frontmost" });
                case "fullscreen":
                    await runAS(`
tell application "System Events"
    ${appTarget}
        try
            -- Toggle fullscreen via green button
            click button 2 of window 1
        end try
    end tell
end tell`);
                    return JSON.stringify({ success: true, action: "fullscreen", app: app || "frontmost" });
                case "move":
                    bounds = {
                        x: (input.x as number) || 0,
                        y: (input.y as number) || 0,
                        w: (input.width as number) || 800,
                        h: (input.height as number) || 600,
                    };
                    break;
                case "restore":
                    bounds = { x: 100, y: 100, w: Math.floor(screenW * 0.6), h: Math.floor(screenH * 0.7) };
                    break;
                default:
                    return JSON.stringify({ error: `Unknown action: ${action}` });
            }

            // Set position and size
            await runAS(`
tell application "System Events"
    ${appTarget}
        try
            set position of window 1 to {${bounds.x}, ${bounds.y}}
            set size of window 1 to {${bounds.w}, ${bounds.h}}
        end try
    end tell
end tell`);

            return JSON.stringify({
                success: true,
                action,
                app: app || "frontmost",
                bounds: { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h },
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 7. OS DRAG (Mouse Drag)
// ═══════════════════════════════════════════════

// Screen calibration: import from macos.ts at runtime isn't possible,
// so os_drag always uses raw screen coordinates. Use os_screenshot coords.
export const osDrag: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_drag",
            description:
                "Perform a mouse drag from one point to another on macOS. Useful for drag-and-drop, slider adjustment, drawing, and rearranging items. Coordinates are os_screenshot image pixels (its grid labels), like os_click; pass raw=true for screen points.",
            parameters: {
                type: "object",
                properties: {
                    from_x: { type: "number", description: "Starting X coordinate" },
                    from_y: { type: "number", description: "Starting Y coordinate" },
                    to_x: { type: "number", description: "Ending X coordinate" },
                    to_y: { type: "number", description: "Ending Y coordinate" },
                    duration_ms: {
                        type: "number",
                        description: "Duration of the drag in milliseconds (default: 500). Increase for precision.",
                    },
                    raw: { type: "boolean", description: "Treat coordinates as raw screen points (default: false)." },
                },
                required: ["from_x", "from_y", "to_x", "to_y"],
            },
        },
    },

    async handler(input) {
        if (!IS_MAC) {
            return JSON.stringify({ success: false, error: "os_drag is only available on macOS (uses CoreGraphics)." });
        }
        // Same frame as os_click: pixels of the 1280-wide os_screenshot image.
        // Number() also keeps non-numeric args out of the JXA source below.
        const dims = await getScreenDimensions({ focusedWindow: true });
        const at = (x: unknown, y: unknown) =>
            scaleImageToScreen({ rawX: Number(x), rawY: Number(y), imageWidth: 1280, dims, raw: input.raw === true });
        const { x: fromX, y: fromY } = at(input.from_x, input.from_y);
        const { x: toX, y: toY } = at(input.to_x, input.to_y);
        if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
            return JSON.stringify({ success: false, error: "from_x, from_y, to_x and to_y must be numbers." });
        }
        const durationMs = Number(input.duration_ms) || 500;
        const steps = Math.max(10, Math.floor(durationMs / 16)); // ~60fps

        try {
            const dragScript = `
ObjC.import('CoreGraphics');

var fromX = ${fromX}, fromY = ${fromY};
var toX = ${toX}, toY = ${toY};
var steps = ${steps};

// Move to starting position
var startPoint = $.CGPointMake(fromX, fromY);
var moveEvent = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, startPoint, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, moveEvent);
delay(0.05);

// Mouse down at start
var downEvent = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, startPoint, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, downEvent);
delay(0.05);

// Drag in steps
for (var i = 1; i <= steps; i++) {
    var progress = i / steps;
    var curX = fromX + (toX - fromX) * progress;
    var curY = fromY + (toY - fromY) * progress;
    var point = $.CGPointMake(curX, curY);
    var dragEvent = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDragged, point, $.kCGMouseButtonLeft);
    $.CGEventPost($.kCGHIDEventTap, dragEvent);
    delay(${(durationMs / steps / 1000).toFixed(4)});
}

// Mouse up at end
var endPoint = $.CGPointMake(toX, toY);
var upEvent = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, endPoint, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, upEvent);
"dragged";`;

            const result = await runJXA(dragScript, durationMs + 5000);
            return JSON.stringify({
                success: true,
                from: { x: fromX, y: fromY },
                to: { x: toX, y: toY },
                steps,
                result: result || "dragged",
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 8. APP MANAGER
// ═══════════════════════════════════════════════

export const appManager: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "app_manager",
            description:
                "Manage running applications: list all running apps, quit an app, force quit, hide, or show an app.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["list", "quit", "force_quit", "hide", "unhide", "activate"],
                        description: "Action to perform",
                    },
                    app: {
                        type: "string",
                        description:
                            'Application name, e.g. "WhatsApp", "Safari", "Visual Studio Code". Required for every action except `list`. Accepts the alias `app_name` for compatibility.',
                    },
                    app_name: {
                        type: "string",
                        description: "Alias for `app`. Either field works; if both are provided, `app` wins.",
                    },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        const action = input.action as string;
        // Postel's law — small models routinely emit `app_name` even when the
        // schema says `app`. Failing the call wastes a round-trip and pushes
        // the agent toward fragile fallbacks (raw AppleScript keystrokes).
        const app = (input.app as string) || (input.app_name as string);

        try {
            // Windows: use PowerShell for app management
            if (IS_WIN) {
                // PowerShell single-quoted literal: no $() or backtick expansion; ' (and its
                // smart-quote forms, which PowerShell also treats as quotes) is doubled.
                const psName = `'${(app ?? "").replace(/['\u2018\u2019\u201A\u201B]/g, "''")}'`;
                switch (action) {
                    case "list": {
                        const result = await runPowerShellInline(
                            `Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object ProcessName,Id | ConvertTo-Json -Compress`,
                            5000,
                        );
                        const procs = JSON.parse(result.trim() || "[]");
                        const arr = Array.isArray(procs) ? procs : [procs];
                        return JSON.stringify({
                            success: true,
                            count: arr.length,
                            apps: arr.map((p: Record<string, unknown>) => ({
                                name: p.ProcessName,
                                frontmost: false,
                                visible: true,
                            })),
                        });
                    }
                    case "quit":
                        if (!app) return JSON.stringify({ error: "Provide 'app' name to quit." });
                        await runPowerShellInline(
                            `Stop-Process -Name ${psName} -ErrorAction SilentlyContinue`,
                            5000,
                        );
                        return JSON.stringify({ success: true, action: "quit", app });
                    case "force_quit":
                        if (!app) return JSON.stringify({ error: "Provide 'app' name to force quit." });
                        await runPowerShellInline(
                            `Stop-Process -Name ${psName} -Force -ErrorAction SilentlyContinue`,
                            5000,
                        );
                        return JSON.stringify({ success: true, action: "force_quit", app });
                    case "hide":
                    case "unhide":
                        return JSON.stringify({ success: false, error: `${action} is not supported on Windows.` });
                    case "activate":
                        if (!app) return JSON.stringify({ error: "Provide 'app' name to activate." });
                        await runPowerShellInline(`Start-Process ${psName} -ErrorAction SilentlyContinue`, 5000);
                        return JSON.stringify({ success: true, action: "activate", app });
                    default:
                        return JSON.stringify({ error: `Unknown action: ${action}` });
                }
            }

            // macOS / Linux
            switch (action) {
                case "list": {
                    const result = await runJXA(`
const se = Application("System Events");
const procs = se.processes.whose({ backgroundOnly: false })();
const apps = procs.map(p => ({
    name: p.name(),
    frontmost: p.frontmost(),
    visible: p.visible(),
}));
JSON.stringify(apps);`);
                    const apps = JSON.parse(result || "[]");
                    return JSON.stringify({ success: true, count: apps.length, apps });
                }

                case "quit": {
                    if (!app) return JSON.stringify({ error: "Provide 'app' name to quit." });
                    await runAS(`
tell application "${asStr(app)}" to quit`);
                    return JSON.stringify({ success: true, action: "quit", app });
                }

                case "force_quit": {
                    if (!app) return JSON.stringify({ error: "Provide 'app' name to force quit." });
                    await execFileAsync("pkill", ["-x", app], { timeout: 3000 }).catch(() => {});
                    return JSON.stringify({ success: true, action: "force_quit", app });
                }

                case "hide": {
                    if (!app) return JSON.stringify({ error: "Provide 'app' name to hide." });
                    await runAS(`
tell application "System Events"
    set visible of process "${asStr(app)}" to false
end tell`);
                    return JSON.stringify({ success: true, action: "hide", app });
                }

                case "unhide": {
                    if (!app) return JSON.stringify({ error: "Provide 'app' name to unhide." });
                    await runAS(`
tell application "System Events"
    set visible of process "${asStr(app)}" to true
end tell`);
                    return JSON.stringify({ success: true, action: "unhide", app });
                }

                case "activate": {
                    if (!app) return JSON.stringify({ error: "Provide 'app' name to activate." });
                    await execFileAsync("open", ["-a", app], { timeout: 5000 });
                    // `open -a` returns before the app is in front: keystrokes sent
                    // now would land in the previous app. Wait until it really is.
                    if (process.platform === "darwin") {
                        const { getFrontmostApp, waitForFrontmost } = await import("../screen/frontmost.js");
                        const front = await waitForFrontmost(app, 5000);
                        if (!front) {
                            const now = await getFrontmostApp();
                            return JSON.stringify({
                                success: false,
                                action: "activate",
                                app,
                                error: `${app} did not come to the front within 5s${now ? ` (frontmost is still ${now.name})` : ""}.`,
                            });
                        }
                        return JSON.stringify({
                            success: true,
                            action: "activate",
                            app,
                            frontmost: front.name,
                            pid: front.pid,
                            ...(await describeWindows(front.pid)),
                            ...(APP_TIPS[front.name] ? { tip: APP_TIPS[front.name] } : {}),
                        });
                    }
                    return JSON.stringify({ success: true, action: "activate", app });
                }

                default:
                    return JSON.stringify({ error: `Unknown action: ${action}` });
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

/** "123 times 45" → "123*45"; null when it isn't plain arithmetic Calculator can take. */
export function calcExpression(text: string): string | null {
    const expr = text
        .toLowerCase()
        .replace(/\bmultiplied by\b|\btimes\b|\bx\b|×/g, "*")
        .replace(/\bdivided by\b|÷/g, "/")
        .replace(/\bplus\b/g, "+")
        .replace(/\bminus\b|[−–]/g, "-")
        .replace(/(\d),(?=\d{3}\b)/g, "$1") // 1,234 → 1234
        .replace(/=+\s*$/, "")
        .trim();
    return expr && /^[\d\s.+\-*/()%]+$/.test(expr) ? expr : null;
}

/**
 * Calculator in one call: open it, clear it, enter the expression, read the result off its
 * display. Weak models pressed its keys out of order, typed sums into TextEdit, or wandered
 * into its menus; this way every model gets the right number.
 */
export const calculatorTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "calculator",
            description:
                "Work something out in the Calculator app in one step: opens Calculator, enters the expression and returns the result on its display. Use this whenever the user wants Calculator used (instead of clicking its keys). Operators: + - * / ( ) %.",
            parameters: {
                type: "object",
                properties: {
                    expression: { type: "string", description: "e.g. '17*23+100' or '123 times 45'" },
                },
                required: ["expression"],
            },
        },
    },
    async handler(input) {
        if (!IS_MAC) return JSON.stringify({ success: false, error: "calculator drives the macOS Calculator app." });
        const expr = calcExpression(String(input.expression ?? ""));
        if (!expr) return JSON.stringify({ success: false, error: `Use digits and + - * / ( ) % only (got "${input.expression}").` });
        try {
            const { waitForFrontmost } = await import("../screen/frontmost.js");
            await execFileAsync("open", ["-a", "Calculator"], { timeout: 5000 });
            const front = await waitForFrontmost("Calculator", 5000);
            if (!front) return JSON.stringify({ success: false, error: "Calculator didn't come to the front." });
            // Clear (it keeps its last entry, even across a relaunch), enter, evaluate.
            await runAS('tell application "System Events" to repeat 2 times\nkey code 53\ndelay 0.05\nend repeat');
            const { typeTextMac } = await import("./os-computer-action.js");
            await typeTextMac(expr);
            await runAS('tell application "System Events" to key code 36');
            await new Promise((r) => setTimeout(r, 200));
            const { dumpAccessibilityTree } = await import("../screen/ax-dump.js");
            const dump = await dumpAccessibilityTree({ pid: front.pid, depth: 12 });
            let result = "";
            let shown = "";
            const stack = dump.error ? [] : [dump.root];
            for (let n = stack.pop(); n; n = stack.pop()) {
                if (n.role === "AXStaticText" && n.label === "Edit field") result = (n.value ?? "").trim();
                if (n.role === "AXStaticText" && n.label === "Last Expression") shown = (n.value ?? "").trim();
                stack.push(...n.children);
            }
            if (!result) return JSON.stringify({ success: false, error: "Couldn't read Calculator's display." });
            return JSON.stringify({ success: true, expression: shown || expr, result });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message.slice(0, 200) });
        }
    },
};
