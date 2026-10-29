// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getToolBySlug, insertTool } from "./library.js";
import { emitForgeEvent } from "./telemetry.js";

const DEFAULT_LEGACY_DIR = join(homedir(), ".atlas", "dynamic-tools");
const DEFAULT_DYNAMIC_STORE_DIR = join(homedir(), ".atlas", "store", "dynamic");

interface LegacyToolFile {
    name: string;
    description: string;
    parameters_schema: Record<string, unknown>;
    handler_code: string;
    created_at?: string;
}

export interface MigrationOpts {
    legacyDir?: string;
    dynamicStoreDir?: string;
    embedFn: (text: string) => Promise<Float32Array>;
}

export interface MigrationResult {
    migrated: number;
    failed: number;
    alreadyMigrated: number;
    durationMs: number;
}

function hashHandler(code: string): string {
    return createHash("sha256").update(code.replace(/\s+/g, " ").trim()).digest("hex").substring(0, 16);
}

function looksLikeLegacy(parsed: unknown): parsed is LegacyToolFile {
    if (!parsed || typeof parsed !== "object") return false;
    const p = parsed as Record<string, unknown>;
    return typeof p.name === "string" && typeof p.description === "string" && typeof p.handler_code === "string";
}

async function writeArtifacts(toolDir: string, legacy: LegacyToolFile): Promise<void> {
    await fs.mkdir(toolDir, { recursive: true });
    await fs.writeFile(join(toolDir, "handler.js"), legacy.handler_code, "utf-8");
    await fs.writeFile(join(toolDir, "schema.json"), JSON.stringify(legacy.parameters_schema ?? {}, null, 2), "utf-8");
    await fs.writeFile(join(toolDir, "tests.json"), JSON.stringify([], null, 2), "utf-8");
    await fs.writeFile(
        join(toolDir, "metrics.json"),
        JSON.stringify(
            {
                invocations: 0,
                successes: 0,
                lastUsed: null,
                source: "migrated",
            },
            null,
            2,
        ),
        "utf-8",
    );
    await fs.writeFile(
        join(toolDir, "capabilities.json"),
        JSON.stringify(
            {
                fs_read: [],
                fs_write: [],
                net: [],
                exec: [],
            },
            null,
            2,
        ),
        "utf-8",
    );
}

export async function migrateLegacyDynamicTools(opts: MigrationOpts): Promise<MigrationResult> {
    const start = Date.now();
    const legacyDir = opts.legacyDir ?? DEFAULT_LEGACY_DIR;
    const dynamicStoreDir = opts.dynamicStoreDir ?? DEFAULT_DYNAMIC_STORE_DIR;

    let migrated = 0,
        failed = 0,
        alreadyMigrated = 0;

    if (!existsSync(legacyDir)) {
        return { migrated: 0, failed: 0, alreadyMigrated: 0, durationMs: Date.now() - start };
    }

    const files = await fs.readdir(legacyDir);
    for (const fname of files) {
        if (!fname.endsWith(".json")) continue;
        const fullPath = join(legacyDir, fname);
        try {
            const raw = await fs.readFile(fullPath, "utf-8");
            const parsed = JSON.parse(raw);
            if (!looksLikeLegacy(parsed)) {
                failed++;
                continue;
            }
            // F5: tighten to the same 63-char-ceiling slug rule used at synthesizeTool entry.
            if (!/^[a-z][a-z0-9_]{0,62}$/.test(parsed.name)) {
                failed++;
                continue;
            }

            const existing = getToolBySlug(parsed.name);
            if (existing) {
                alreadyMigrated++;
                continue;
            }

            const embedding = await opts.embedFn(parsed.description);
            await writeArtifacts(join(dynamicStoreDir, parsed.name), parsed);

            const createdAt = parsed.created_at ? new Date(parsed.created_at).getTime() : Date.now();
            insertTool({
                slug: parsed.name,
                description: parsed.description,
                schemaJson: JSON.stringify(parsed.parameters_schema ?? {}),
                handlerHash: hashHandler(parsed.handler_code),
                embedding,
                source: "migrated",
                originIntent: `migrated from legacy ${fname}`,
                createdAt,
            });
            migrated++;
        } catch {
            failed++;
        }
    }

    const durationMs = Date.now() - start;
    emitForgeEvent({
        event: "migration_completed",
        ts: Date.now(),
        migratedCount: migrated,
        failedCount: failed,
        durationMs,
    });
    return { migrated, failed, alreadyMigrated, durationMs };
}
