// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Spotify (spogo CLI wrapper + OS fallback) ─
// Replaces the previous Web-API / PKCE-OAuth implementation.
//
// Why: Spotify's public Web API is effectively closed to new apps in 2026
// (Extended Quota Mode requires a registered business + 250K MAU + ~95%
// rejection rate; Development Mode caps apps at 5 authenticated users).
// Instead, this tool shells out to `spogo` (https://github.com/steipete/spogo),
// a Go CLI that talks to Spotify's *internal* web-player endpoints using
// browser-imported cookies. No Web API quota, no user cap, cross-platform.
//
// Auth: the user logs into Spotify in their regular browser once, then
// `spogo auth import --browser chrome` pulls the cookies. We run that
// automatically on the first auth-required failure.
//
// Fallback: when spogo is unavailable (not installed / not authed) we fall
// back to URI-launch + OS media key controls so the agent can still play
// music, just with less precision and fewer features.

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { getDataDir } from "../config/paths.js";
import type { ToolDefinition } from "./get-current-time.js";
import { IS_LINUX, IS_MAC, IS_WIN } from "./platform.js";
import { installSpogo, spogoBinaryPath } from "./spotify-installer.js";
import {
    ensureSpotifyAppRunning,
    osLaunchUri,
    osNext,
    osNowPlayingLocal,
    osPause,
    osPlay,
    osPlayTrackByUri,
    osPrev,
    osVolume,
} from "./spotify-os.js";
import { fastSearchTrack } from "./spotify-search.js";

const execFileAsync = promisify(execFile);

// ── Response helpers ──────────────────────────

function ok(data: Record<string, unknown>): string {
    return JSON.stringify({ success: true, ...data });
}
function fail(error: string, extra?: Record<string, unknown>): string {
    return JSON.stringify({ success: false, error, ...(extra || {}) });
}

// ── spogo detection ───────────────────────────

let _spogoChecked = false;
let _spogoPath: string | null = null;

async function findSpogo(): Promise<string | null> {
    if (_spogoChecked) return _spogoPath;
    _spogoChecked = true;
    // Atlas-managed install location is checked first so it takes precedence
    // over any stale system installs the user might have.
    const candidates: string[] = [spogoBinaryPath(), "spogo"];
    // Common install locations
    const home = process.env.HOME || "";
    if (IS_MAC) {
        candidates.push("/opt/homebrew/bin/spogo", "/usr/local/bin/spogo", `${home}/go/bin/spogo`);
    } else if (IS_LINUX) {
        candidates.push("/usr/local/bin/spogo", "/usr/bin/spogo", `${home}/go/bin/spogo`);
    } else if (IS_WIN) {
        const userProfile = process.env.USERPROFILE || "";
        candidates.push(`${userProfile}\\go\\bin\\spogo.exe`, "spogo.exe");
    }

    for (const cand of candidates) {
        try {
            // `spogo --version` is cheap and exits 0 if the binary exists
            const { stdout } = await execFileAsync(cand, ["--version"], { timeout: 3000 });
            if (stdout) {
                _spogoPath = cand;
                console.log(`🎵 spogo detected: ${cand.trim()} (${stdout.trim().split("\n")[0]})`);
                return cand;
            }
        } catch {
            /* try next */
        }
    }
    _spogoPath = null;
    return null;
}

function spogoInstallHelp(): string {
    if (IS_MAC) {
        return "Install spogo: brew install steipete/tap/spogo";
    }
    if (IS_LINUX || IS_WIN) {
        return "Install spogo: go install github.com/steipete/spogo/cmd/spogo@latest (requires Go 1.21+). After install, ensure ~/go/bin is on your PATH.";
    }
    return "Install spogo from https://github.com/steipete/spogo";
}

// ── spogo invocation ──────────────────────────

interface SpogoResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    /** Parsed JSON output if --json was used and parsing succeeded */
    json: unknown | null;
}

async function runSpogo(args: string[], opts: { timeout?: number; withJson?: boolean } = {}): Promise<SpogoResult> {
    const bin = await findSpogo();
    if (!bin) {
        return {
            exitCode: 127,
            stdout: "",
            stderr: `spogo not found. ${spogoInstallHelp()}`,
            json: null,
        };
    }

    const timeout = opts.timeout ?? 8_000;
    const finalArgs = opts.withJson === false ? args : [...args, "--json"];

    try {
        const { stdout, stderr } = await execFileAsync(bin, finalArgs, { timeout });
        let json: unknown | null = null;
        if (opts.withJson !== false && stdout.trim()) {
            try {
                json = JSON.parse(stdout);
            } catch {
                /* non-JSON output (e.g., play returning "OK") */
            }
        }
        return { exitCode: 0, stdout, stderr, json };
    } catch (err) {
        const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
        const exitCode = typeof e.code === "number" ? e.code : 1;
        return {
            exitCode,
            stdout: e.stdout || "",
            stderr: e.stderr || e.message || "",
            json: null,
        };
    }
}

// spogo exit codes (from docs/spec.md):
//  0 success
//  1 generic failure
//  2 invalid usage / validation
//  3 auth/cookies missing or invalid
//  4 network / timeouts

// ── Auth ─────────────────────────────────────

async function detectBrowser(): Promise<"chrome" | "safari" | "firefox" | "brave" | "edge"> {
    // Order by popularity. spogo supports chrome, safari, firefox, brave, edge.
    // On macOS, Safari is common; otherwise default to Chrome.
    const { existsSync } = await import("node:fs");
    if (IS_MAC) {
        if (existsSync("/Applications/Google Chrome.app")) return "chrome";
        if (existsSync("/Applications/Brave Browser.app")) return "brave";
        if (existsSync("/Applications/Microsoft Edge.app")) return "edge";
        if (existsSync("/Applications/Firefox.app")) return "firefox";
        if (existsSync("/Applications/Safari.app")) return "safari";
    }
    if (IS_WIN) {
        // Safari is not available on Windows — check in priority order
        const localAppData = process.env.LOCALAPPDATA ?? "";
        const programFilesX86 =
            process.env["PROGRAMFILES(X86)"] ?? process.env.PROGRAMFILES ?? "C:\\Program Files (x86)";
        if (existsSync(`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`)) return "chrome";
        if (existsSync(`${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`)) return "edge";
        if (existsSync(`${localAppData}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`)) return "brave";
        if (existsSync(`${programFilesX86}\\Mozilla Firefox\\firefox.exe`)) return "firefox";
        const programFiles64 = process.env.PROGRAMFILES ?? "C:\\Program Files";
        if (existsSync(`${programFiles64}\\Mozilla Firefox\\firefox.exe`)) return "firefox";
        // Default to chrome — most common on Windows
        return "chrome";
    }
    return "chrome";
}

async function spogoAuthImport(): Promise<{ ok: boolean; error?: string; browser: string }> {
    const browser = await detectBrowser();
    const res = await runSpogo(["auth", "import", "--browser", browser], { timeout: 15_000, withJson: false });
    if (res.exitCode === 0) return { ok: true, browser };
    return {
        ok: false,
        browser,
        error: res.stderr.trim() || res.stdout.trim() || `spogo auth import exited ${res.exitCode}`,
    };
}

async function spogoAuthStatus(): Promise<{ authed: boolean; detail?: unknown }> {
    const res = await runSpogo(["auth", "status"], { timeout: 5000 });
    if (res.exitCode !== 0) return { authed: false, detail: res.stderr || res.stdout };
    // Treat presence of successful JSON (or exit 0) as authed. Spogo returns
    // info like { status: "ok", user: {...} } when authed.
    if (res.json && typeof res.json === "object") {
        const obj = res.json as Record<string, unknown>;
        if (obj.status === "ok" || obj.user || obj.authenticated === true) {
            return { authed: true, detail: obj };
        }
    }
    // Some versions just exit 0 on success without structured output
    if (res.exitCode === 0) return { authed: true, detail: res.stdout };
    return { authed: false };
}

// Session-scoped auth cache. Short TTL because cookie expiry can happen silently;
// we re-verify after the TTL or on a forced failure.
let _authOkAt = 0;
const AUTH_CACHE_TTL_MS = 10 * 60 * 1000;

function invalidateAuthCache(): void {
    _authOkAt = 0;
}

/**
 * Ensure spogo is authed. On first missing-auth, attempt `auth import`. If that
 * fails, return a clear message the caller can surface to the user.
 * Cached for 10 minutes on success so "play X"/"play Y" calls in the same
 * session skip the ~5s auth-status subprocess.
 */
async function ensureAuth(): Promise<{ ok: boolean; error?: string; hint?: string }> {
    if (_authOkAt && Date.now() - _authOkAt < AUTH_CACHE_TTL_MS) {
        return { ok: true };
    }

    const status = await spogoAuthStatus();
    if (status.authed) {
        _authOkAt = Date.now();
        return { ok: true };
    }

    // Try to import cookies automatically
    const imported = await spogoAuthImport();
    if (imported.ok) {
        _authOkAt = Date.now();
        return { ok: true };
    }

    return {
        ok: false,
        error: `spogo auth required. ${imported.error || ""}`.trim(),
        hint: `Please log into Spotify at https://open.spotify.com in your browser (${imported.browser}), then try again. If that still fails, run manually: spogo auth import --browser ${imported.browser}. Supported browsers: chrome, brave, edge, firefox, safari.`,
    };
}

// Session-scoped "last played" fast-path. Repeats of the same query within
// the session skip the search roundtrip entirely.
interface LastPlayed {
    query: string;
    uri: string;
    label: string;
    at: number;
}
let _lastPlayed: LastPlayed | null = null;
const LAST_PLAYED_TTL_MS = 30 * 60 * 1000;

function matchesLastPlayed(query: string): LastPlayed | null {
    if (!_lastPlayed) return null;
    if (Date.now() - _lastPlayed.at > LAST_PLAYED_TTL_MS) return null;
    if (query.trim().toLowerCase() === _lastPlayed.query) return _lastPlayed;
    return null;
}

function rememberLastPlayed(query: string, uri: string, label: string): void {
    _lastPlayed = { query: query.trim().toLowerCase(), uri, label, at: Date.now() };
}

function forgetLastPlayed(): void {
    _lastPlayed = null;
}

/**
 * Reset Spotify session state (auth cache + last-played). Called when the
 * live voice session ends so a fresh session starts with a clean slate.
 */
export function resetSpotifySession(): void {
    _authOkAt = 0;
    _lastPlayed = null;
}

// Test-only accessors. Do NOT use these in production code paths.
export const _forTests = {
    matchesLastPlayed,
    rememberLastPlayed,
    forgetLastPlayed,
    invalidateAuthCache,
    getAuthOkAt: () => _authOkAt,
    setAuthOkAt: (t: number) => {
        _authOkAt = t;
    },
    getLastPlayed: () => _lastPlayed,
    authCacheTtlMs: () => AUTH_CACHE_TTL_MS,
    isLikedSongsQuery: (q: string) => isLikedSongsQuery(q),
    isSpogoUnsupportedError: (e: string) => isSpogoUnsupportedError(e),
    uriType: (u: string) => uriType(u),
    isContextType: (t: SpotifyUriType) => isContextType(t),
    likedSongsUri: () => LIKED_SONGS_URI,
};

// ── Invocation wrapper that maps exit codes to responses ──

// Guard so a single tool invocation tries the auto-install at most once.
let _autoInstallAttempted = false;

async function call(
    args: string[],
    opts: { timeout?: number; withJson?: boolean; allowOsFallback?: boolean } = {},
): Promise<
    { ok: true; data: unknown; stdout: string } | { ok: false; error: string; exitCode: number; hint?: string }
> {
    let res = await runSpogo(args, opts);

    if (res.exitCode === 127) {
        // Try to auto-install once — this is the key automation point for
        // non-technical Electron-app users who can't be expected to use a terminal.
        if (!_autoInstallAttempted) {
            _autoInstallAttempted = true;
            console.log("🎵 spogo not found — attempting auto-install from GitHub release");
            const result = await installSpogo();
            if (result.success) {
                // Reset detection cache so findSpogo picks up the new binary
                _spogoChecked = false;
                _spogoPath = null;
                res = await runSpogo(args, opts);
                if (res.exitCode !== 127) {
                    // Installed successfully, continue with normal handling below
                } else {
                    return {
                        ok: false,
                        error: "spogo was installed but still not detected — please restart the app.",
                        exitCode: 127,
                    };
                }
            } else {
                return {
                    ok: false,
                    error: `spogo is not installed and auto-install failed: ${result.error}. ${spogoInstallHelp()}`,
                    exitCode: 127,
                    hint: "Without spogo, the tool falls back to opening Spotify URIs on your local app (pause/next/prev/volume still work via OS media keys).",
                };
            }
        } else {
            return {
                ok: false,
                error: `spogo is not installed. ${spogoInstallHelp()}`,
                exitCode: 127,
                hint: "Without spogo, the tool falls back to opening Spotify URIs on your local app (pause/next/prev/volume still work via OS media keys).",
            };
        }
    }

    if (res.exitCode === 3) {
        // Auth missing — try to fix once and retry. Clear any stale cache first.
        invalidateAuthCache();
        const authed = await ensureAuth();
        if (!authed.ok) return { ok: false, error: authed.error || "auth failed", exitCode: 3, hint: authed.hint };
        const retry = await runSpogo(args, opts);
        if (retry.exitCode === 0) return { ok: true, data: retry.json, stdout: retry.stdout };
        return {
            ok: false,
            error: retry.stderr || retry.stdout || `spogo exited ${retry.exitCode}`,
            exitCode: retry.exitCode,
        };
    }

    if (res.exitCode !== 0) {
        return {
            ok: false,
            error: res.stderr.trim() || res.stdout.trim() || `spogo exited ${res.exitCode}`,
            exitCode: res.exitCode,
        };
    }

    return { ok: true, data: res.json, stdout: res.stdout };
}

// ── URI resolution helpers ────────────────────

// In-memory cache for resolved URIs — if the user asks for the same song twice
// in a session, skip the ~15s spogo search roundtrip entirely.
interface SearchCacheEntry {
    result: { uri: string; name?: string; artists?: string };
    at: number;
}
// What a query found ("levitating dua lipa" → its track) holds for weeks, and a search
// costs ~4s through spogo: keep the last 200 on disk, so the songs someone plays again
// start without searching, across restarts too.
const SEARCH_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const searchCacheFile = () => join(getDataDir(), "spotify-search-cache.json");
let _searchCacheLoaded: Map<string, SearchCacheEntry> | undefined;
function searchCache(): Map<string, SearchCacheEntry> {
    if (!_searchCacheLoaded) {
        _searchCacheLoaded = new Map();
        try {
            const saved = JSON.parse(readFileSync(searchCacheFile(), "utf8")) as [string, SearchCacheEntry][];
            for (const [k, v] of saved) if (v?.result?.uri) _searchCacheLoaded.set(k, v);
        } catch {
            /* none yet */
        }
    }
    return _searchCacheLoaded;
}

function writeSearchCache(cacheKey: string, result: { uri: string; name?: string; artists?: string }): void {
    const cache = searchCache();
    cache.set(cacheKey, { result, at: Date.now() });
    if (cache.size > 200) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) cache.delete(oldest[0]);
    }
    try {
        mkdirSync(getDataDir(), { recursive: true });
        writeFileSync(searchCacheFile(), JSON.stringify([...cache.entries()]));
    } catch {
        /* the in-memory cache still works */
    }
}

async function searchTop(
    type: "track" | "album" | "artist" | "playlist",
    query: string,
): Promise<{ uri: string; name?: string; artists?: string } | null> {
    const cacheKey = `${type}:${query.toLowerCase().trim()}`;
    const cached = searchCache().get(cacheKey);
    if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
        return cached.result;
    }

    // Fast path: Spotify public Web API via Client Credentials (~200ms).
    // Only for tracks — album/artist/playlist still go through spogo.
    if (type === "track") {
        const fast = await fastSearchTrack(query);
        if (fast) {
            const result = { uri: fast.uri, name: fast.name, artists: fast.artists };
            writeSearchCache(cacheKey, result);
            return result;
        }
    }

    // Fallback: spogo search (~15s). NOTE: spogo v0.2.0 has a bug where
    // `--limit 1` returns the wrong top result for many queries; `--limit 10`
    // returns the correctly-ranked list. Override the default 8s timeout so
    // cold non-track searches aren't truncated.
    const r = await call(["search", type, query, "--limit", "10"], { timeout: 15_000 });
    if (!r.ok || !r.data) return null;
    const d = r.data as Record<string, unknown>;
    const arr =
        (d[`${type}s`] as Array<Record<string, unknown>> | undefined) ||
        (d.items as Array<Record<string, unknown>> | undefined) ||
        (d.results as Array<Record<string, unknown>> | undefined);
    const first = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
    if (!first) return null;
    const idFromField = typeof first.id === "string" ? first.id : "";
    const uri =
        (typeof first.uri === "string" ? first.uri : "") || (idFromField ? `spotify:${type}:${idFromField}` : "");
    if (!uri) return null;
    const artists = Array.isArray(first.artists)
        ? (first.artists as Array<Record<string, unknown>>)
              .map((a) => a.name as string)
              .filter(Boolean)
              .join(", ")
        : undefined;
    const result = { uri, name: first.name as string | undefined, artists };
    writeSearchCache(cacheKey, result);
    return result;
}

// ── Action handlers ───────────────────────────

function normalizeSpotifyUri(u: string): string {
    const m = u.match(/^https:\/\/open\.spotify\.com\/([a-z]+)\/([^?/]+)/i);
    if (m) return `spotify:${m[1].toLowerCase()}:${m[2]}`;
    return u.split("?")[0];
}

async function readCurrentUri(): Promise<string> {
    const local = await osNowPlayingLocal();
    if (local.track_uri) return local.track_uri;
    const r = await runSpogo(["status"], { timeout: 3000 });
    if (r.exitCode === 0 && r.json && typeof r.json === "object") {
        const item = (r.json as Record<string, unknown>).item as Record<string, unknown> | undefined;
        if (item && typeof item.uri === "string") return item.uri;
    }
    return "";
}

async function readPlaybackSnapshot(): Promise<{ trackUri: string; contextUri: string; playing: boolean }> {
    const local = await osNowPlayingLocal();
    let trackUri = local.track_uri ?? "";
    let playing = local.playing === true;
    let contextUri = "";
    const r = await runSpogo(["status"], { timeout: 3000 });
    if (r.exitCode === 0 && r.json && typeof r.json === "object") {
        const obj = r.json as Record<string, unknown>;
        const item = obj.item as Record<string, unknown> | undefined;
        if (!trackUri && item && typeof item.uri === "string") trackUri = item.uri;
        if (typeof obj.is_playing === "boolean") playing = playing || obj.is_playing;
        const ctx = obj.context as Record<string, unknown> | undefined;
        if (ctx && typeof ctx.uri === "string") contextUri = ctx.uri;
    }
    return { trackUri, contextUri, playing };
}

type SpotifyUriType = "track" | "album" | "playlist" | "artist" | "show" | "episode" | "collection" | "unknown";

function uriType(uri: string): SpotifyUriType {
    const m = uri.match(/^spotify:([a-z]+):/i);
    if (!m) return "unknown";
    const t = m[1].toLowerCase();
    if (t === "track" || t === "album" || t === "playlist" || t === "artist" || t === "show" || t === "episode")
        return t;
    if (t === "collection") return "collection";
    return "unknown";
}

// A "context" is a container URI that plays a list of tracks (as opposed to
// a single track/show/episode). verifyPlayback's context-aware branch and
// doPlay's OS-fixup routing both depend on this being the same predicate —
// divergence between the two would silently break verification.
const CONTEXT_URI_TYPES: ReadonlySet<SpotifyUriType> = new Set(["playlist", "album", "artist", "collection"]);

function isContextType(t: SpotifyUriType): boolean {
    return CONTEXT_URI_TYPES.has(t);
}

// spogo's Connect engine sometimes returns {"status":"ok"} for `play <uri>`
// without actually switching the active device's track. For context URIs
// (playlist/album/artist/collection) the track URI will never equal the
// target, so compare status.context.uri, or fall back to "track changed
// since pre-play snapshot" — which avoids false-positives when something
// was already playing.
async function verifyPlayback(
    targetUri: string,
    timeoutMs = 2500,
    prePlaySnapshot?: { trackUri: string; contextUri: string },
): Promise<boolean> {
    const target = normalizeSpotifyUri(targetUri);
    const isContext = isContextType(uriType(target));
    const pre = prePlaySnapshot;
    const deadline = Date.now() + timeoutMs;
    await new Promise((r) => setTimeout(r, 200));
    while (Date.now() < deadline) {
        if (isContext) {
            const snap = await readPlaybackSnapshot();
            if (snap.contextUri && normalizeSpotifyUri(snap.contextUri) === target) return true;
            // Fallback: without a context.uri, consider it switched only if
            // playback is live AND the track actually changed from pre-play.
            if (pre && snap.playing && snap.trackUri && snap.trackUri !== pre.trackUri) return true;
        } else {
            const cur = await readCurrentUri();
            if (cur && normalizeSpotifyUri(cur) === target) return true;
        }
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 300));
    }
    return false;
}

// spogo's connect engine rejects spotify:collection:tracks, but the desktop
// Spotify app accepts it via the OS URI handler. Route "liked songs"
// phrasings around spogo. Anchored to avoid matching "liked songs by X" or
// "my favorites of 2024", which are real tracks/playlists the user meant.
const LIKED_QUERY_RE =
    /^\s*(play\s+)?(my\s+)?(liked (songs?|tracks?|music|playlist)|saved (songs?|tracks?)|favou?rites?)\s*$/i;

function isLikedSongsQuery(query: string): boolean {
    return LIKED_QUERY_RE.test(query.trim());
}

const LIKED_SONGS_URI = "spotify:collection:tracks";

async function playLikedSongs(query: string, shuffle: boolean): Promise<string> {
    try {
        await ensureSpotifyAppRunning();
        await osLaunchUri(LIKED_SONGS_URI);
        let shuffleApplied = shuffle;
        let shuffleError: string | undefined;
        if (shuffle) {
            // spogo needs a live Connect device to toggle shuffle. Poll up to ~2s
            // for the desktop app to start playing before issuing the command —
            // otherwise it either errors or targets a stale device.
            const deadline = Date.now() + 2000;
            while (Date.now() < deadline) {
                const snap = await readPlaybackSnapshot();
                if (snap.playing) break;
                await new Promise((r) => setTimeout(r, 200));
            }
            const sr = await call(["shuffle", "on"]);
            if (!sr.ok) {
                shuffleApplied = false;
                shuffleError = sr.error;
            }
        }
        rememberLastPlayed(query || "liked songs", LIKED_SONGS_URI, "Liked Songs");
        return ok({
            action: "play",
            mode: "os_launch_uri",
            uri: LIKED_SONGS_URI,
            label: "Liked Songs",
            shuffle: shuffleApplied,
            ...(shuffleError ? { shuffle_error: shuffleError } : {}),
            note: "Liked Songs launched via OS URI handler (spogo's connect engine can't play it directly).",
        });
    } catch (err) {
        return fail(`Could not play Liked Songs: ${(err as Error).message}`, {
            hint: "Make sure Spotify desktop is installed.",
        });
    }
}

async function doPlay(input: Record<string, unknown>): Promise<string> {
    const rawUri = (input.uri as string) || (input.context_uri as string) || "";
    const query = (input.query as string) || "";
    const shuffle = Boolean(input.shuffle);

    // Liked Songs fast-path — bypass spogo entirely. Both natural-language
    // queries ("liked songs") and the explicit URI spogo can't handle
    // (spotify:collection:tracks) route here. The desktop app plays it via
    // the OS URI handler.
    if (!rawUri && query && isLikedSongsQuery(query)) {
        return await playLikedSongs(query, shuffle);
    }
    if (rawUri && normalizeSpotifyUri(rawUri) === LIKED_SONGS_URI) {
        // Don't pass the caller's `query` through — it may describe a
        // different intent and would poison the last-played cache.
        return await playLikedSongs("liked songs", shuffle);
    }

    // Kick off a Spotify-app wakeup in parallel — on the common "play X" path we'll
    // need an active device anyway. Running it concurrently with the ~15s spogo search
    // cuts ~3s off the perceived latency when the app wasn't already running.
    const appWakeup = rawUri || query ? ensureSpotifyAppRunning().catch(() => false) : Promise.resolve(true);

    // Resolve URI if only a query was given
    let targetUri = rawUri;
    let label = "";

    // Fast path: repeat of a query we played recently in this session skips search.
    if (!targetUri && query) {
        const hit = matchesLastPlayed(query);
        if (hit) {
            targetUri = hit.uri;
            label = hit.label;
        }
    }

    if (!targetUri && query) {
        // Heuristic: infer type from wording
        const lower = query.toLowerCase();
        const type: "track" | "album" | "playlist" | "artist" = /\bplaylist\b/.test(lower)
            ? "playlist"
            : /\balbum\b/.test(lower)
              ? "album"
              : /\bartist\b/.test(lower)
                ? "artist"
                : "track";
        const cleaned = query.replace(/\b(playlist|album|artist|track|song)\b/gi, "").trim() || query;
        const resolved = await searchTop(type, cleaned);
        if (resolved) {
            targetUri = resolved.uri;
            label = `${resolved.name ?? ""}${resolved.artists ? ` – ${resolved.artists}` : ""}`.trim();
        }
    }

    // Wait for the wakeup to complete before trying spogo play (so it has a device
    // to target). This is a no-op if Spotify was already running.
    await appWakeup;

    if (!targetUri && !query) {
        // Plain "resume"
        const r = await call(["play"]);
        if (!r.ok) return await fallbackResume(r.error);
        return ok({ action: "resume", mode: "spogo" });
    }

    if (!targetUri) {
        return fail(`Couldn't resolve a Spotify URI for "${query}".`);
    }

    const isContext = isContextType(uriType(normalizeSpotifyUri(targetUri)));

    // A track on this Mac: tell the desktop app directly (~100ms) and confirm from it,
    // instead of spogo's round trip through Spotify's servers (~6s). Anything that
    // doesn't confirm (another device, a relinked track id) goes the spogo way below.
    if (IS_MAC && !isContext && uriType(normalizeSpotifyUri(targetUri)) === "track") {
        try {
            await osPlayTrackByUri(targetUri);
            const want = normalizeSpotifyUri(targetUri);
            for (let i = 0; i < 12; i++) {
                await new Promise((r) => setTimeout(r, 150));
                const now = await osNowPlayingLocal();
                if (now.playing && now.track_uri && normalizeSpotifyUri(now.track_uri) === want) {
                    if (query) rememberLastPlayed(query, targetUri, label);
                    return ok({ action: "play", mode: "local_app", uri: targetUri, label: label || undefined });
                }
            }
        } catch {
            /* fall through to spogo */
        }
    }

    // Pre-play snapshot lets verifyPlayback distinguish "already playing
    // something" from "new context started" when status.context.uri is absent.
    const preSnap = isContext
        ? await readPlaybackSnapshot().catch(() => ({ trackUri: "", contextUri: "", playing: false }))
        : undefined;

    // Try spogo first
    const playArgs = ["play", targetUri];
    if (shuffle) playArgs.push("--shuffle");
    const r = await call(playArgs);
    if (r.ok) {
        if (await verifyPlayback(targetUri, 2500, preSnap)) {
            if (query) rememberLastPlayed(query, targetUri, label);
            return ok({ action: "play", mode: "spogo", uri: targetUri, label: label || undefined });
        }
        try {
            await ensureSpotifyAppRunning();
            if (isContext) {
                // AppleScript `play track` rejects playlist/album/artist/collection URIs —
                // they have to go through the OS URI handler, which forwards to the
                // running Spotify app.
                await osLaunchUri(targetUri);
            } else {
                await osPlayTrackByUri(targetUri);
            }
            if (query) rememberLastPlayed(query, targetUri, label);
            const reVerified = await verifyPlayback(targetUri, 2500, preSnap);
            return ok({
                action: "play",
                mode: reVerified ? "os_fixup" : "os_fixup_unverified",
                uri: targetUri,
                label: label || undefined,
                note: reVerified
                    ? "spogo reported success but playback didn't switch; corrected via local app control."
                    : "spogo reported success but playback didn't switch; dispatched local play command — verification timed out.",
            });
        } catch (osErr) {
            return fail(
                `spogo accepted the play command but playback didn't switch, and local fixup failed: ${
                    (osErr as Error).message
                }`,
                { uri: targetUri, label: label || undefined },
            );
        }
    }

    // Fall back to OS URI launch (works on Free + Premium; the desktop app handles licensing,
    // and launching the URI also wakes the Spotify app if no device is currently active).
    try {
        await ensureSpotifyAppRunning();
        await osLaunchUri(targetUri);
        const isNoDevice = /missing device|no.?active.?device|no device/i.test(r.error);
        const isNotInstalled = r.exitCode === 127;
        const note = isNoDevice
            ? "No active Spotify device — woke the local app via URI launch. Playback will start once the app finishes loading."
            : isNotInstalled
              ? `spogo not installed; used OS URI launch. ${spogoInstallHelp()}`
              : `spogo error (${r.error}); used OS URI launch.`;
        if (query) rememberLastPlayed(query, targetUri, label);
        return ok({
            action: "play",
            mode: "os_launch_uri",
            uri: targetUri,
            label: label || undefined,
            note,
        });
    } catch (osErr) {
        return fail(`Both spogo and OS launch failed. spogo: ${r.error} | OS: ${(osErr as Error).message}`, {
            hint: r.exitCode === 127 ? spogoInstallHelp() : undefined,
        });
    }
}

async function fallbackResume(err: string): Promise<string> {
    try {
        await osPlay();
        return ok({ action: "resume", mode: "os_fallback", note: `spogo failed (${err}); resumed via OS.` });
    } catch (e) {
        return fail(`Could not resume: ${(e as Error).message} (spogo: ${err})`);
    }
}

async function doSimple(
    kind: "pause" | "resume" | "next" | "previous" | "seek" | "volume" | "shuffle" | "repeat",
    input: Record<string, unknown>,
): Promise<string> {
    // Transport changes invalidate the "last played" shortcut — the user's
    // intent is no longer bound to that specific track.
    if (kind === "pause" || kind === "next" || kind === "previous") {
        forgetLastPlayed();
        // The desktop app playing here takes these in ~100ms; spogo goes through Spotify's servers (~2s).
        if ((await osNowPlayingLocal()).playing) {
            try {
                await (kind === "pause" ? osPause() : kind === "next" ? osNext() : osPrev());
                return ok({ action: kind, mode: "local_app" });
            } catch {
                /* fall through to spogo */
            }
        }
    }
    let args: string[];
    switch (kind) {
        case "pause":
            args = ["pause"];
            break;
        case "resume":
            args = ["play"];
            break;
        case "next":
            args = ["next"];
            break;
        case "previous":
            args = ["prev"];
            break;
        case "seek": {
            const ms = Number(input.position_ms);
            if (!Number.isFinite(ms) || ms < 0) return fail("position_ms must be a non-negative number");
            // spogo seek takes seconds (spec: `seek <position>`). Convert ms → s.
            args = ["seek", String(Math.round(ms / 1000))];
            break;
        }
        case "volume": {
            const level = Number(input.level);
            if (!Number.isFinite(level)) return fail("level must be 0-100");
            args = ["volume", String(Math.max(0, Math.min(100, Math.round(level))))];
            break;
        }
        case "shuffle": {
            const on = Boolean(input.enabled);
            args = ["shuffle", on ? "on" : "off"];
            break;
        }
        case "repeat": {
            const mode = (input.mode as string) || "off";
            if (!["off", "context", "track"].includes(mode))
                return fail("repeat mode must be 'off' | 'context' | 'track'");
            args = ["repeat", mode];
            break;
        }
    }

    const r = await call(args);
    if (r.ok) return ok({ action: kind, mode: "spogo" });

    // OS fallback for the simple transport controls
    try {
        switch (kind) {
            case "pause":
                await osPause();
                return ok({ action: "pause", mode: "os_fallback" });
            case "resume":
                await osPlay();
                return ok({ action: "resume", mode: "os_fallback" });
            case "next":
                await osNext();
                return ok({ action: "next", mode: "os_fallback" });
            case "previous":
                await osPrev();
                return ok({ action: "previous", mode: "os_fallback" });
            case "volume": {
                const level = Number(input.level);
                if (Number.isFinite(level)) {
                    await osVolume(level);
                    return ok({ action: "volume", mode: "os_fallback", level: Math.round(level) });
                }
                break;
            }
            case "seek":
            case "shuffle":
            case "repeat":
                return fail(`${kind} requires spogo. ${r.exitCode === 127 ? spogoInstallHelp() : r.error}`);
        }
    } catch (e) {
        return fail(`Both spogo and OS fallback failed: ${(e as Error).message} (spogo: ${r.error})`);
    }
    return fail(r.error);
}

async function doSearch(input: Record<string, unknown>): Promise<string> {
    const query = (input.query as string) || "";
    if (!query) return fail("Provide 'query'");
    const types = ((input.types as string[]) || ["track"]).filter((t) =>
        ["track", "album", "artist", "playlist", "show", "episode"].includes(t),
    );
    const limit = Math.min(20, Math.max(1, Number(input.limit) || 5));

    const out: Record<string, unknown> = { query };
    for (const type of types) {
        // Spogo search has no fast-path for album/artist/playlist/show/episode
        // and can legitimately run ~12-15s. Use a wider timeout than the
        // default 8s so real searches aren't cut short. (Track searches hit
        // the Web-API fast-path in searchTop() so they don't pay this cost.)
        const r = await call(["search", type, query, "--limit", String(limit)], { timeout: 15_000 });
        if (r.ok && r.data) {
            // pass through whatever spogo returned (may be {tracks:[...]} etc)
            Object.assign(out, r.data as Record<string, unknown>);
        } else if (!r.ok) {
            out[`${type}_error`] = r.error;
        }
    }
    return ok(out);
}

async function doQueue(action: "queue_add" | "queue_get", input: Record<string, unknown>): Promise<string> {
    if (action === "queue_add") {
        let uri = (input.uri as string) || "";
        const query = (input.query as string) || "";
        if (!uri && query) {
            const resolved = await searchTop("track", query);
            if (!resolved) return fail(`No track for "${query}"`);
            uri = resolved.uri;
        }
        if (!uri) return fail("Provide 'uri' or 'query'");
        const r = await call(["queue", "add", uri]);
        return r.ok ? ok({ action, uri }) : fail(r.error);
    }
    // queue_get
    const r = await call(["queue", "show"]);
    if (r.ok) return ok({ action, queue: r.data });
    return fail(r.error);
}

async function doStatus(which: "now_playing" | "playback_state"): Promise<string> {
    // spogo asks Spotify's servers (~7s); the desktop app answers in ms. When this
    // Mac's app is the one playing, it is the answer; otherwise wait for spogo
    // (another device may be playing).
    const status = call(["status"]).catch((e: Error) => ({ ok: false as const, error: e.message, exitCode: 1 }));
    const local = which === "now_playing" ? await osNowPlayingLocal() : undefined;
    if (local?.playing && local.track) {
        return ok({
            action: which,
            mode: "local_app",
            playing: true,
            track: local.track,
            artist: local.artist,
            album: local.album,
            position_ms: local.position_ms,
            duration_ms: local.duration_ms,
            uri: local.track_uri,
        });
    }
    const r = await status;
    if (r.ok) return ok({ action: which, mode: "spogo", state: r.data });
    // OS fallback for now_playing only
    if (local) {
        if (local.track) {
            return ok({
                action: which,
                mode: "os_fallback",
                playing: local.playing,
                track: local.track,
                artist: local.artist,
                album: local.album,
                position_ms: local.position_ms,
                duration_ms: local.duration_ms,
                uri: local.track_uri,
            });
        }
    }
    return fail(r.error);
}

async function doDevices(action: "devices_list" | "transfer", input: Record<string, unknown>): Promise<string> {
    if (action === "devices_list") {
        const r = await call(["device", "list"]);
        return r.ok ? ok({ action, devices: r.data }) : fail(r.error);
    }
    // transfer
    const name = (input.device_id as string) || (input.name as string) || "";
    if (!name) return fail("Provide 'device_id' (or 'name')");
    const r = await call(["device", "set", name]);
    return r.ok ? ok({ action, device: name }) : fail(r.error);
}

function isSpogoUnsupportedError(err: string): boolean {
    return /unsupported operation|not supported in connect engine/i.test(err);
}

async function doLibrary(
    action: "saved_tracks" | "followed_artists" | "save_track" | "unsave_track" | "follow_artist" | "unfollow_artist",
    input: Record<string, unknown>,
): Promise<string> {
    if (action === "saved_tracks") {
        const r = await call(["library", "tracks", "list"]);
        if (r.ok) return ok({ action, items: r.data });
        if (isSpogoUnsupportedError(r.error)) {
            return ok({
                action,
                items: [],
                unsupported: true,
                note: "spogo's connect engine can't list Liked Songs, but the desktop app can play them. Call action='play' with query='liked songs' (or uri='spotify:collection:tracks') to start playback.",
                play_uri: LIKED_SONGS_URI,
            });
        }
        return fail(r.error);
    }
    if (action === "followed_artists") {
        const r = await call(["library", "artists", "list"]);
        return r.ok ? ok({ action, items: r.data }) : fail(r.error);
    }

    // Write operations — all take one or more Spotify IDs
    const ids = (input.ids as string[]) || (typeof input.id === "string" ? [input.id] : []);
    if (ids.length === 0) return fail("Provide 'id' or 'ids' (array of Spotify track/artist IDs).");

    if (action === "save_track") {
        const r = await call(["library", "tracks", "add", ...ids]);
        return r.ok ? ok({ action, ids }) : fail(r.error);
    }
    if (action === "unsave_track") {
        const r = await call(["library", "tracks", "remove", ...ids]);
        return r.ok ? ok({ action, ids }) : fail(r.error);
    }
    if (action === "follow_artist") {
        const r = await call(["library", "artists", "follow", ...ids]);
        return r.ok ? ok({ action, ids }) : fail(r.error);
    }
    if (action === "unfollow_artist") {
        const r = await call(["library", "artists", "unfollow", ...ids]);
        return r.ok ? ok({ action, ids }) : fail(r.error);
    }
    return fail(`Unknown library action: ${action}`);
}

async function doPlaylists(action: string, input: Record<string, unknown>): Promise<string> {
    if (action === "playlists_list") {
        const r = await call(["library", "playlists", "list"]);
        if (r.ok) return ok({ action, playlists: r.data });
        if (isSpogoUnsupportedError(r.error)) {
            return ok({
                action,
                playlists: [],
                unsupported: true,
                note: "spogo's connect engine can't list the user's playlists. To play a specific playlist, use action='search' with types=['playlist'] to find it by name, then action='play' with the returned uri. For Liked Songs use query='liked songs'.",
            });
        }
        return fail(r.error);
    }
    if (action === "playlist_create") {
        const name = (input.name as string) || "";
        if (!name) return fail("Provide 'name'");
        const r = await call(["playlist", "create", name]);
        return r.ok ? ok({ action, playlist: r.data }) : fail(r.error);
    }
    if (action === "playlist_tracks") {
        const id = (input.id as string) || "";
        if (!id) return fail("Provide 'id'");
        const r = await call(["playlist", "tracks", id]);
        if (r.ok) return ok({ action, id, tracks: r.data });
        if (isSpogoUnsupportedError(r.error)) {
            return ok({
                action,
                id,
                tracks: [],
                unsupported: true,
                note: `spogo's connect engine can't list playlist tracks. Use action='play' with uri='spotify:playlist:${id}' to just play the playlist directly.`,
                play_uri: `spotify:playlist:${id}`,
            });
        }
        return fail(r.error);
    }
    if (action === "playlist_add_tracks" || action === "playlist_remove_tracks") {
        const id = (input.id as string) || "";
        const uris = (input.uris as string[]) || [];
        if (!id || !uris.length) return fail("Provide 'id' and 'uris' (array)");
        const verb = action === "playlist_add_tracks" ? "add" : "remove";
        const errors: string[] = [];
        for (const uri of uris) {
            const r = await call(["playlist", verb, id, uri]);
            if (!r.ok) errors.push(`${uri}: ${r.error}`);
        }
        if (errors.length) return fail(`Some items failed: ${errors.join("; ")}`);
        return ok({ action, id, uris });
    }
    return fail(`Unknown playlists action: ${action}`);
}

// ── Tool definition ───────────────────────────

export const spotifyTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "spotify",
            description:
                "Full Spotify control via the `spogo` CLI (https://github.com/steipete/spogo), no Web API. macOS/Windows/Linux, Free + Premium. Actions: play, pause, resume, next, previous, seek, volume, shuffle, repeat, search, queue_add, queue_get, now_playing, playback_state, devices_list, transfer, saved_tracks, followed_artists, playlists_list, playlist_create, playlist_tracks, playlist_add_tracks, playlist_remove_tracks, auth_import, auth_status. PLAYBACK: play a track with query='song name'; play a playlist with uri='spotify:playlist:<id>' or query='<name> playlist' (use action='search' types=['playlist'] to find the id); play Liked Songs with query='liked songs'. Listing saved_tracks / playlists_list isn't supported by spogo's connect engine, but playing them is. First-time setup auto-imports Spotify cookies from the user's browser (Chrome/Brave/Edge/Firefox/Safari — must be logged into open.spotify.com). If spogo isn't installed, falls back to URI-launch + OS media keys.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: [
                            "play",
                            "pause",
                            "resume",
                            "next",
                            "previous",
                            "seek",
                            "volume",
                            "shuffle",
                            "repeat",
                            "search",
                            "queue_add",
                            "queue_get",
                            "now_playing",
                            "playback_state",
                            "devices_list",
                            "transfer",
                            "saved_tracks",
                            "followed_artists",
                            "save_track",
                            "unsave_track",
                            "follow_artist",
                            "unfollow_artist",
                            "playlists_list",
                            "playlist_create",
                            "playlist_tracks",
                            "playlist_add_tracks",
                            "playlist_remove_tracks",
                            "auth_import",
                            "auth_status",
                            "install",
                        ],
                        description: "The Spotify action to perform.",
                    },
                    query: {
                        type: "string",
                        description: "Natural-language search query (for 'play', 'search', 'queue_add').",
                    },
                    uri: {
                        type: "string",
                        description: "A Spotify URI (e.g. 'spotify:track:<id>'). Alternative to 'query'.",
                    },
                    context_uri: {
                        type: "string",
                        description: "Context URI (album/playlist/artist) to play from. Alternative to 'uri'.",
                    },
                    id: { type: "string", description: "A Spotify ID (track/playlist) for library/playlist actions." },
                    uris: {
                        type: "array",
                        items: { type: "string" },
                        description: "Track URIs for playlist_add_tracks / playlist_remove_tracks.",
                    },
                    device_id: { type: "string", description: "Target device id or name (for 'transfer')." },
                    name: {
                        type: "string",
                        description: "Playlist name (for 'playlist_create') or device name (for 'transfer').",
                    },
                    position_ms: { type: "number", description: "Seek position in milliseconds." },
                    level: { type: "number", description: "Volume 0-100." },
                    enabled: { type: "boolean", description: "For 'shuffle': true/false." },
                    mode: { type: "string", enum: ["off", "context", "track"], description: "For 'repeat'." },
                    types: {
                        type: "array",
                        items: { type: "string", enum: ["track", "album", "artist", "playlist", "show", "episode"] },
                        description: "Search result types. Defaults to ['track'].",
                    },
                    limit: { type: "number", description: "Result limit for search (default 5, max 20)." },
                    shuffle: { type: "boolean", description: "For 'play': start in shuffle mode." },
                    force: {
                        type: "boolean",
                        description: "For 'install': force re-download even if already installed.",
                    },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        const action = (input.action as string) || "";

        try {
            switch (action) {
                case "install": {
                    const force = Boolean(input.force);
                    const result = await installSpogo({ force });
                    if (result.success) {
                        // Reset the detection cache so subsequent calls pick up the fresh binary
                        _spogoChecked = false;
                        _spogoPath = null;
                        return ok({ action, binaryPath: result.binaryPath, version: result.version });
                    }
                    return fail(result.error || "install failed");
                }
                case "auth_status": {
                    const s = await spogoAuthStatus();
                    return ok({ action, authed: s.authed, detail: s.detail });
                }
                case "auth_import": {
                    const r = await spogoAuthImport();
                    if (r.ok)
                        return ok({
                            action,
                            browser: r.browser,
                            message: "Cookies imported from browser. You can now play music.",
                        });
                    return fail(r.error || "auth import failed", {
                        browser: r.browser,
                        hint: `Make sure you're logged into https://open.spotify.com in ${r.browser}. Supported browsers: chrome, brave, edge, firefox, safari.`,
                    });
                }
                case "play":
                    return await doPlay(input);
                case "pause":
                case "resume":
                case "next":
                case "previous":
                case "seek":
                case "volume":
                case "shuffle":
                case "repeat":
                    return await doSimple(action, input);
                case "search":
                    return await doSearch(input);
                case "queue_add":
                case "queue_get":
                    return await doQueue(action, input);
                case "now_playing":
                case "playback_state":
                    return await doStatus(action);
                case "devices_list":
                case "transfer":
                    return await doDevices(action, input);
                case "saved_tracks":
                case "followed_artists":
                case "save_track":
                case "unsave_track":
                case "follow_artist":
                case "unfollow_artist":
                    return await doLibrary(action, input);
                case "playlists_list":
                case "playlist_create":
                case "playlist_tracks":
                case "playlist_add_tracks":
                case "playlist_remove_tracks":
                    return await doPlaylists(action, input);
                default:
                    return fail(`Unknown action: ${action}`);
            }
        } catch (err) {
            return fail(`Spotify action failed: ${(err as Error).message}`);
        }
    },
};

// ── Boot helper ───────────────────────────────

export async function initSpotify(): Promise<void> {
    let bin = await findSpogo();
    if (!bin) {
        // Auto-install in the background on first boot — critical for
        // non-technical Electron-app users. This runs without blocking boot;
        // any user request for Spotify control before this finishes will
        // auto-install inline anyway.
        console.log("🎵 Spotify: spogo not found, auto-installing in background…");
        const result = await installSpogo();
        if (result.success) {
            _spogoChecked = false;
            _spogoPath = null;
            bin = await findSpogo();
        } else {
            console.warn(
                `🎵 Spotify: auto-install failed (${result.error}). Will retry on first use. Fallback: URI launch + OS media keys.`,
            );
            return;
        }
    }

    if (!bin) {
        console.warn("🎵 Spotify: spogo install succeeded but binary still not detected.");
        return;
    }

    const status = await spogoAuthStatus();
    if (status.authed) {
        console.log("🎵 Spotify ready via spogo (authed)");
    } else {
        console.log(
            "🎵 Spotify: spogo installed but not authed. Will auto-import cookies on first use (make sure you're logged into open.spotify.com in your browser).",
        );
    }
}
