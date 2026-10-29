// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Spotify OS Fallback Layer ─────────────────
// Cross-platform Spotify control that does NOT require Premium.
// The primary mechanism is launching a resolved spotify: URI (track/album/
// playlist/artist), which the locally-installed Spotify desktop app honors
// regardless of account tier. Secondary helpers (play/pause/next/prev/volume)
// drive the local app via AppleScript (mac), media keys (win), or playerctl (linux).

import { execFile, spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { promisify } from "node:util";
import { IS_LINUX, IS_MAC, IS_WIN, runPowerShellInline } from "./platform.js";

const execFileAsync = promisify(execFile);

// ── AppleScript helper (mac) ──────────────────

async function runAS(script: string, timeout = 10000): Promise<string> {
    const tmpFile = join(tmpdir(), `atlas_spotify_${Date.now()}.scpt`);
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

// ── Check if playerctl is available (linux) ───

let _playerctlChecked = false;
let _hasPlayerctl = false;

async function hasPlayerctl(): Promise<boolean> {
    if (_playerctlChecked) return _hasPlayerctl;
    _playerctlChecked = true;
    try {
        await execFileAsync("which", ["playerctl"], { timeout: 2000 });
        _hasPlayerctl = true;
    } catch {
        _hasPlayerctl = false;
    }
    return _hasPlayerctl;
}

function linuxMissingPlayerctlError(): Error {
    return new Error(
        "playerctl not installed. Install it with: apt install playerctl (Debian/Ubuntu), dnf install playerctl (Fedora), pacman -S playerctl (Arch).",
    );
}

// ── Ensure Spotify desktop is running ─────────

/**
 * Launch the local Spotify desktop app if not already running.
 * Returns true if the app was launched (or is already running).
 */
export async function ensureSpotifyAppRunning(): Promise<boolean> {
    try {
        if (IS_MAC) {
            await execFileAsync("open", ["-a", "Spotify"], { timeout: 5000 });
            return true;
        }
        if (IS_WIN) {
            try {
                await execFileAsync("cmd.exe", ["/c", "start", "", "spotify:"], { timeout: 5000 });
                return true;
            } catch {
                // cmd.exe start failed (spotify: protocol not registered) — try direct .exe paths
                const spotifyPaths = [
                    path.join(process.env.APPDATA ?? "", "Spotify", "Spotify.exe"),
                    path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps", "Spotify.exe"),
                    "C:\\Program Files\\Spotify\\Spotify.exe",
                    "C:\\Program Files (x86)\\Spotify\\Spotify.exe",
                ];
                for (const p of spotifyPaths) {
                    if (existsSync(p)) {
                        const child = spawn(p, [], { detached: true, stdio: "ignore" });
                        child.unref();
                        return true;
                    }
                }
                return false;
            }
        }
        if (IS_LINUX) {
            // Detach so we don't wait for the app lifetime
            execFile("bash", ["-c", "spotify >/dev/null 2>&1 &"], { timeout: 3000 }, () => {});
            return true;
        }
    } catch {
        return false;
    }
    return false;
}

// ── Launch a spotify: URI (the core Free-tier play mechanism) ──

// Spotify URIs and open.spotify.com links only use these characters. Anything
// else (& | ^ % " spaces) is rejected because Windows hands the URI to
// `cmd.exe /c start`, which would parse it as more commands. A share link's
// query (?si=…&pi=…) is tracking only, so it is dropped rather than rejected.
const SPOTIFY_URI_RE = /^(?:spotify:[A-Za-z0-9:._-]+|https:\/\/open\.spotify\.com\/[A-Za-z0-9/._-]*)$/;

export function checkedSpotifyUri(uri: string): string {
    const bare = uri.trim().split(/[?#]/)[0];
    if (!SPOTIFY_URI_RE.test(bare)) throw new Error(`Invalid Spotify URI: ${uri}`);
    return bare;
}

/**
 * Open a spotify: URI (spotify:track:ID, spotify:album:ID, spotify:playlist:ID, spotify:artist:ID).
 * The desktop app focuses and plays that exact item. Works on Free and Premium accounts.
 */
export async function osLaunchUri(uri: string): Promise<void> {
    uri = checkedSpotifyUri(uri);
    if (IS_MAC) {
        await execFileAsync("open", [uri], { timeout: 5000 });
        return;
    }
    if (IS_WIN) {
        // `start "" "spotify:..."` opens via default handler (Spotify desktop registers spotify:)
        await execFileAsync("cmd.exe", ["/c", "start", "", uri], { timeout: 5000 });
        return;
    }
    if (IS_LINUX) {
        await execFileAsync("xdg-open", [uri], { timeout: 5000 });
        return;
    }
    throw new Error("Unsupported platform for Spotify URI launch");
}

// On macOS, `open spotify:track:<id>` only reliably switches tracks when the
// Spotify app is cold-starting. Once the app is already running and playing,
// `open` silently no-ops — the app raises to foreground but playback doesn't
// change. AppleScript `play track` is the only reliable track-switch path
// on mac. Windows/Linux URI handlers do forward to the running instance, so
// `start`/`xdg-open` work there.
export async function osPlayTrackByUri(uri: string): Promise<void> {
    uri = checkedSpotifyUri(uri);
    if (IS_MAC) {
        const escaped = uri.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        await runAS(`tell application "Spotify" to play track "${escaped}"`);
        return;
    }
    if (IS_WIN) {
        await execFileAsync("cmd.exe", ["/c", "start", "", uri], { timeout: 5000 });
        return;
    }
    if (IS_LINUX) {
        await execFileAsync("xdg-open", [uri], { timeout: 5000 });
        if (await hasPlayerctl()) {
            await execFileAsync("playerctl", ["-p", "spotify", "play"], { timeout: 3000 }).catch(() => {});
        }
        return;
    }
    throw new Error("Unsupported platform for Spotify track play");
}

// ── Play / pause (toggle) ─────────────────────

export async function osPlayPause(): Promise<void> {
    if (IS_MAC) {
        await runAS('tell application "Spotify" to playpause');
        return;
    }
    if (IS_WIN) {
        // Virtual key code 0xB3 = VK_MEDIA_PLAY_PAUSE
        await runPowerShellInline(
            `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait([char]179)`,
            3000,
        );
        return;
    }
    if (IS_LINUX) {
        if (!(await hasPlayerctl())) throw linuxMissingPlayerctlError();
        await execFileAsync("playerctl", ["-p", "spotify", "play-pause"], { timeout: 3000 });
        return;
    }
}

export async function osPlay(): Promise<void> {
    if (IS_MAC) {
        await runAS('tell application "Spotify" to play');
        return;
    }
    if (IS_LINUX && (await hasPlayerctl())) {
        await execFileAsync("playerctl", ["-p", "spotify", "play"], { timeout: 3000 });
        return;
    }
    // Windows + Linux-without-playerctl fall back to toggle
    await osPlayPause();
}

export async function osPause(): Promise<void> {
    if (IS_MAC) {
        await runAS('tell application "Spotify" to pause');
        return;
    }
    if (IS_LINUX && (await hasPlayerctl())) {
        await execFileAsync("playerctl", ["-p", "spotify", "pause"], { timeout: 3000 });
        return;
    }
    await osPlayPause();
}

// ── Next / previous ───────────────────────────

export async function osNext(): Promise<void> {
    if (IS_MAC) {
        await runAS('tell application "Spotify" to next track');
        return;
    }
    if (IS_WIN) {
        await runPowerShellInline(
            `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait([char]176)`,
            3000,
        );
        return;
    }
    if (IS_LINUX) {
        if (!(await hasPlayerctl())) throw linuxMissingPlayerctlError();
        await execFileAsync("playerctl", ["-p", "spotify", "next"], { timeout: 3000 });
        return;
    }
}

export async function osPrev(): Promise<void> {
    if (IS_MAC) {
        await runAS('tell application "Spotify" to previous track');
        return;
    }
    if (IS_WIN) {
        await runPowerShellInline(
            `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait([char]177)`,
            3000,
        );
        return;
    }
    if (IS_LINUX) {
        if (!(await hasPlayerctl())) throw linuxMissingPlayerctlError();
        await execFileAsync("playerctl", ["-p", "spotify", "previous"], { timeout: 3000 });
        return;
    }
}

// ── Volume (0-100) ────────────────────────────

export async function osVolume(level: number): Promise<void> {
    const v = Math.max(0, Math.min(100, Math.round(level)));
    if (IS_MAC) {
        await runAS(`tell application "Spotify" to set sound volume to ${v}`);
        return;
    }
    if (IS_LINUX) {
        if (!(await hasPlayerctl())) throw linuxMissingPlayerctlError();
        // playerctl volume takes 0.0-1.0
        await execFileAsync("playerctl", ["-p", "spotify", "volume", (v / 100).toFixed(2)], {
            timeout: 3000,
        });
        return;
    }
    if (IS_WIN) {
        // Windows can't target Spotify's internal volume without an API; the Web API
        // volume endpoint is the clean path. For the OS fallback on Free + Windows we
        // simply can't adjust Spotify's volume independently of the system mixer, so
        // we no-op with a clear error the caller can surface.
        throw new Error(
            "Per-app volume control is unavailable on Windows via OS fallback. System-wide volume can be changed with the set_volume tool, or upgrade to Spotify Premium for in-app volume control.",
        );
    }
}

// ── Now-playing (local-only snapshot via AppleScript) ──

export interface LocalNowPlaying {
    playing: boolean;
    track?: string;
    artist?: string;
    album?: string;
    duration_ms?: number;
    position_ms?: number;
    track_uri?: string;
    source: "applescript" | "playerctl" | "unavailable";
}

export async function osNowPlayingLocal(): Promise<LocalNowPlaying> {
    if (IS_MAC) {
        try {
            // Single AppleScript call returns all fields, tab-delimited
            const script = `
tell application "Spotify"
    if it is running then
        set st to player state as string
        set n to name of current track
        set a to artist of current track
        set al to album of current track
        set d to duration of current track
        set p to player position
        set u to spotify url of current track
        return st & "\t" & n & "\t" & a & "\t" & al & "\t" & d & "\t" & p & "\t" & u
    else
        return "not_running"
    end if
end tell`;
            const out = await runAS(script);
            if (out === "not_running" || !out) {
                return { playing: false, source: "applescript" };
            }
            const [state, track, artist, album, dur, pos, uri] = out.split("\t");
            return {
                playing: state === "playing",
                track,
                artist,
                album,
                // Spotify reports duration in ms, position in seconds (float)
                duration_ms: Number(dur) || undefined,
                position_ms: Math.round(Number(pos) * 1000) || undefined,
                track_uri: uri,
                source: "applescript",
            };
        } catch {
            return { playing: false, source: "applescript" };
        }
    }
    if (IS_LINUX && (await hasPlayerctl())) {
        try {
            const { stdout } = await execFileAsync(
                "playerctl",
                [
                    "-p",
                    "spotify",
                    "metadata",
                    "--format",
                    "{{status}}\t{{title}}\t{{artist}}\t{{album}}\t{{mpris:length}}\t{{position}}\t{{mpris:trackid}}",
                ],
                { timeout: 3000 },
            );
            const [status, track, artist, album, dur, pos, uri] = stdout.trim().split("\t");
            return {
                playing: status === "Playing",
                track,
                artist,
                album,
                duration_ms: Math.round(Number(dur) / 1000) || undefined,
                position_ms: Math.round(Number(pos) / 1000) || undefined,
                track_uri: uri,
                source: "playerctl",
            };
        } catch {
            return { playing: false, source: "playerctl" };
        }
    }
    return { playing: false, source: "unavailable" };
}
