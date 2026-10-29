// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Centralized SSRF guard. Two layers:
//   1. isAlwaysBlockedUrl — non-negotiable cloud-metadata floor. Blocked even
//      if a future "allow private hosts" escape hatch is added. Pure-sync, no DNS.
//   2. isSafeUrl — scheme allowlist + DNS resolution of all addresses; rejects
//      any private/loopback/link-local/CGNAT target. FAIL-CLOSED on DNS error.

import dns from "node:dns/promises";
import { Agent } from "undici";

// Cloud-provider instance-metadata endpoints. These are the highest-value SSRF
// targets (credential exfil) and stay blocked regardless of other config.
const METADATA_IPS = new Set([
    "169.254.169.254", // AWS / GCP / Azure / DigitalOcean IMDS
    "169.254.170.2", // AWS ECS task metadata
    "169.254.169.253", // AWS VPC DNS
    "100.100.100.200", // Alibaba Cloud
    "fd00:ec2::254", // AWS IMDS over IPv6
]);

const METADATA_HOSTNAMES = new Set([
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
    "metadata.azure.com",
]);

function normalizeHost(host: string): string {
    return host
        .toLowerCase()
        .trim()
        .replace(/^\[|\]$/g, "");
}

// Strip an ::ffff: IPv4-mapped prefix to its dotted-quad inner address. Handles
// both the dotted form (::ffff:127.0.0.1) and the hex form the WHATWG URL parser
// canonicalizes bracketed literals into (::ffff:7f00:1) — without decoding the
// latter, a mapped private/metadata literal slips past the v4 checks.
function stripMappedV4(addr: string): string | null {
    const dotted = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) return dotted[1];
    const hex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
        const hi = parseInt(hex[1], 16);
        const lo = parseInt(hex[2], 16);
        return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
    return null;
}

/**
 * Non-negotiable cloud-metadata floor. Synchronous, no DNS. Returns true for
 * any literal metadata IP (incl. ::ffff: mapped form) or metadata hostname.
 */
export function isAlwaysBlockedUrl(url: string): boolean {
    let host: string;
    try {
        host = normalizeHost(new URL(url).hostname);
    } catch {
        return false;
    }
    if (!host) return false;
    if (METADATA_HOSTNAMES.has(host)) return true;
    if (METADATA_IPS.has(host)) return true;
    const mapped = stripMappedV4(host);
    if (mapped && METADATA_IPS.has(mapped)) return true;
    return false;
}

function isPrivateIPv4(ip: string): boolean {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast + reserved
    return false;
}

function isPrivateIPv6(ip: string): boolean {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (
        lower.startsWith("fe80:") ||
        lower.startsWith("fe8") ||
        lower.startsWith("fe9") ||
        lower.startsWith("fea") ||
        lower.startsWith("feb")
    )
        return true; // link-local fe80::/10
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    const mapped = stripMappedV4(lower);
    if (mapped && isPrivateIPv4(mapped)) return true;
    return false;
}

function isBlockedIp(addr: string): boolean {
    const host = normalizeHost(addr);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIPv4(host);
    if (host.includes(":")) return isPrivateIPv6(host);
    return false;
}

export interface UrlSafetyResult {
    safe: boolean;
    reason?: string;
    /** The vetted address to connect to (pin this so the fetch can't re-resolve). */
    address?: string;
    family?: number;
}

/**
 * Resolve `url`'s host and refuse if the scheme is non-http(s), the host is a
 * metadata target, or ANY resolved address is private/loopback/link-local/CGNAT.
 * Fail-closed: a DNS-resolution failure returns { safe: false }.
 */
export async function isSafeUrl(url: string): Promise<UrlSafetyResult> {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return { safe: false, reason: "invalid URL" };
    }

    const proto = u.protocol.toLowerCase();
    if (proto !== "http:" && proto !== "https:") return { safe: false, reason: `blocked protocol: ${proto}` };

    const host = normalizeHost(u.hostname);
    if (!host) return { safe: false, reason: "empty host" };

    if (isAlwaysBlockedUrl(url)) return { safe: false, reason: `blocked metadata target: ${host}` };
    if (METADATA_HOSTNAMES.has(host)) return { safe: false, reason: `blocked hostname: ${host}` };
    if (host === "localhost") return { safe: false, reason: "blocked hostname: localhost" };
    if (host.endsWith(".local") || host.endsWith(".internal"))
        return { safe: false, reason: `blocked suffix: ${host}` };

    // Literal IPs — no DNS needed.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        if (isPrivateIPv4(host)) return { safe: false, reason: `blocked private IPv4: ${host}` };
        return { safe: true, address: host, family: 4 };
    }
    if (host.includes(":")) {
        if (isPrivateIPv6(host)) return { safe: false, reason: `blocked private IPv6: ${host}` };
        return { safe: true, address: host, family: 6 };
    }

    // Hostname — resolve and verify EVERY address is public. Fail-closed on error.
    // Return the first vetted address so the caller can PIN it (connecting to a
    // re-resolved host would reopen a DNS-rebinding TOCTOU window).
    try {
        const records = await dns.lookup(host, { all: true, verbatim: true });
        for (const r of records) {
            if (isBlockedIp(r.address)) {
                return { safe: false, reason: `blocked via DNS to private address: ${r.address}` };
            }
        }
        const first = records[0];
        return first ? { safe: true, address: first.address, family: first.family } : { safe: true };
    } catch (err) {
        return { safe: false, reason: `DNS lookup failed: ${(err as Error).message}` };
    }
}

/**
 * Build a DNS `lookup` that only resolves `host` and only to the pre-vetted
 * `address` (re-validated at connect time). Passed to undici so the socket
 * connects to exactly the IP we checked — defeating DNS-rebinding TOCTOU where
 * the fetch's own re-resolution returns a private/metadata IP. TLS SNI and cert
 * validation still use the original hostname.
 */
export function pinnedLookup(host: string, address: string, family: number) {
    const fam = family === 6 ? 6 : 4;
    return (hostname: string, options: unknown, callback: (...args: unknown[]) => void): void => {
        if (normalizeHost(hostname) !== host || isBlockedIp(address)) {
            callback(new Error(`SSRF guard: refusing to resolve ${hostname}`));
            return;
        }
        if (options && typeof options === "object" && (options as { all?: boolean }).all) {
            callback(null, [{ address, family: fam }]);
        } else {
            callback(null, address, fam);
        }
    };
}

function pinnedDispatcher(host: string, address: string, family: number): Agent {
    return new Agent({
        // Short keep-alive: the per-request Agent is single-use, close sockets fast.
        keepAliveTimeout: 1,
        keepAliveMaxTimeout: 1,
        connect: { lookup: pinnedLookup(host, address, family) as never },
    });
}

/**
 * Follow up to `maxHops` HTTP redirects, re-validating each hop against the SSRF
 * guard before fetching. Returns the final non-redirect Response, or an error.
 * Caller owns the AbortController/timeout (passed via `init`).
 */
export async function fetchWithRedirectGuard(
    url: string,
    init: RequestInit,
    maxHops = 5,
): Promise<{ response: Response; finalUrl: string } | { error: string }> {
    let currentUrl = url;
    let hop = 0;
    while (true) {
        if (isAlwaysBlockedUrl(currentUrl)) return { error: `SSRF guard: blocked metadata target` };
        const check = await isSafeUrl(currentUrl);
        if (!check.safe) return { error: `SSRF guard: ${check.reason}` };

        // Pin the vetted IP so undici connects to exactly what we validated
        // instead of performing its own (re-)resolution of the hostname.
        const host = normalizeHost(new URL(currentUrl).hostname);
        const dispatcher = check.address
            ? pinnedDispatcher(host, check.address, check.family ?? 4)
            : undefined;

        const response = await fetch(currentUrl, { ...init, redirect: "manual", dispatcher } as RequestInit);
        if (response.status >= 300 && response.status < 400) {
            const loc = response.headers.get("location");
            if (!loc) return { response, finalUrl: currentUrl };
            // This hop's body is discarded; close its sockets now instead of
            // churning a short-lived Agent per hop across a 500-source run. The
            // FINAL response's dispatcher is left to self-close (keepAliveTimeout:1)
            // so the caller can still read its body.
            void (dispatcher as Agent | undefined)?.destroy?.();
            if (++hop > maxHops) return { error: `Too many redirects (>${maxHops})` };
            currentUrl = new URL(loc, currentUrl).toString();
            continue;
        }
        return { response, finalUrl: currentUrl };
    }
}

/**
 * Why the agent's browser may not open `url`, or null when it may: only http(s) (and the
 * blank page). A prompt-injected page could otherwise send it to file:///…/.ssh/id_rsa or
 * the token file (local read into the model's context) or javascript: (script in a live
 * logged-in tab). Every way the agent opens a URL calls this — not only browser_navigate.
 */
export function unsafeBrowserUrl(url: string): string | null {
    const raw = String(url ?? "").trim();
    if (raw === "about:blank") return null;
    let scheme: string;
    try {
        scheme = new URL(raw).protocol.toLowerCase();
    } catch {
        return `invalid url: ${raw.slice(0, 120)}`;
    }
    return scheme === "http:" || scheme === "https:" ? null : `unsafe URL scheme "${scheme}" — only http(s) is allowed`;
}

