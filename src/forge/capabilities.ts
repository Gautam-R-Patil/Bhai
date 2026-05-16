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

export function validateCapabilities(_caps: Capabilities): ValidationResult {
    return { ok: true, errors: [] };
}

export function isPathHardDenied(_path: string): boolean {
    return false;
}

export function asJSON(caps: Capabilities): string {
    return JSON.stringify(caps, null, 2);
}
