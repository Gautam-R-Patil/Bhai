// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Quick commands ─────────────────────────────
// Everyday computer commands ("set volume to 30, switch to light mode and open
// Bluetooth settings", "play Levitating on Spotify", "pause the music") run straight
// through their tools: no model call, so ~1s, no cost, and the same on any model.
// All or nothing: every clause must be one of these commands, checked before anything
// runs (the settings page resolves, the app exists); otherwise the turn goes to the
// model as before. Kill switch: ATLAS_NO_QUICK_COMMANDS=true.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface QuickStep {
    tool: string;
    args: Record<string, unknown>;
    /** What to tell the user when it worked (from the tool's result when it says more). */
    done: string | ((result: Record<string, unknown>) => string);
    /** No player named ("pause the music"): control whichever one is playing here. */
    pickPlayer?: boolean;
    /** Checked before anything runs: false sends the whole message to the model. */
    check?: () => Promise<boolean>;
}

const appExists = (app: string) => () =>
    process.platform !== "darwin"
        ? Promise.resolve(false)
        : execFileAsync("osascript", ["-e", `id of application "${app.replace(/["\\]/g, "")}"`], {
              timeout: 3000,
          }).then(
              () => true,
              () => false,
          );

// An app name: one to three words, never a thing inside an app ("the file I downloaded").
const APP = "([a-z0-9][a-z0-9.+-]*(?:\\s+[a-z0-9.+-]+){0,2}?)";
const isAppName = (s: string) =>
    !/\b(file|files|folder|document|doc|pdf|photo|image|website|site|page|tab|link|window|email|message|chat)\b/.test(
        s,
    );

/** Apple Music is the player in use here (checked without launching it). */
const appleMusicPlaying = () =>
    process.platform !== "darwin"
        ? Promise.resolve(false)
        : execFileAsync(
              "osascript",
              [
                  "-e",
                  'if application "Music" is running then tell application "Music" to return player state as string',
              ],
              { timeout: 3000 },
          ).then(
              (r) => r.stdout.trim() === "playing",
              () => false,
          );

/** "Now playing: …" from either player's now_playing result (Spotify local or spogo, Apple Music). */
function nowPlayingLine(r: Record<string, unknown>): string {
    const state = r.state as
        | { is_playing?: boolean; item?: { name?: string; artists?: { name?: string }[] } }
        | undefined;
    const track = (r.track as string) || state?.item?.name;
    const artist = (r.artist as string) || state?.item?.artists?.map((a) => a.name).join(", ");
    const playing = r.playing ?? state?.is_playing ?? !!track;
    return playing && track ? `Now playing: ${track}${artist ? ` – ${artist}` : ""}.` : "Nothing is playing right now.";
}

const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** One clause → its step, or null when it isn't a quick command. */
function parseClause(raw: string): QuickStep | null {
    const c = raw
        .toLowerCase()
        .replace(/^(please|pls|can you|could you|bhai|hey bhai|yo)[\s,]+/g, "")
        .replace(/[\s,]+(please|pls|for me|now|instead|too|also|as well)$/g, "")
        .replace(/[.!?]+$/, "")
        .trim();
    // The first of these patterns that matches the clause.
    const hit = (...patterns: RegExp[]) => {
        for (const p of patterns) {
            const found = p.exec(c);
            if (found) return found;
        }
        return null;
    };
    let m = hit(
        /^(?:set|change|turn|put)\s+(?:the\s+|my\s+)?(?:mac'?s?\s+)?volume\s+(?:to|at)\s+(\d{1,3})\s*(?:%|percent)?$/,
        /^volume\s+(?:to\s+)?(\d{1,3})\s*(?:%|percent)?$/,
    );
    if (m) {
        const level = Math.min(100, Number(m[1]));
        return { tool: "set_volume", args: { level }, done: `Volume is at ${level}%.` };
    }
    m = hit(/^(mute|unmute)(?:\s+(?:the\s+|my\s+)?(?:mac|sound|volume|audio))?$/);
    if (m) {
        const mute = m[1] === "mute";
        return { tool: "set_volume", args: { mute }, done: mute ? "Muted." : "Unmuted." };
    }
    m = hit(
        /^(?:switch|turn|change|set|go|put)\s+(?:my\s+mac\s+|the\s+mac\s+|it\s+)?(?:to|on|into)?\s*(dark|light)\s+mode(?:\s+on)?$/,
        /^(dark|light)\s+mode(?:\s+on)?$/,
    );
    if (m) {
        return { tool: "dark_mode", args: { mode: m[1] }, done: `${title(m[1])} mode is on.` };
    }
    m = hit(/^(?:turn|switch)\s+(on|off)\s+dark\s+mode$/);
    if (m) {
        const mode = m[1] === "on" ? "dark" : "light";
        return { tool: "dark_mode", args: { mode }, done: `${title(mode)} mode is on.` };
    }
    m = hit(/^(?:open|show(?:\s+me)?|go\s+to)\s+(?:the\s+|my\s+)?(.+?)\s+(?:settings|preferences|setting)$/);
    if (m) {
        const pane = m[1];
        return {
            tool: "open_settings",
            args: { pane },
            done: `${title(pane)} settings are open.`,
            check: async () =>
                process.platform !== "darwin" ||
                !!(await (await import("./tools/system-controls.js")).resolveSettingsUrl(pane)),
        };
    }
    m = hit(/^play\s+(.+?)\s+(?:on|in|using|with)\s+(spotify|apple\s+music)$/);
    if (m) {
        const query = m[1].replace(/^(the\s+)?(song|track)\s+/, "");
        return m[2] === "spotify"
            ? {
                  tool: "spotify",
                  args: { action: "play", query },
                  done: (r) => `Playing ${r.label || query} on Spotify.`,
              }
            : {
                  tool: "music_control",
                  args: { action: "search_play", query },
                  done: (r) =>
                      `Playing ${r.playlist ? `your ${r.playlist} playlist` : r.track ? `${r.track} – ${r.artist}` : query} on Apple Music.`,
              };
    }
    m = hit(
        /^(pause|resume|next|skip|previous)(?:\s+(?:the\s+)?(?:song|track|music|this\s+song))?(?:\s+(?:on|in)\s+(spotify|apple\s+music))?$/,
        /^(pause|resume)\s+(spotify|apple\s+music)$/,
    );
    if (m) {
        const action = { skip: "next" }[m[1]] ?? m[1];
        const done =
            {
                pause: "Paused.",
                resume: "Playing again.",
                next: "Skipped to the next song.",
                previous: "Back to the previous song.",
            }[action] ?? "Done.";
        // Apple Music only when named; Spotify handles the rest (its own local-app fallback).
        return m[2] && m[2] !== "spotify"
            ? { tool: "music_control", args: { action: action === "resume" ? "play" : action }, done }
            : { tool: "spotify", args: { action }, done, pickPlayer: !m[2] };
    }
    m = hit(
        /^(?:(?:and\s+)?tell\s+me\s+)?(?:what|which)(?:'s|\s+is)?\s+(?:song|track|music)?\s*(?:is\s+|'s\s+)?(?:playing|on)(?:\s+(?:on|in)\s+(spotify|apple\s+music))?(?:\s+(?:now|right\s+now))?$/,
        /^now\s+playing(?:\s+(?:on|in)\s+(spotify|apple\s+music))?$/,
    );
    if (m) {
        // A named player is asked directly; otherwise whichever one is playing here.
        return m[1] && m[1] !== "spotify"
            ? { tool: "music_control", args: { action: "now_playing" }, done: nowPlayingLine }
            : { tool: "spotify", args: { action: "now_playing" }, done: nowPlayingLine, pickPlayer: !m[1] };
    }
    // "Which apps can use my camera?": the privacy page that lists them.
    m = hit(
        /^(?:show\s+me\s+|tell\s+me\s+)?(?:which|what)\s+apps\s+(?:are\s+allowed\s+to|can|have\s+access\s+to|use)\s+(?:use\s+)?(?:my\s+|the\s+)?(camera|microphone|mic|location|contacts|photos|screen recording|full disk access)$/,
    );
    if (m) {
        const pane = m[1] === "mic" ? "microphone" : m[1];
        return {
            tool: "open_settings",
            args: { pane },
            done: (r) => `The ${r.page ?? title(pane)} page is open: it lists the apps allowed to use your ${pane}.`,
        };
    }
    // Disk and battery: one system_info call answers them.
    m = hit(
        /^(?:how\s+much|what'?s?\s+(?:is\s+)?(?:my|the))\s+(?:free\s+)?(?:disk\s+|storage\s+|hard\s+drive\s+)?(?:space|storage)(?:\s+(?:do\s+i\s+have|is\s+(?:left|free)|left|free))*(?:\s+(?:on|in)\s+(?:my\s+)?(?:mac|computer|laptop|disk))?$/,
    );
    if (m) {
        return {
            tool: "system_info",
            args: {},
            done: (r) => {
                const d = r.disk as { available?: string; total?: string } | undefined;
                return d?.available
                    ? `You have ${d.available}B free of ${d.total}B.`
                    : "I couldn't read the disk space.";
            },
        };
    }
    m = hit(
        /^(?:how\s+much\s+battery(?:\s+do\s+i\s+have|\s+is\s+left)?|(?:what'?s?\s+(?:is\s+)?)?(?:my\s+|the\s+)?battery(?:\s+level|\s+percentage)?)$/,
    );
    if (m) {
        return {
            tool: "system_info",
            args: {},
            done: (r) => {
                const b = r.battery as { percent?: number; state?: string } | undefined;
                return typeof b?.percent === "number"
                    ? `Battery is at ${b.percent}% (${b.state ?? "unknown"}).`
                    : "I couldn't read the battery.";
            },
        };
    }
    m = hit(/^lock\s+(?:my\s+|the\s+)?(?:screen|mac|computer|laptop)$/);
    if (m) {
        return { tool: "lock_screen", args: {}, done: "Locked." };
    }
    m = hit(new RegExp(`^(?:open|launch|start)\\s+(?:the\\s+)?${APP}(?:\\s+app)?$`));
    if (m && isAppName(m[1])) {
        const app = m[1];
        return {
            tool: "app_manager",
            args: { action: "activate", app },
            done: `${title(app)} is open.`,
            check: appExists(app),
        };
    }
    m = hit(new RegExp(`^(?:quit|close)\\s+(?:the\\s+)?${APP}(?:\\s+app)?$`));
    if (m && isAppName(m[1])) {
        const app = m[1];
        return {
            tool: "app_manager",
            args: { action: "quit", app },
            done: `${title(app)} is closed.`,
            check: appExists(app),
        };
    }
    return null;
}

/** The steps for a message made only of quick commands, else null. Nothing runs here. */
export function parseQuickCommand(message: string): QuickStep[] | null {
    const text = message.trim();
    if (!text || text.length > 200 || /\n/.test(text)) return null;
    // The whole message first: "play rock and roll on spotify" is one clause.
    const whole = parseClause(text);
    if (whole) return [whole];
    const clauses = text.split(/\s*(?:,|;|\bthen\b|\band\b|&)\s*/i).filter((s) => s && !/^(and|then)$/i.test(s));
    if (clauses.length < 2 || clauses.length > 5) return null;
    const steps = clauses.map(parseClause);
    return steps.every(Boolean) ? (steps as QuickStep[]) : null;
}

export interface QuickResult {
    /** The reply when every step worked. */
    reply?: string;
    /** When a step failed: what already ran, for the model to carry on from. */
    partial?: string;
}

/**
 * Run a quick command, or return null to let the model handle the message.
 * `exec` is executeTool (injected: tools/index imports this module's caller).
 */
export async function runQuickCommand(
    message: string,
    exec: (tool: string, args: Record<string, unknown>) => Promise<string>,
): Promise<QuickResult | null> {
    if (process.env.ATLAS_NO_QUICK_COMMANDS === "true") return null;
    const steps = parseQuickCommand(message);
    if (!steps) return null;
    for (const s of steps) if (s.check && !(await s.check().catch(() => false))) return null;

    const said: string[] = [];
    for (let s of steps) {
        if (s.pickPlayer && (await appleMusicPlaying())) {
            const action = s.args.action === "resume" ? "play" : s.args.action;
            s = { ...s, tool: "music_control", args: { action } };
        }
        const out = await exec(s.tool, s.args);
        let result: Record<string, unknown> = {};
        let ok = false;
        let error = "";
        try {
            result = JSON.parse(out) as Record<string, unknown>;
            ok = result.success !== false && !result.error;
            error = String(result.error ?? "");
        } catch {
            ok = true; // plain-text result
        }
        if (!ok) {
            return {
                partial: `[Already done for this message: ${said.join(" ") || "nothing"} The step ${s.tool}(${JSON.stringify(s.args)}) failed: ${error.slice(0, 200)}. Finish the rest of the request.]`,
            };
        }
        said.push(typeof s.done === "function" ? s.done(result) : s.done);
    }
    return { reply: said.join(" ") };
}
