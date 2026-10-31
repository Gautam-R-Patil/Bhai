// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { Capabilities } from "./capabilities.js";
import { parseCapabilities, validateCapabilities } from "./capabilities.js";
import type { PersistedToolManifest } from "./types.js";
import { getBhaiHome } from "../config/paths.js";

const SLUG_REGEX = /^[a-z][a-z0-9_]*$/;

export function getDynamicStoreDir(): string {
    return join(getBhaiHome(), "store", "dynamic");
}

export function manifestDir(slug: string): string {
    if (typeof slug !== "string" || slug.length === 0 || !SLUG_REGEX.test(slug)) {
        throw new Error(`invalid slug: ${JSON.stringify(slug)}`);
    }
    // Defensive: SLUG_REGEX already excludes /, \, ., but be explicit so the
    // intent is obvious to future readers of this guard.
    if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
        throw new Error(`invalid slug: ${JSON.stringify(slug)}`);
    }
    return join(getDynamicStoreDir(), slug);
}

function manifestPath(slug: string): string {
    return join(manifestDir(slug), "manifest.json");
}

export type ManifestValidationResult = { ok: true; manifest: PersistedToolManifest } | { ok: false; errors: string[] };

function isFiniteNonNegativeNumber(n: unknown): n is number {
    return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

export function validateManifest(raw: unknown): ManifestValidationResult {
    const errors: string[] = [];

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, errors: ["manifest must be a non-null object"] };
    }
    const o = raw as Record<string, unknown>;

    if (typeof o.slug !== "string" || !SLUG_REGEX.test(o.slug)) {
        errors.push("slug missing or fails /^[a-z][a-z0-9_]*$/");
    }
    if (typeof o.description !== "string" || o.description.length === 0) {
        errors.push("description missing or empty");
    }
    if (typeof o.version !== "string" || o.version.length === 0) {
        errors.push("version missing or not a string");
    }
    if (!isFiniteNonNegativeNumber(o.approvedAt)) {
        errors.push("approvedAt must be a finite non-negative number (ms epoch)");
    }
    if (typeof o.userQuote !== "string") {
        errors.push("userQuote missing or not a string");
    }
    if (typeof o.handlerHash !== "string" || !/^[0-9a-f]{16}$/.test(o.handlerHash)) {
        errors.push("handlerHash must be 16 lowercase hex chars (sha256 prefix)");
    }
    if (!o.parametersSchema || typeof o.parametersSchema !== "object" || Array.isArray(o.parametersSchema)) {
        errors.push("parametersSchema must be a JSON object");
    }

    const caps: Capabilities = parseCapabilities(o.capabilities);
    const capCheck = validateCapabilities(caps);
    if (!capCheck.ok) {
        for (const e of capCheck.errors) errors.push(`capabilities: ${e}`);
    }

    if (errors.length > 0) return { ok: false, errors };

    return {
        ok: true,
        manifest: {
            slug: o.slug as string,
            description: o.description as string,
            capabilities: caps,
            parametersSchema: o.parametersSchema as Record<string, unknown>,
            version: o.version as string,
            approvedAt: o.approvedAt as number,
            userQuote: o.userQuote as string,
            handlerHash: o.handlerHash as string,
        },
    };
}

export function readManifest(slug: string): PersistedToolManifest | null {
    let path: string;
    try {
        path = manifestPath(slug);
    } catch {
        return null;
    }
    if (!existsSync(path)) return null;

    let raw: string;
    try {
        raw = readFileSync(path, "utf-8");
    } catch {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    const result = validateManifest(parsed);
    if (!result.ok) return null;
    // Defence-in-depth: the on-disk slug must match the directory we read from.
    // Caller intent says "give me <slug>'s manifest" — if the file has been
    // tampered to claim a different slug, that's suspicious and we refuse.
    if (result.manifest.slug !== slug) return null;
    return result.manifest;
}

export async function writeManifest(slug: string, manifest: PersistedToolManifest): Promise<void> {
    // Validate-and-serialize FIRST, so an invalid input never touches disk.
    const check = validateManifest(manifest);
    if (!check.ok) {
        throw new Error(`refusing to write invalid manifest: ${check.errors.join("; ")}`);
    }
    if (check.manifest.slug !== slug) {
        throw new Error(`manifest slug "${check.manifest.slug}" != requested slug "${slug}"`);
    }
    const serialized = JSON.stringify(manifest, null, 2);
    const bytes = Buffer.byteLength(serialized, "utf-8");
    if (bytes > 64 * 1024) throw new Error(`manifest too large: ${bytes} bytes (cap 64KB)`);

    const dir = manifestDir(slug);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const path = manifestPath(slug);
    // lockfile needs the target to exist for advisory locking.
    if (!existsSync(path)) writeFileSync(path, "{}", "utf-8");

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const release = await lockfile.lock(path, {
                realpath: false,
                retries: { retries: 3, minTimeout: 100, maxTimeout: 100 },
            });
            try {
                // Atomic write: tmp file + rename. POSIX guarantees rename(2)
                // is atomic on the same filesystem, so a concurrent reader sees
                // EITHER the old contents or the new — never a partial buffer.
                const tmpPath = `${path}.tmp`;
                writeFileSync(tmpPath, serialized, "utf-8");
                renameSync(tmpPath, path);
            } finally {
                await release();
            }
            return;
        } catch (err) {
            lastErr = err;
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    throw new Error(
        `writeManifest(${slug}) failed after 3 lock attempts: ${(lastErr as Error | null)?.message ?? "unknown"}`,
    );
}
