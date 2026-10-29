// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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

async function runAS(script: string, timeout = 10000): Promise<string> {
    const tmpFile = join(tmpdir(), `atlas_app_${Date.now()}.scpt`);
    try {
        await fs.writeFile(tmpFile, script, "utf-8");
        const { stdout } = await execFileAsync("osascript", [tmpFile], { timeout });
        await fs.unlink(tmpFile).catch(() => {});
        return stdout.trim();
    } catch (err) {
        await fs.unlink(tmpFile).catch(() => {});
        throw err;
    }
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

export const musicControl: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "music_control",
            description:
                "Control Apple Music: play/pause, skip, previous, get now-playing info, or search and play. Use this when Spotify is not available or the user prefers Apple Music.",
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
                        description: "Search query for 'search_play' (e.g. 'Taylor Swift', 'Blinding Lights')",
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
                    // Search in Music library and play first match
                    const result = await runAS(`
tell application "Music"
    set results to (search playlist "Library" for "${query.replace(/"/g, '\\"')}")
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
                        return JSON.stringify({
                            success: false,
                            error: `No results for "${query}" in Apple Music library. Try the spotify tool (action='play', query='...') instead, or use os_screenshot + os_click to play it visually in whichever music app is open.`,
                        });
                    }
                    const [track, artist] = result.split("|");
                    return JSON.stringify({ success: true, action: "search_play", track, artist });
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
                        description: "Due date in 'YYYY-MM-DD HH:MM' format (for 'create' or 'edit')",
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
                    const escaped = (s: string) => s.replace(/"/g, '\\"');

                    let script: string;
                    if (dueDate) {
                        script = `
tell application "Reminders"
    ${listName ? `set targetList to list "${escaped(listName)}"` : "set targetList to default list"}
    tell targetList
        set newReminder to make new reminder with properties {name:"${escaped(title)}", due date:date "${dueDate}"}
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
    ${listName ? `set targetList to list "${listName.replace(/"/g, '\\"')}"` : "set targetList to default list"}
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
                    const escaped = reminderName.replace(/"/g, '\\"');
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
                    const escapedName = reminderName.replace(/"/g, '\\"');
                    let editScript = `
tell application "Reminders"
    set targetReminders to (reminders whose name is "${escapedName}" and completed is false)
    if (count of targetReminders) > 0 then
        set r to item 1 of targetReminders`;
                    if (newTitle) editScript += `\n        set name of r to "${newTitle.replace(/"/g, '\\"')}"`;
                    if (newDueDate) editScript += `\n        set due date of r to date "${newDueDate}"`;
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
    set targetReminders to (reminders whose name is "${reminderName.replace(/"/g, '\\"')}")
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
    make new list with properties {name:"${listName.replace(/"/g, '\\"')}"}
end tell`);
                    return JSON.stringify({ success: true, action: "create_list", list: listName });
                }

                case "delete_list": {
                    const listName = input.list_name as string;
                    if (!listName) return JSON.stringify({ error: "Provide 'list_name' to delete." });
                    await runAS(`
tell application "Reminders"
    delete list "${listName.replace(/"/g, '\\"')}"
end tell`);
                    return JSON.stringify({ success: true, action: "delete_list", list: listName });
                }

                case "rename_list": {
                    const listName = input.list_name as string;
                    const newName = input.new_name as string;
                    if (!listName || !newName) return JSON.stringify({ error: "Provide 'list_name' and 'new_name'." });
                    await runAS(`
tell application "Reminders"
    set name of list "${listName.replace(/"/g, '\\"')}" to "${newName.replace(/"/g, '\\"')}"
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
                    const escapedText = text.replace(/"/g, '\\"');
                    const escapedTo = to.replace(/"/g, '\\"');

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
            const appTarget = app
                ? `tell process "${app.replace(/"/g, '\\"')}"`
                : `tell (first process whose frontmost is true)`;

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
                const safeName = app ? app.replace(/"/g, "") : "";
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
                            `Stop-Process -Name "${safeName}" -ErrorAction SilentlyContinue`,
                            5000,
                        );
                        return JSON.stringify({ success: true, action: "quit", app });
                    case "force_quit":
                        if (!app) return JSON.stringify({ error: "Provide 'app' name to force quit." });
                        await runPowerShellInline(
                            `Stop-Process -Name "${safeName}" -Force -ErrorAction SilentlyContinue`,
                            5000,
                        );
                        return JSON.stringify({ success: true, action: "force_quit", app });
                    case "hide":
                    case "unhide":
                        return JSON.stringify({ success: false, error: `${action} is not supported on Windows.` });
                    case "activate":
                        if (!app) return JSON.stringify({ error: "Provide 'app' name to activate." });
                        await runPowerShellInline(`Start-Process "${safeName}" -ErrorAction SilentlyContinue`, 5000);
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
tell application "${app.replace(/"/g, '\\"')}" to quit`);
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
    set visible of process "${app.replace(/"/g, '\\"')}" to false
end tell`);
                    return JSON.stringify({ success: true, action: "hide", app });
                }

                case "unhide": {
                    if (!app) return JSON.stringify({ error: "Provide 'app' name to unhide." });
                    await runAS(`
tell application "System Events"
    set visible of process "${app.replace(/"/g, '\\"')}" to true
end tell`);
                    return JSON.stringify({ success: true, action: "unhide", app });
                }

                case "activate": {
                    if (!app) return JSON.stringify({ error: "Provide 'app' name to activate." });
                    await execFileAsync("open", ["-a", app], { timeout: 5000 });
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
