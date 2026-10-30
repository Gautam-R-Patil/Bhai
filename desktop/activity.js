// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// "Bhai did today" on the dashboard: what Bhai actually got done, in plain
// words, from its tool audit log (<data>/audit.jsonl). Looking around
// (screenshots, clicks, searches) isn't listed; outcomes are.
const fs = require("node:fs");

const short = (v, n = 60) => {
    const t = String(v ?? "")
        .replace(/\s+/g, " ")
        .trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const base = (p) =>
    short(
        String(p || "")
            .split("/")
            .filter(Boolean)
            .pop(),
        50,
    );

const PHRASES = {
    set_reminder: (a) => a.description && `Set a reminder: ${short(a.description)}`,
    schedule_task: (a) => a.description && `Scheduled: ${short(a.description)}`,
    whatsapp_send: (a) => `Sent a WhatsApp message${a.to ? ` to ${short(a.to, 30)}` : ""}`,
    email_send: (a) => `Emailed ${short(a.to, 40) || "someone"}${a.subject ? `: ${short(a.subject, 40)}` : ""}`,
    send_message_on_channel: (a) => `Sent a message on ${short(a.channel, 20) || "a channel"}`,
    send_file: (a) => `Sent ${base(a.file_path) || "a file"}`,
    spotify: (a) => a.action === "play" && a.query && `Played ${short(a.query, 50)} on Spotify`,
    music_control: (a) => a.action === "search_play" && a.query && `Played ${short(a.query, 50)}`,
    app_manager: (a) => {
        const app = short(a.app || a.app_name, 30);
        if (!app) return null;
        return a.action === "quit" || a.action === "force_quit"
            ? `Quit ${app}`
            : a.action === "activate"
              ? `Switched to ${app}`
              : null;
    },
    open_in_app: (a) =>
        a.target && `Opened ${base(a.target) || short(a.target, 40)}${a.app ? ` in ${short(a.app, 20)}` : ""}`,
    open_settings: (a) => a.pane && `Opened ${short(a.pane, 30)} settings`,
    calendar_tool: (a) => a.action === "create" && a.title && `Added to your calendar: ${short(a.title, 50)}`,
    write: (a) => a.file_path && `Saved ${base(a.file_path)}`,
    deep_research: (a) => a.topic && `Researched ${short(a.topic, 50)}`,
    set_volume: () => "Changed the volume",
    weather: (a) => `Checked the weather${a.location ? ` in ${short(a.location, 30)}` : ""}`,
};

/** One audit entry in plain words, or null when it isn't worth listing. */
function describe(entry) {
    if (!entry?.success || !PHRASES[entry.tool]) return null;
    const args = entry.args && typeof entry.args === "object" && !Array.isArray(entry.args) ? entry.args : {};
    return PHRASES[entry.tool](args) || null;
}

/** Today's outcomes, newest first, repeats folded: [{ ts, text }]. */
function doneToday(auditPath, now = new Date(), limit = 4) {
    let raw = "";
    try {
        const fd = fs.openSync(auditPath, "r");
        try {
            const size = fs.fstatSync(fd).size;
            const len = Math.min(size, 256 * 1024); // today's part is near the end
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, size - len);
            raw = buf.toString("utf-8");
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return [];
    }
    const today = now.toDateString();
    const out = [];
    for (const line of raw.split("\n").reverse()) {
        let e;
        try {
            e = JSON.parse(line);
        } catch {
            continue;
        }
        const ts = Date.parse(e.ts);
        if (!ts) continue;
        if (new Date(ts).toDateString() !== today) break;
        const text = describe(e);
        if (!text || out.some((o) => o.text === text)) continue;
        out.push({ ts, text });
        if (out.length >= limit) break;
    }
    return out;
}

module.exports = { describe, doneToday };
