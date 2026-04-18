// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Security Allowlists ───────────────────────
// Minimal blocking — only truly system-destructive commands are blocked.
// The agent uses its own judgment to ask the user when appropriate.

import path from "node:path";

// ── Codebase Self-Protection ──────────────────
// The bot must never write, delete, or move its own source files.

const PROTECTED_PATHS: string[] = [
    "/Users/user/Desktop/ATLAS",
];

/**
 * Returns true when the given path lives inside the protected codebase.
 * Write and delete tools should refuse to act on protected paths.
 */
export function isProtectedPath(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    const sep = path.sep;
    return PROTECTED_PATHS.some((p) => {
        const rp = path.resolve(p);
        return resolved === rp || resolved.startsWith(rp + sep);
    });
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
            const resolved = path.resolve(arg);
            const sep = path.sep;
            if (PROTECTED_PATHS.some((p) => {
                const rp = path.resolve(p);
                return resolved === rp || resolved.startsWith(rp + sep);
            })) {
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
 */
export function isCriticalSystemPath(filePath: string): boolean {
    const resolved = path.resolve(filePath).toLowerCase();
    const sep = path.sep;
    return CRITICAL_SYSTEM_PATHS.some((p) => {
        const rp = path.resolve(p).toLowerCase();
        return resolved === rp || resolved.startsWith(rp + sep);
    });
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
        const resolved = path.resolve(filePath);
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
// Keep network restrictions for security (prevent data exfiltration)

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
