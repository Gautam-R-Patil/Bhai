// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { lookup } from "node:dns/promises";

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
    "/.env",
    "/data/google-credentials.json",
    "/.atlas/store/dynamic/", // self-tamper: tools must not modify other tool dirs
    "/.atlas/data/",
    "/.atlas/dynamic-tools/",
    "/data/google-tokens/",
    "/.atlas/data/",
    "/.atlas/dynamic-tools/",
    "/.docker/config.json",
    "/.kube/config",
    "/.npmrc",
    "/.git-credentials",
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

/**
 * Returns true if the given string is an IP address in a private/loopback/link-local
 * range and therefore must not be reachable from a synthesized tool. Covers:
 *  - IPv4 loopback 127.0.0.0/8
 *  - IPv4 link-local 169.254.0.0/16 (AWS/GCP IMDS)
 *  - IPv4 private 10/8, 172.16/12, 192.168/16
 *  - IPv4 CGNAT 100.64.0.0/10
 *  - IPv4-mapped IPv6 (::ffff:a.b.c.d) when the wrapped address matches the above
 *  - IPv6 loopback ::1
 *  - IPv6 ULA fc00::/7
 *  - IPv6 link-local fe80::/10
 *  - IPv6 unspecified ::
 */
export function isPrivateOrLoopbackIp(addr: string): boolean {
    if (!addr) return false;
    const lower = addr.toLowerCase().trim();
    // IPv6 unspecified / loopback
    if (lower === "::" || lower === "::1" || lower === "0:0:0:0:0:0:0:0" || lower === "0:0:0:0:0:0:0:1") return true;
    // IPv4-mapped IPv6
    const v4mapped = lower.match(/^::ffff:([0-9a-f:.]+)$/);
    if (v4mapped) {
        const inner = v4mapped[1];
        // Could be dotted or hex notation
        if (/^\d+\.\d+\.\d+\.\d+$/.test(inner)) return isPrivateOrLoopbackIp(inner);
        // 4-hex pair fallback: ::ffff:7f00:1 form is unusual; conservatively refuse
        return true;
    }
    // IPv6 ULA fc00::/7  (fc.. or fd..)
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
    // IPv6 link-local fe80::/10
    if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;

    // IPv4 dotted quad
    const m = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const a = Number(m[1]),
        b = Number(m[2]);
    if ([a, b, Number(m[3]), Number(m[4])].some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 0) return true; // 0.0.0.0/8 (incl. 0.0.0.0)
    return false;
}

// Control chars + SBPL/landlock-injecting metachars rejected in all paths.
// Newlines/parens flow verbatim into the macOS SBPL profile and could allow
// rule injection if not blocked here.
const CONTROL_OR_INJECT_RE = /[\x00-\x1f\x7f()]/;

function rejectControlChars(p: string, field: string, errors: string[]): void {
    if (CONTROL_OR_INJECT_RE.test(p)) {
        errors.push(`${field} contains control chars or SBPL metacharacters: ${JSON.stringify(p)}`);
    }
}

/**
 * Reject `..` traversal AND double-slash collapse vectors. Without this,
 * `"/.."` (length 3, not in OVERLY_BROAD_PREFIXES, no hard-deny substring)
 * passes validation but canonicalizes to `/` — the synthesized tool gets
 * read/write of the entire filesystem.
 */
function rejectTraversal(p: string, field: string, errors: string[]): void {
    if (p.includes("..")) {
        errors.push(`${field} contains '..' traversal: ${p}`);
    }
    if (p.includes("//")) {
        errors.push(`${field} contains '//' collapse: ${p}`);
    }
}

export function validateCapabilities(caps: Capabilities): ValidationResult {
    const errors: string[] = [];

    for (const p of caps.fs_read) {
        if (OVERLY_BROAD_PREFIXES.includes(p)) errors.push(`fs_read overly broad: ${p}`);
        if (p.length < 3) errors.push(`fs_read path too short / risky: ${p}`);
        if (isPathHardDenied(p)) errors.push(`fs_read hits hard-deny list: ${p}`);
        rejectControlChars(p, "fs_read", errors);
    }
    for (const p of caps.fs_write) {
        if (OVERLY_BROAD_PREFIXES.includes(p)) errors.push(`fs_write overly broad: ${p}`);
        if (p.length < 3) errors.push(`fs_write path too short / risky: ${p}`);
        if (isPathHardDenied(p)) errors.push(`fs_write hits hard-deny list: ${p}`);
        rejectControlChars(p, "fs_write", errors);
    }
    for (const host of caps.net) {
        // Strip surrounding brackets for IPv6-bracketed form before comparing.
        const raw = host.trim();
        const trimmed = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
        if (
            trimmed === "*" ||
            trimmed === "0.0.0.0" ||
            trimmed === "::" ||
            trimmed === "localhost" ||
            trimmed === "127.0.0.1" ||
            trimmed === "::1"
        ) {
            errors.push(`net hostname too broad: ${host}`);
            continue;
        }
        if (isPrivateOrLoopbackIp(trimmed)) {
            errors.push(`net hostname in private/loopback/link-local range: ${host}`);
        }
        rejectControlChars(host, "net", errors);
    }
    for (const cmd of caps.exec) {
        const bare = cmd.trim().split(/\s+/)[0] ?? "";
        const base = bare.split(/[/\\]/).pop() ?? bare;
        if (BANNED_EXEC.has(bare) || BANNED_EXEC.has(base)) {
            errors.push(`banned command in exec: ${cmd}`);
        }
    }

    return { ok: errors.length === 0, errors };
}

/**
 * Async extension of validateCapabilities — additionally resolves each net hostname
 * via DNS and refuses if any resolved address falls in a private/loopback/link-local
 * range. Hostnames that fail to resolve are refused (best-effort; DNS rebinding is a
 * Phase 4 concern that needs runtime address-pinning).
 */
export async function validateCapabilitiesAsync(caps: Capabilities): Promise<ValidationResult> {
    const sync = validateCapabilities(caps);
    const errors = [...sync.errors];

    for (const host of caps.net) {
        const trimmed = host.trim();
        // Skip syntactic IPs already caught by the sync pass
        if (
            trimmed === "*" ||
            trimmed === "0.0.0.0" ||
            trimmed === "::" ||
            trimmed === "localhost" ||
            trimmed === "127.0.0.1" ||
            trimmed === "::1" ||
            isPrivateOrLoopbackIp(trimmed)
        ) {
            continue;
        }
        // Looks like a hostname or a public IP. Try DNS resolution.
        if (/^[\d.:a-fA-F]+$/.test(trimmed)) {
            // Looked like an IP-shaped string but isPrivateOrLoopbackIp didn't catch it
            // → public-ish IP, accept (real refusal will come from runtime).
            continue;
        }
        try {
            const results = await lookup(trimmed, { all: true });
            for (const r of results) {
                if (isPrivateOrLoopbackIp(r.address)) {
                    errors.push(`net hostname "${host}" resolves to private/loopback address ${r.address}`);
                    break;
                }
            }
        } catch (err) {
            errors.push(`net hostname "${host}" failed to resolve: ${(err as Error).message}`);
        }
    }

    return { ok: errors.length === 0, errors };
}

export function isPathHardDenied(path: string): boolean {
    // Darwin (APFS) and Windows (NTFS) are case-insensitive by default — a literal
    // `.includes("/etc/passwd")` against the user-supplied path lets `/etc/PASSWD`
    // through as a bypass. Lowercase both sides on those platforms.
    const compareTarget = process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;
    return HARD_DENY_SUBSTRINGS.some((s) => compareTarget.includes(s.toLowerCase()));
}

export function asJSON(caps: Capabilities): string {
    return JSON.stringify(caps, null, 2);
}
