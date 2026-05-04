// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Atomic I/O + URL/env helpers ───────────────
//  - atomicReplace preserves symlinks (no silent detachment from dotfile links)
//  - atomicTextWrite / atomicJsonWrite use temp file + fsync + rename
//  - baseUrlHostMatches kills substring false-positives on host matching
//  - normalizeProxyUrl upgrades socks:// → socks5:// for aiohttp-compat clients
//  - isTruthy / envInt / envBool / safeJsonParse consolidate duplicated sites

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── Atomic file writes ──────────────────────────

/**
 * Rename `tmpPath` onto `target` atomically. When `target` is a symlink, the
 * symlink is followed and the rename lands on the real file, so managed
 * deployments that symlink state files out to a git-tracked dotfiles repo
 * don't get silently detached.
 * Returns the absolute realpath that received the write.
 */
export async function atomicReplace(
    tmpPath: string,
    target: string,
): Promise<string> {
    let realTarget = target;
    try {
        const lst = await fs.promises.lstat(target);
        if (lst.isSymbolicLink()) {
            const pointee = await fs.promises.readlink(target);
            realTarget = path.isAbsolute(pointee)
                ? pointee
                : path.resolve(path.dirname(target), pointee);
        }
    } catch {
        // target does not exist yet; rename onto the original path
    }
    await fs.promises.rename(tmpPath, realTarget);
    try {
        return await fs.promises.realpath(realTarget);
    } catch {
        return path.resolve(realTarget);
    }
}

async function capturePermissions(p: string): Promise<number | null> {
    try {
        const st = await fs.promises.stat(p);
        return st.mode & 0o777;
    } catch {
        return null;
    }
}

async function restorePermissions(
    p: string,
    mode: number | null,
): Promise<void> {
    if (mode == null) return;
    try {
        await fs.promises.chmod(p, mode);
    } catch {
        /* best-effort */
    }
}

/**
 * Atomic text write: write to `$target.$hex.tmp` in the same directory, fsync,
 * then `atomicReplace` into place. Preserves pre-existing file permissions.
 * Creates parent directories if missing.
 */
export async function atomicTextWrite(
    target: string,
    content: string,
): Promise<void> {
    const dir = path.dirname(target);
    await fs.promises.mkdir(dir, { recursive: true });

    const originalMode = await capturePermissions(target);
    const token = crypto.randomBytes(6).toString("hex");
    const tmp = path.join(dir, `.${path.basename(target)}.${token}.tmp`);

    const handle = await fs.promises.open(tmp, "w");
    try {
        await handle.writeFile(content, "utf8");
        // Best-effort fsync so a crash between write and rename doesn't corrupt.
        try {
            await handle.sync();
        } catch {
            /* fsync unsupported on some FSes — ignore */
        }
    } finally {
        await handle.close();
    }

    try {
        const resolved = await atomicReplace(tmp, target);
        await restorePermissions(resolved, originalMode);
    } catch (err) {
        // Temp file cleanup on rename failure
        try {
            await fs.promises.unlink(tmp);
        } catch {
            /* may already be gone */
        }
        throw err;
    }
}

export interface AtomicJsonWriteOptions {
    indent?: number;
}

/**
 * Atomic JSON write. Serializes with `JSON.stringify(data, null, indent)` and
 * appends a trailing newline (POSIX-friendly, cleaner diffs).
 */
export async function atomicJsonWrite(
    target: string,
    data: unknown,
    options: AtomicJsonWriteOptions = {},
): Promise<void> {
    const indent = options.indent ?? 2;
    const payload = `${JSON.stringify(data, null, indent)}\n`;
    await atomicTextWrite(target, payload);
}

// ── URL host helpers ───────────────────────────

/**
 * Return the lowercased hostname of a URL (or bare host string), or empty
 * string when absent. Trailing dots are stripped. Use this instead of
 * substring-matching on the raw URL to avoid the attacker-controlled-path
 * class of false positives.
 */
export function baseUrlHost(input: string | null | undefined): string {
    const raw = (input ?? "").trim();
    if (!raw) return "";
    let candidate = raw;
    if (!/^[a-z][a-z0-9+\-.]*:\/\//i.test(candidate)) {
        candidate = `http://${candidate}`;
    }
    try {
        const u = new URL(candidate);
        return u.hostname.toLowerCase().replace(/\.+$/, "");
    } catch {
        return "";
    }
}

/**
 * Return true when `baseUrl`'s hostname is exactly `domain` OR a subdomain.
 * `"https://api.moonshot.ai/v1"` ∈ `"moonshot.ai"` → true.
 * `"https://evil.com/moonshot.ai/v1"` ∈ `"moonshot.ai"` → false.
 * `"https://moonshot.ai.evil/v1"` ∈ `"moonshot.ai"` → false.
 */
export function baseUrlHostMatches(
    baseUrl: string | null | undefined,
    domain: string | null | undefined,
): boolean {
    const host = baseUrlHost(baseUrl);
    if (!host) return false;
    const needle = (domain ?? "").trim().toLowerCase().replace(/\.+$/, "");
    if (!needle) return false;
    return host === needle || host.endsWith(`.${needle}`);
}

// ── Proxy URL normalization ────────────────────

/**
 * WSL/Clash-style envs often export SOCKS proxies as `socks://host:port`.
 * httpx (and Node's `undici` through `ProxyAgent`) reject that alias and
 * require the explicit `socks5://` scheme. Rewrite it; leave http(s)/socks5
 * alone. Returns `null` for empty input.
 */
export function normalizeProxyUrl(
    url: string | null | undefined,
): string | null {
    const candidate = (url ?? "").trim();
    if (!candidate) return null;
    if (/^socks:\/\//i.test(candidate)) {
        return `socks5://${candidate.slice("socks://".length)}`;
    }
    return candidate;
}

// ── Truthy / env var helpers ───────────────────

const TRUTHY_STRINGS = new Set(["1", "true", "yes", "on"]);

export function isTruthy(
    value: unknown,
    defaultValue: boolean = false,
): boolean {
    if (value === null || value === undefined) return defaultValue;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        return TRUTHY_STRINGS.has(value.trim().toLowerCase());
    }
    return Boolean(value);
}

export function envInt(key: string, defaultValue: number): number {
    const raw = (process.env[key] ?? "").trim();
    if (!raw) return defaultValue;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : defaultValue;
}

export function envBool(key: string, defaultValue: boolean): boolean {
    const raw = process.env[key];
    if (raw === undefined) return defaultValue;
    return isTruthy(raw, defaultValue);
}

// ── JSON parse helper ──────────────────────────

/**
 * Parse JSON, returning `defaultValue` on any error. Collapses the repeated
 * try/catch pattern across tools that receive LLM-produced JSON strings.
 */
export function safeJsonParse<T>(text: string, defaultValue: T): T {
    if (typeof text !== "string") return defaultValue;
    try {
        return JSON.parse(text) as T;
    } catch {
        return defaultValue;
    }
}
