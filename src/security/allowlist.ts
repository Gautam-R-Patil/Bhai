// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Security Allowlists ───────────────────────
// Minimal blocking — only truly system-destructive commands are blocked.
// The agent uses its own judgment to ask the user when appropriate.

import fs from "node:fs";
import path from "node:path";

// ── Codebase Self-Protection ──────────────────
// The bot must never write, delete, or move its own source files.
// PROTECTED_PATHS are populated at runtime — empty by default. The host
// can register installation-specific paths via registerProtectedPath()
// (e.g. desktop/main.js can pin the bundled bot directory). This avoids
// shipping a developer-machine path in the binary.

const PROTECTED_PATHS: string[] = [];

/**
 * Register a path that write/delete tools must refuse to touch.
 * Idempotent — duplicates are ignored.
 */
export function registerProtectedPath(p: string): void {
    if (!p) return;
    const normalized = path.resolve(p);
    if (!PROTECTED_PATHS.includes(normalized)) {
        PROTECTED_PATHS.push(normalized);
    }
}

/**
 * @internal — test isolation only. Clears the registered protected paths
 * so a test can exercise the empty/disabled state without polluting the
 * module state for sibling tests.
 */
export function _clearProtectedPaths(): void {
    PROTECTED_PATHS.length = 0;
}

/**
 * Resolve a path to its real (symlink-followed) absolute form.
 *
 * path.resolve alone normalizes "/." and "/.." and makes the path
 * absolute, but it does NOT follow symlinks — meaning a symlink in
 * an unprotected dir pointing INTO a protected one would bypass the
 * downstream protected-path check. fs.realpathSync resolves every
 * symlink in the chain, closing that TOCTOU gap.
 *
 * realpathSync throws ENOENT when the target doesn't exist yet — a
 * common case for write operations (we're about to CREATE the file).
 * In that case we fall back to realpath-ing the deepest existing
 * ancestor and appending the missing tail, so a brand-new file
 * inside a symlinked directory is still correctly classified.
 *
 * The native realpath also canonicalizes what the JS one leaves as typed:
 * letter case (macOS/Windows), Windows 8.3 short names (C:\PROGRA~1),
 * trailing dots and \\?\ prefixes. Without it "c:\bhai\src" or
 * "C:\BHAI~1\src" slipped past a deny check registered as C:\Bhai.
 */
export function realResolve(inputPath: string): string {
    const abs = path.resolve(inputPath);
    try {
        return fs.realpathSync.native(abs);
    } catch {
        // Target missing. Walk up the tree to find the nearest real
        // ancestor and reattach the trailing (non-existent) segments
        // so a future-file inside a symlinked parent is still
        // resolved through the symlink.
        const parts = abs.split(path.sep);
        const trailing: string[] = [];
        while (parts.length > 1) {
            const leaf = parts.pop();
            if (leaf) trailing.unshift(leaf);
            // A bare drive ("D:") is D:'s current directory on Windows, not
            // its root, so re-add the separator (POSIX's [""] becomes "/").
            const candidate = parts.length === 1 ? parts[0] + path.sep : parts.join(path.sep);
            try {
                const real = fs.realpathSync.native(candidate);
                return trailing.length
                    ? path.join(real, ...trailing)
                    : real;
            } catch {
                // Keep walking up.
            }
        }
        // Nothing resolved (e.g. / doesn't exist, which shouldn't
        // happen). Fall back to the plain absolute form.
        return abs;
    }
}

/**
 * True when `child` is `parent` or lies under it. The `+ sep` guard keeps
 * "/path/BHAI-sibling" from matching "/path/BHAI". Case-insensitive:
 * these are deny checks (fail-closed) and macOS/Windows volumes ignore
 * case. `p` is injectable so tests on any OS can exercise path.win32.
 */
export function isPathWithin(child: string, parent: string, p: path.PlatformPath = path): boolean {
    const c = p.normalize(child).toLowerCase();
    const r = p.normalize(parent).toLowerCase();
    return c === r || c.startsWith(r.endsWith(p.sep) ? r : r + p.sep);
}

/**
 * Returns true when the given path lives inside the protected codebase.
 * Write and delete tools should refuse to act on protected paths.
 *
 * Uses realResolve under the hood so a symlink pointing into the
 * protected tree is correctly classified.
 */
export function isProtectedPath(filePath: string): boolean {
    const resolved = realResolve(filePath);
    return PROTECTED_PATHS.some((p) => isPathWithin(resolved, realResolve(p)));
}

/**
 * Scans an array of shell-command arguments for any string that resolves
 * to (or starts with) a protected path.  Used by the shell tool.
 */
export function shellArgsTargetProtectedPath(args: string[]): string | null {
    for (const arg of args) {
        // Skip flags
        if (arg.startsWith("-")) continue;
        try {
            const resolved = realResolve(arg);
            if (PROTECTED_PATHS.some((p) => isPathWithin(resolved, realResolve(p)))) {
                return resolved;
            }
        } catch {
            // ignore non-path args
        }
    }
    return null;
}

// ── System-Destructive Command Detection ─────────────────────
// ONLY these patterns are blocked — everything else is allowed.
// The agent decides when to ask the user for approval on risky operations.

const SYSTEM_DESTRUCTIVE_PATTERNS: RegExp[] = [
    // Wipe entire filesystem
    /^rm\s+(-[rf]+\s+)*\/\s*$/,                          // rm -rf /
    /^rm\s+(-[rf]+\s+)*\/\*\s*$/,                        // rm -rf /*
    /^rm\s+(-[rf]+\s+)*--no-preserve-root\s+\//,         // rm --no-preserve-root /

    // Format/wipe system disk (macOS)
    /diskutil\s+(eraseDisk|partitionDisk|secureErase).*disk0/i,
    /diskutil\s+apfs\s+deleteContainer.*disk0/i,

    // Format/wipe system disk (Linux)
    /mkfs(\.\w+)?\s+.*\/dev\/(sda|nvme0n1|vda)\b/i,      // mkfs on system disk
    /wipefs\s+.*\/dev\/(sda|nvme0n1|vda)\b/i,            // wipefs on system disk

    // dd writing to system disk
    /dd\s+.*of=\/dev\/(disk0|sda|nvme0n1|vda)\b/i,

    // Format system drive (Windows)
    /format\s+[cC]:\s*/i,                                // format C:
    /diskpart.*clean/i,                                  // diskpart clean commands

    // Destroy boot/system files
    /rm\s+(-[rf]+\s+)*\/(boot|System|Windows|usr|bin|sbin|lib|etc)\b/i,
    /rm\s+(-[rf]+\s+)*\/var\s*$/,                        // rm -rf /var (entire)

    // Fork bomb patterns
    /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/,              // Bash fork bomb :(){ :|:& };:
    /\$0\s*\|\s*\$0\s*&/,                               // $0|$0&

    // Kernel/system destruction
    /echo\s+.*>\s*\/dev\/(sda|nvme0n1|mem|kmem)/i,
    /cat\s+.*>\s*\/dev\/(sda|nvme0n1|mem|kmem)/i,
];

/**
 * Check if a command is system-destructive and should be blocked entirely.
 * Returns true ONLY for commands that would damage the main OS.
 * Everything else is allowed — the agent asks user when it thinks appropriate.
 */
export function isSystemDestructive(fullCommand: string): boolean {
    const normalized = fullCommand.trim();
    return SYSTEM_DESTRUCTIVE_PATTERNS.some(pattern => pattern.test(normalized));
}

/**
 * Get command permission level.
 * Returns 'block' only for system-destructive commands.
 * Everything else returns 'allow' — agent uses judgment for user prompts.
 */
export function getCommandPermission(fullCommand: string): "allow" | "block" {
    if (isSystemDestructive(fullCommand)) return "block";
    return "allow";
}

// ── Legacy Compatibility ─────────────────────
// These functions are kept for backwards compatibility but now allow everything.

/**
 * @deprecated Use getCommandPermission() instead.
 * Now allows all commands except system-destructive ones.
 */
export function isCommandAllowed(command: string): boolean {
    // Build the full command for pattern matching if it's just the base command
    return !isSystemDestructive(command);
}

/**
 * Check for shell bypass attempts with system-destructive commands.
 * Only blocks if the inline command is system-destructive.
 */
export function isShellBypass(command: string, args: string[]): boolean {
    const baseCmd = path.basename(command).split(" ")[0];
    const SHELLS = new Set(["bash", "sh", "zsh", "dash", "fish", "powershell", "powershell.exe", "cmd", "cmd.exe"]);
    if (!SHELLS.has(baseCmd)) return false;

    // Check if -c flag is present (inline command execution)
    const cIndex = args.indexOf("-c");
    if (cIndex === -1) return false;

    // Check if the inline command is system-destructive
    const inlineCmd = args.slice(cIndex + 1).join(" ");
    return isSystemDestructive(inlineCmd);
}

// ── Critical System Path Protection ──────────────────────
// These paths contain OS-critical files that should never be written to or
// deleted by the agent.  Reading is still allowed — only mutation is blocked.
// The agent retains full access to everything else on the filesystem.

const CRITICAL_SYSTEM_PATHS: string[] = [
    // Unix / macOS core OS paths
    // "/etc" wholesale — not just the three files below. On macOS /etc is a
    // symlink to /private/etc (listed), so every /etc/* read was already
    // blocked; on Linux there is no /private/etc, so without this a sandboxed
    // dynamic tool could read /etc/hosts, /etc/fstab, /etc/resolv.conf, etc.
    // Listing /etc gives Linux the parity macOS always had.
    "/etc",
    "/etc/passwd", "/etc/shadow", "/etc/sudoers",
    "/boot", "/System/Library",
    "/usr/bin", "/usr/sbin", "/sbin", "/bin",
    "/var/root", "/private/etc",
    // Windows equivalents
    "C:\\Windows\\System32", "C:\\Windows\\SysWOW64",
    "C:\\Program Files\\WindowsApps",
];

/**
 * Returns true when the given path is inside one of the critical OS paths.
 * Used as a safety net to prevent accidental modification of core system files.
 *
 * Symlink-aware via realResolve — a symlink pointing at /etc/passwd
 * is treated as /etc/passwd for the purposes of this check.
 */
export function isCriticalSystemPath(filePath: string): boolean {
    const resolved = realResolve(filePath);
    return CRITICAL_SYSTEM_PATHS.some((p) => isPathWithin(resolved, realResolve(p)));
}

// ── Path Access ────────────────────────────────
// Full filesystem access — the agent can read/write anywhere EXCEPT
// critical OS paths (blocked) and its own codebase (blocked by isProtectedPath).

/**
 * Check whether a file path is safe to operate on.
 * Returns `{ allowed: true }` for everything EXCEPT critical OS paths,
 * where it returns `{ allowed: false, reason: "..." }`.
 *
 * Legacy boolean overload is preserved for backward compatibility.
 */
export function isPathAllowed(filePath: string): boolean {
    if (isCriticalSystemPath(filePath)) {
        return false;
    }
    return true;
}

/**
 * Returns a human-readable reason when a path is disallowed, or null if OK.
 * Consumers that need the message should call this after isPathAllowed returns false.
 */
export function getPathBlockedReason(filePath: string): string | null {
    if (isCriticalSystemPath(filePath)) {
        const resolved = realResolve(filePath);
        return `Path "${resolved}" is a critical operating-system path and cannot be modified. ` +
            `This safety guardrail prevents accidental damage to the OS. ` +
            `If you truly need to change this file, use a shell command with appropriate privileges.`;
    }
    return null;
}

/**
 * @deprecated No longer needed — full filesystem access enabled.
 */
export function addAllowedPath(_dirPath: string): void {
    // No-op: all paths are now allowed
}

// ── Network Allowlist ─────────────────────────
// Bhai is a general-purpose agent and DEFAULTS to open network access —
// the LLM, browser, web_search, and shell layers all need it. This
// allowlist is therefore advisory: callers can consult it when they
// want a tight egress policy (e.g. running an untrusted sub-agent). It
// is NOT wired into browserNavigate/webSearch/fetch by design.
//
// Decision: keep the function rather than delete. Used in tests today;
// reserved for future opt-IN sub-agent egress policy controlled by
// BHAI_NO_DOMAIN_ALLOWLIST=true (off by default).

const ALLOWED_DOMAINS = new Set([
    "api.openai.com",
    "api.anthropic.com",
    "openrouter.ai",
    "api.elevenlabs.io",
    "api.github.com",
    "duckduckgo.com",
    "html.duckduckgo.com",
    "google.com",
    "www.google.com",
]);

export function isDomainAllowed(domain: string): boolean {
    return ALLOWED_DOMAINS.has(domain) || ALLOWED_DOMAINS.has(`www.${domain}`);
}

export function addAllowedDomain(domain: string): void {
    ALLOWED_DOMAINS.add(domain);
}

// ── Logging ───────────────────────────────────

export function logSecurityEvent(type: string, detail: string): void {
    const timestamp = new Date().toISOString();
    console.log(`🛡️ [SECURITY] ${timestamp} | ${type} | ${detail}`);
}
