// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Tool Intelligence Layer ───────────────────
// Wraps tool execution with: result caching, audit logging, and rate limiting.
// This is middleware — it sits between the agent and the raw tool handlers.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path, { join } from "node:path";
import { protect } from "../security/pii-vault.js";

// ═══════════════════════════════════════════════
// 1. RESULT CACHE (TTL-based)
// ═══════════════════════════════════════════════

interface CacheEntry {
    result: string;
    timestamp: number;
}

const cache = new Map<string, CacheEntry>();

// Map grows by one entry per distinct (toolName, args) combination. Without a
// background sweep, entries whose key is never queried again stay forever. A
// long-running agent accumulates thousands of unique `read` / `grep` / `glob`
// argument sets over days. Cap + periodic eviction bound the footprint.
const MAX_CACHE_ENTRIES = 10000;
const CACHE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let _cacheSweepTimer: NodeJS.Timeout | null = null;

// Tools whose results are safe to cache (read-only, no side effects)
const CACHEABLE_TOOLS = new Set([
    "system_info",
    "app_manager", // only the "list" action
    "dark_mode", // only the "status" action
    "bluetooth_control", // only "status" and "list" actions
    "wifi_control", // only "status" action
    "file_metadata", // read-only file info
    "list_directory", // read-only directory listing
    "read", // read-only file contents
    "get_current_time", // current time (short TTL)
    "list_webhooks", // webhooks list
    "identity_view", // identity info
    "trait_list", // traits listing
    "google_accounts", // only "list" action
    // Expensive tools — caching saves significant cost
    "web_search", // search results are stable for minutes
    "glob", // file listing stable for short windows
    "grep", // codebase searches stable for short windows
]);

// Actions that are read-only for tools with mixed read/write actions
const CACHEABLE_ACTIONS: Record<string, Set<string>> = {
    app_manager: new Set(["list"]),
    dark_mode: new Set(["status"]),
    bluetooth_control: new Set(["status", "list"]),
    wifi_control: new Set(["status"]),
    google_accounts: new Set(["list"]),
};

// Per-tool TTLs (ms) — longer for stable data, shorter for volatile
const TOOL_TTL_MS: Record<string, number> = {
    // Very stable — long TTL (5 minutes)
    system_info: 300_000,
    identity_view: 300_000,
    trait_list: 300_000,
    // Moderately stable — medium TTL (2 minutes)
    list_directory: 120_000,
    file_metadata: 120_000,
    google_accounts: 120_000,
    list_tasks: 120_000,
    list_webhooks: 120_000,
    // Somewhat volatile — standard TTL (60 seconds)
    read: 60_000,
    app_manager: 60_000,
    bluetooth_control: 60_000,
    wifi_control: 60_000,
    dark_mode: 60_000,
    get_current_time: 5_000, // Time changes constantly
    // Expensive tools — cache to reduce latency + cost
    web_search: 120_000, // Search results stable for 2 minutes
    glob: 60_000, // File listings stable for short windows
    grep: 60_000, // Code search results stable for short windows
};

const DEFAULT_TTL_MS = 60_000; // 60 seconds (doubled from 30)

function getCacheKey(toolName: string, args: Record<string, unknown>): string {
    // Sort args for consistency
    const sorted = Object.keys(args)
        .sort()
        .reduce(
            (acc, k) => {
                acc[k] = args[k];
                return acc;
            },
            {} as Record<string, unknown>,
        );
    return `${toolName}:${JSON.stringify(sorted)}`;
}

/**
 * Check if a tool call is eligible for caching.
 */
export function isCacheable(toolName: string, args: Record<string, unknown>): boolean {
    if (!CACHEABLE_TOOLS.has(toolName)) return false;

    // system_info has no actions, always cacheable
    if (toolName === "system_info") return true;

    // A mixed read/write tool is cached only when the call names a read action
    // (dark_mode calls it `mode`); anything else may change what it reads.
    const allowed = CACHEABLE_ACTIONS[toolName];
    if (allowed) return allowed.has(String(args.action ?? args.mode));

    return true;
}

/**
 * Drop cached reads of local state after a call that may have changed it: a toggle
 * leaves the cached status stale, an edit leaves the cached file, ⌘C the clipboard.
 * Web search results don't depend on anything done here, so they stay.
 */
export function invalidateLocalState(): void {
    for (const key of cache.keys()) if (!key.startsWith("web_search:")) cache.delete(key);
}

/**
 * Get cached result if available and fresh.
 */
export function getCached(toolName: string, args: Record<string, unknown>): string | null {
    const key = getCacheKey(toolName, args);
    const entry = cache.get(key);
    if (!entry) return null;

    const ttl = TOOL_TTL_MS[toolName] ?? DEFAULT_TTL_MS;
    const age = Date.now() - entry.timestamp;
    if (age > ttl) {
        cache.delete(key);
        return null;
    }

    return entry.result;
}

/**
 * A tool result that signals failure. Caching one would pin a transient error
 * (a network blip, a momentarily locked file) for the whole TTL — web_search
 * 2min, read_file 1min, system_info 5min — so an identical retry keeps getting
 * the stale failure instead of re-running. Non-JSON (plain text) is a real
 * result and stays cacheable.
 */
export function isErrorResult(result: string): boolean {
    try {
        const p = JSON.parse(result);
        return Boolean(p && typeof p === "object" && ((p as Record<string, unknown>).error || (p as Record<string, unknown>).success === false));
    } catch {
        return false;
    }
}

/**
 * Store result in cache. Error results are never cached (see isErrorResult).
 */
export function setCache(toolName: string, args: Record<string, unknown>, result: string): void {
    if (isErrorResult(result)) return;
    const key = getCacheKey(toolName, args);
    if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
        // Evict the oldest — Map preserves insertion order so the first key is oldest.
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { result, timestamp: Date.now() });
}

/**
 * Clear all cached results (call when conversation resets).
 */
export function clearCache(): void {
    cache.clear();
}

// Sweep expired entries so keys that never get re-read still fall out of the
// map. Without this, cache entries whose TTL passed but whose getCached call
// never happens again accumulate indefinitely.
function sweepCache(): void {
    const now = Date.now();
    for (const [key, entry] of cache) {
        const toolName = key.split(":")[0];
        const ttl = TOOL_TTL_MS[toolName] ?? DEFAULT_TTL_MS;
        if (now - entry.timestamp > ttl) cache.delete(key);
    }
}

export function startCacheSweep(): void {
    if (_cacheSweepTimer) return;
    _cacheSweepTimer = setInterval(sweepCache, CACHE_SWEEP_INTERVAL_MS);
    _cacheSweepTimer.unref?.();
}

export function stopCacheSweep(): void {
    if (_cacheSweepTimer) {
        clearInterval(_cacheSweepTimer);
        _cacheSweepTimer = null;
    }
}

export function _getCacheSizeForTests(): number {
    return cache.size;
}

export function _sweepCacheForTests(): void {
    sweepCache();
}

// Auto-arm on module load so callers don't need to wire it explicitly. The
// unref() above keeps the timer from holding the process open at shutdown.
startCacheSweep();

// ═══════════════════════════════════════════════
// 2. AUDIT LOG
// ═══════════════════════════════════════════════

let auditLogPath: string | null = null;
let auditLogSetup = false;

function ensureAuditLog(): string {
    if (auditLogPath && auditLogSetup) return auditLogPath;
    const dir = process.env.ATLAS_DATA_DIR || join(process.cwd(), "data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    auditLogPath = join(dir, "audit.jsonl");
    auditLogSetup = true;
    return auditLogPath;
}

/** Memory tools carry the owner's facts; those live in the memory DB, where forget can reach them, never in logs. */
export const ownerMemoryTool = (name: string): boolean => /^(core_memory|memory|identity|trait)_/.test(name);

/**
 * Log a tool call to the audit log.
 */
export function auditLog(entry: {
    tool: string;
    args: Record<string, unknown>;
    success: boolean;
    cached: boolean;
    durationMs: number;
    error?: string;
}): void {
    try {
        const logPath = ensureAuditLog();
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            ...entry,
            // Truncate large args/errors
            args: ownerMemoryTool(entry.tool) ? Object.keys(entry.args) : truncateObj(entry.args, 200),
            error: entry.error?.substring(0, 200),
        });
        // Typing tools log revealed values (an OTP, a saved password): mask them.
        appendFileSync(logPath, protect(line, { credentials: false }) + "\n");
    } catch {
        // Never let audit logging break tool execution
    }
}

function truncateObj(obj: Record<string, unknown>, maxLen: number): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && v.length > maxLen) {
            result[k] = v.substring(0, maxLen) + "...";
        } else {
            result[k] = v;
        }
    }
    return result;
}

/**
 * Rotate audit log — keep only last 7 days of entries.
 * Call this periodically (e.g., on startup or daily).
 */
export async function rotateAuditLog(): Promise<void> {
    try {
        const logPath = ensureAuditLog();
        if (!existsSync(logPath)) return;

        const stats = statSync(logPath);
        // Only rotate if file is > 5MB
        if (stats.size < 5 * 1024 * 1024) return;

        const content = readFileSync(logPath, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        const sevenDaysAgo = Date.now() - 7 * 86400000;

        const kept = lines.filter((line) => {
            try {
                const entry = JSON.parse(line);
                return new Date(entry.ts).getTime() > sevenDaysAgo;
            } catch {
                return false; // Drop malformed lines
            }
        });

        writeFileSync(logPath, kept.join("\n") + "\n");
        console.log(`📋 Audit log rotated: ${lines.length} → ${kept.length} entries`);
    } catch {
        // Silent failure
    }
}

// ═══════════════════════════════════════════════
// 3. RATE LIMITER
// ═══════════════════════════════════════════════

interface RateBucket {
    count: number;
    windowStart: number;
}

const rateBuckets = new Map<string, RateBucket>();

// Tools exempt from rate limiting (long-running processes)
const RATE_EXEMPT_TOOLS = new Set([
    "deep_research",
    "check_deep_research",
    "cancel_deep_research",
    "start_long_task",
    "check_long_task",
    "cancel_long_task",
    "resume_long_task",
    "swarm_task",
    "shell_exec_background",
    "shell_check_process",
    "shell_wait_process",
    "shell_kill_process",
]);

// Per-tool rate limits (calls per 60-second window)
const RATE_LIMITS: Record<string, number> = {
    // Expensive tools
    os_screenshot: 20,
    os_ocr_click: 20,
    os_visual_verify: 20,
    os_scan: 20,
    os_click_element: 30,
    os_multi_action: 15,
    os_zoom_region: 20,
    send_screenshot: 10,
    web_search: 15,
    // Default for everything else
    _default: 30,
};

/**
 * Check if a tool call is within rate limits.
 * Returns true if allowed, false if rate-limited.
 */
export function checkRateLimit(toolName: string): { allowed: boolean; reason?: string } {
    if (RATE_EXEMPT_TOOLS.has(toolName)) return { allowed: true };

    const limit = RATE_LIMITS[toolName] || RATE_LIMITS._default;
    const now = Date.now();
    const windowMs = 60_000; // 1 minute

    let bucket = rateBuckets.get(toolName);
    if (!bucket || now - bucket.windowStart > windowMs) {
        // New window
        bucket = { count: 0, windowStart: now };
        rateBuckets.set(toolName, bucket);
    }

    bucket.count++;

    if (bucket.count > limit) {
        return {
            allowed: false,
            reason: `Rate limit exceeded for ${toolName}: ${bucket.count}/${limit} calls in 60s. Please slow down.`,
        };
    }

    return { allowed: true };
}

/**
 * Reset all rate buckets (call on conversation reset).
 */
export function resetRateLimits(): void {
    rateBuckets.clear();
}

// ═══════════════════════════════════════════════
// 4. DESTRUCTIVE ACTION CONFIRMATION
// ═══════════════════════════════════════════════

// Tools/actions that are destructive and should be confirmed
const DESTRUCTIVE_ACTIONS: Record<string, Set<string>> = {
    trash_manager: new Set(["empty"]),
    wifi_control: new Set(["off"]),
    app_manager: new Set(["force_quit"]),
    delete_file: new Set(["*"]), // all actions
    site_task: new Set(["confirm"]), // places an order / pays
    vault_authorize_payment: new Set(["*"]), // lets Bhai type a saved card / UPI ID for this item and amount
};

// Dangerous shell command patterns that should trigger a warning
const DANGEROUS_SHELL_PATTERNS = [
    /\brm\s+(-rf?|--recursive)\s+[/~]/i, // rm -rf /path or rm -r ~/
    /\brm\s+-rf?\s+\//i, // rm -rf /
    /\bmkfs\b/i, // filesystem format
    /\bdd\s+if=/i, // disk destroyer
    /:\(\)\{\s*:\|:&\s*\};:/, // fork bomb
    /\bshutdown\b/i, // system shutdown
    /\breboot\b/i, // system reboot
    /\bchmod\s+777\b/, // world-writable permissions
    /DROP\s+(TABLE|DATABASE)/i, // SQL destructive
    /DELETE\s+FROM\s+\w+\s*;?\s*$/i, // SQL delete without WHERE
    /\bgit\s+push\s+.*--force\b/i, // force push
    /\bgit\s+reset\s+--hard\b/i, // hard reset
    // Something that runs by itself later (a login item, every new terminal, SSH access):
    // what an injected page would plant to survive the chat.
    /\blaunchctl\s+(load|bootstrap|enable|submit)\b/i,
    /\bcrontab\b(?!\s+-l\b)/i, // editing the crontab, not listing it
    /\bLaunch(Agents|Daemons)\b/,
    /\bauthorized_keys\b/,
    />>?\s*["']?[^\s"';|&]*\/\.(zshrc|zprofile|zshenv|zlogin|bashrc|bash_profile|profile)\b/, // > ~/.zshrc
];

/** A file that makes code run by itself later: a login item, a shell startup file, SSH access. */
export function autostartTarget(filePath: string): string | null {
    const home = homedir();
    const p = path.resolve(filePath.replace(/^~(?=\/|$)/, home));
    const rc = [".zshrc", ".zprofile", ".zshenv", ".zlogin", ".bashrc", ".bash_profile", ".profile"];
    if (rc.some((f) => p === path.join(home, f))) return "a shell startup file (runs in every new terminal)";
    if (p === path.join(home, ".config", "fish", "config.fish")) return "a shell startup file (runs in every new terminal)";
    if (/\/Library\/Launch(Agents|Daemons)(\/|$)/.test(p)) return "a login item (runs by itself at login)";
    if (p === path.join(home, ".ssh", "authorized_keys") || p === path.join(home, ".ssh", "config"))
        return "SSH access settings";
    return null;
}

const FILE_WRITERS = new Set(["write", "edit", "append_file"]);

// ── Destructive hotkeys ──
// Keyboard tools can quit apps, close windows
// or trash files with one combo, so they go through the same gate as the actions above.
const MOD_ALIASES: Record<string, string> = {
    cmd: "cmd",
    command: "cmd",
    meta: "cmd",
    "⌘": "cmd",
    super: "cmd",
    ctrl: "ctrl",
    control: "ctrl",
    "^": "ctrl",
    alt: "alt",
    option: "alt",
    opt: "alt",
    "⌥": "alt",
    shift: "shift",
    "⇧": "shift",
};
const KEY_ALIASES: Record<string, string> = {
    return: "enter",
    enter: "enter",
    "↩": "enter",
    delete: "delete",
    del: "delete",
    backspace: "delete",
    forwarddelete: "delete",
    "forward delete": "delete",
    "⌫": "delete",
};

/**
 * True for combos that quit/close/trash: cmd+q, cmd+w, cmd+delete, alt+f4, ctrl+w, ...
 * Send combos (cmd+return) are left out on purpose: plain Enter sends in most
 * chat apps anyway, and gating them would block every "send this" the owner asked for.
 */
export function isDestructiveHotkey(combo: string): boolean {
    const parts = String(combo)
        .toLowerCase()
        .split("+")
        .map((p) => p.trim())
        .filter(Boolean);
    if (parts.length < 2) return false;
    const mods = new Set<string>();
    const keys: string[] = [];
    for (const p of parts) {
        if (MOD_ALIASES[p]) mods.add(MOD_ALIASES[p]);
        else keys.push(KEY_ALIASES[p] ?? p);
    }
    if (keys.length !== 1) return false;
    const key = keys[0];
    const cmdOrCtrl = mods.has("cmd") || mods.has("ctrl");
    if ((key === "q" || key === "w") && cmdOrCtrl) return true; // quit / close window or tab
    if (key === "f4" && (mods.has("alt") || mods.has("ctrl"))) return true; // close window (Windows/Linux)
    if (key === "delete" && (mods.has("cmd") || mods.has("shift"))) return true; // trash / permanent delete
    return false;
}

/** Every hotkey combo a keyboard tool call would press. */
function hotkeysIn(toolName: string, args: Record<string, unknown>): string[] {
    const out: string[] = [];
    if (toolName === "os_type" && typeof args.combo === "string") out.push(args.combo);
    if (toolName === "os_computer_action" && args.action === "key" && typeof args.text === "string")
        out.push(args.text);
    if (toolName === "os_multi_action" && Array.isArray(args.actions)) {
        for (const a of args.actions as Array<Record<string, unknown>>) {
            if ((a?.action === "combo" || a?.action === "key") && typeof a.key === "string") out.push(a.key);
        }
    }
    return out;
}

/**
 * Check if a tool call requires confirmation.
 * Philosophy: NEVER block — only warn. The agent confirms with the user, then executes.
 */
export function requiresConfirmation(
    toolName: string,
    args: Record<string, unknown>,
): {
    needsConfirmation: boolean;
    warningMessage?: string;
} {
    // Check shell commands for dangerous patterns
    if (toolName === "shell_exec" || toolName === "shell_exec_background") {
        const command = (args.command as string) || "";
        for (const pattern of DANGEROUS_SHELL_PATTERNS) {
            if (pattern.test(command)) {
                return {
                    needsConfirmation: true,
                    warningMessage: `⚠️ Potentially destructive command detected: "${command.substring(0, 80)}". Confirm with the user before executing.`,
                };
            }
        }
    }

    if (FILE_WRITERS.has(toolName) && typeof args.file_path === "string") {
        const what = autostartTarget(args.file_path);
        if (what)
            return {
                needsConfirmation: true,
                warningMessage: `⚠️ ${args.file_path} is ${what}. Confirm with the user before changing it.`,
            };
    }

    // Sent from the open page with the owner's cookies: anything but a read can change
    // their account on that site, and nothing on screen shows it happened.
    if (toolName === "browser_batch_fetch") {
        const method = String(args.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
            const urls = Array.isArray(args.urls) ? args.urls.slice(0, 3).join(", ") : "";
            return {
                needsConfirmation: true,
                warningMessage: `⚠️ A ${method} to ${urls || "these URLs"} goes out signed in as the user and can change things there. Confirm with the user before sending it.`,
            };
        }
    }

    const hotkey = hotkeysIn(toolName, args).find(isDestructiveHotkey);
    if (hotkey) {
        return {
            needsConfirmation: true,
            warningMessage: `⚠️ "${hotkey}" can quit an app, close a window or delete files. Confirm with the user before pressing it.`,
        };
    }

    const destructive = DESTRUCTIVE_ACTIONS[toolName];
    if (!destructive) return { needsConfirmation: false };

    const action = args.action as string | undefined;
    if (destructive.has("*") || (action && destructive.has(action))) {
        let warning: string;
        switch (toolName) {
            case "trash_manager":
                warning = "⚠️ This will permanently empty the Trash. This cannot be undone.";
                break;
            case "wifi_control":
                warning =
                    "⚠️ Turning off Wi-Fi will kill my connection. I won't be able to respond until you turn it back on manually.";
                break;
            case "app_manager":
                warning = `⚠️ Force-quitting "${args.app}" may cause unsaved data loss.`;
                break;
            case "vault_authorize_payment":
                warning = `⚠️ This lets Bhai pay ₹${args.amount} for "${args.item}" with a saved card or UPI ID on ${args.site ? String(args.site) : "an unknown site — open the https payment page in the browser first"}.`;
                break;
            case "site_task":
                warning = `⚠️ This places the order and pays ₹${args.amount}. It cannot be undone.`;
                break;
            case "delete_file":
                warning = `⚠️ This will permanently delete "${args.path}". Use trash_manager instead for safe deletion.`;
                break;
            default:
                warning = "⚠️ This is a destructive action that cannot be undone.";
        }
        return { needsConfirmation: true, warningMessage: warning };
    }

    return { needsConfirmation: false };
}

// ═══════════════════════════════════════════════
// 5. TOOL USAGE ANALYTICS
// ═══════════════════════════════════════════════

interface ToolStats {
    calls: number;
    successes: number;
    failures: number;
    totalDurationMs: number;
    lastUsed: number;
}

const toolStats = new Map<string, ToolStats>();

/**
 * Record a tool call result for analytics.
 */
export function recordToolUsage(toolName: string, success: boolean, durationMs: number): void {
    let stats = toolStats.get(toolName);
    if (!stats) {
        stats = { calls: 0, successes: 0, failures: 0, totalDurationMs: 0, lastUsed: 0 };
        toolStats.set(toolName, stats);
    }
    stats.calls++;
    if (success) stats.successes++;
    else stats.failures++;
    stats.totalDurationMs += durationMs;
    stats.lastUsed = Date.now();
}

/**
 * Get analytics summary for all tools.
 */
export function getToolAnalytics(): Record<string, ToolStats & { avgDurationMs: number; successRate: number }> {
    const result: Record<string, ToolStats & { avgDurationMs: number; successRate: number }> = {};
    for (const [name, stats] of toolStats) {
        result[name] = {
            ...stats,
            avgDurationMs: stats.calls > 0 ? Math.round(stats.totalDurationMs / stats.calls) : 0,
            successRate: stats.calls > 0 ? Math.round((stats.successes / stats.calls) * 100) : 0,
        };
    }
    return result;
}
