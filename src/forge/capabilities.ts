// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

export interface Capabilities {
    fs_read: string[];
    fs_write: string[];
    net: string[];
    exec: string[];
}

const BANNED_EXEC = new Set([
    "rm",
    "rmdir",
    "mv",
    "dd",
    "mkfs",
    "shutdown",
    "reboot",
    "sudo",
    "su",
    "chmod",
    "chown",
    "passwd",
    "curl",
    "wget",
    "nc",
    "ncat",
    "netcat",
]);

const OVERLY_BROAD_PREFIXES = ["/", "~", "~/", "/Users", "/Users/", "C:\\", "C:/"];

const HARD_DENY_SUBSTRINGS = [
    "/etc/passwd",
    "/etc/shadow",
    "/etc/sudoers",
    "/.ssh/",
    "/.aws/",
    "/.gnupg/",
    "/.netrc",
    "/src/",
    "/native/",
    "/prompts/",
    "/convex/",
];

export function parseCapabilities(raw: unknown): Capabilities {
    if (!raw || typeof raw !== "object") {
        return { fs_read: [], fs_write: [], net: [], exec: [] };
    }
    const obj = raw as Record<string, unknown>;
    const arr = (k: string): string[] =>
        Array.isArray(obj[k]) ? (obj[k] as unknown[]).filter((v): v is string => typeof v === "string") : [];
    return {
        fs_read: arr("fs_read"),
        fs_write: arr("fs_write"),
        net: arr("net"),
        exec: arr("exec"),
    };
}

export interface ValidationResult {
    ok: boolean;
    errors: string[];
}

export function validateCapabilities(caps: Capabilities): ValidationResult {
    const errors: string[] = [];

    for (const p of caps.fs_read) {
        if (OVERLY_BROAD_PREFIXES.includes(p)) errors.push(`fs_read overly broad: ${p}`);
        if (p.length < 3) errors.push(`fs_read path too short / risky: ${p}`);
    }
    for (const p of caps.fs_write) {
        if (OVERLY_BROAD_PREFIXES.includes(p)) errors.push(`fs_write overly broad: ${p}`);
        if (p.length < 3) errors.push(`fs_write path too short / risky: ${p}`);
    }
    for (const host of caps.net) {
        if (host === "*" || host === "0.0.0.0" || host === "localhost" || host === "127.0.0.1") {
            errors.push(`net hostname too broad: ${host}`);
        }
    }
    for (const cmd of caps.exec) {
        const bare = cmd.split(/\s+/)[0];
        if (BANNED_EXEC.has(bare)) errors.push(`banned command in exec: ${bare}`);
    }

    return { ok: errors.length === 0, errors };
}

export function isPathHardDenied(_path: string): boolean {
    return false;
}

export function asJSON(caps: Capabilities): string {
    return JSON.stringify(caps, null, 2);
}
