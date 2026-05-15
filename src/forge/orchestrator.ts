// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { homedir } from "node:os";
import { join } from "node:path";
import { closeLibrary, countTools, getToolBySlug, listTools, openLibrary } from "./library.js";
import { lookupTool as runLookupPipeline } from "./lookup.js";
import { migrateLegacyDynamicTools } from "./migration.js";
import { emitForgeEvent, initForgeTelemetry } from "./telemetry.js";
import type { ForgeStats, SynthesisRequest, SynthesisResult, ToolMetadata } from "./types.js";

let _ready = false;
let _embedFn: ((text: string) => Promise<Float32Array>) | null = null;

function atlasHome(): string {
    return process.env.ATLAS_HOME ?? join(homedir(), ".atlas");
}

export interface InitForgeOpts {
    embedFn: (text: string) => Promise<Float32Array>;
}

export async function initForge(opts: InitForgeOpts): Promise<void> {
    if (process.env.ATLAS_NO_FORGE === "true") {
        console.log("🔧 Forge: disabled via ATLAS_NO_FORGE");
        return;
    }

    const start = Date.now();
    _embedFn = opts.embedFn;

    try {
        const home = atlasHome();
        const libraryPath = join(home, "data", "skill-library.db");
        const telemetryPath = join(home, "data", "forge-telemetry.jsonl");

        initForgeTelemetry(telemetryPath);
        openLibrary(libraryPath);

        const legacyDir = join(home, "dynamic-tools");
        const dynamicStoreDir = join(home, "store", "dynamic");
        const migration = await migrateLegacyDynamicTools({
            legacyDir,
            dynamicStoreDir,
            embedFn: opts.embedFn,
        });

        const counts = countTools();
        emitForgeEvent({
            event: "forge_boot",
            ts: Date.now(),
            libraryRows: counts.total,
            manifestEntries: counts.total,
            bootMs: Date.now() - start,
        });

        _ready = true;
        console.log(`🔧 Forge: ready (${counts.total} tools in library, migrated ${migration.migrated} legacy)`);
    } catch (err) {
        console.error("🔧 Forge: init failed:", (err as Error).message);
        _ready = false;
    }
}

export function isForgeReady(): boolean {
    return _ready;
}

export function getForgeStats(): ForgeStats {
    if (!_ready) {
        return {
            libraryRows: 0,
            activeToolsCount: 0,
            archivedToolsCount: 0,
            graduatedSkillsCount: 0,
            publishedToolsCount: 0,
            todaySynthesisAttempts: 0,
            todaySynthesisSuccesses: 0,
            todayLookupHits: 0,
        };
    }
    const counts = countTools();
    return {
        libraryRows: counts.total,
        activeToolsCount: counts.active,
        archivedToolsCount: counts.archived,
        graduatedSkillsCount: counts.graduated,
        publishedToolsCount: counts.published,
        todaySynthesisAttempts: 0,
        todaySynthesisSuccesses: 0,
        todayLookupHits: 0,
    };
}

export function listDynamicTools(opts: { includeArchived?: boolean } = {}): ToolMetadata[] {
    if (!_ready) return [];
    return listTools(opts);
}

// ── Phase 2+ stubs ───────────────────────────────

export async function lookupTool(
    description: string,
    _schema: Record<string, unknown>,
): Promise<ToolMetadata | null> {
    if (!_ready || !_embedFn) return null;

    // FunctionGemma is opt-in via Ollama. Load lazily; if unavailable, lookupTool
    // falls through to FTS+cosine without the FunctionGemma fast-path.
    let fgFn: any | undefined;
    try {
        fgFn = (await import("../models/function-gemma.js")).routeWithFunctionGemma;
    } catch {
        fgFn = undefined;
    }

    const hit = await runLookupPipeline({
        description,
        embedFn: _embedFn,
        functionGemmaFn: fgFn,
    });
    if (!hit) return null;
    return getToolBySlug(hit.slug);
}

export async function synthesizeTool(_req: SynthesisRequest): Promise<SynthesisResult> {
    throw new Error("forge.synthesizeTool: not implemented until phase 3 (verifier)");
}

export async function approveDynamicTool(_slug: string, _userQuote: string): Promise<void> {
    throw new Error("forge.approveDynamicTool: not implemented until phase 4 (sandbox + approval gate)");
}

export async function revokeDynamicTool(_slug: string): Promise<void> {
    throw new Error("forge.revokeDynamicTool: not implemented until phase 4");
}

export async function queueSynthesisCandidate(_req: SynthesisRequest): Promise<void> {
    throw new Error("forge.queueSynthesisCandidate: not implemented until phase 3");
}

export async function runDreamReplaySynthesis(_window: { from: number; to: number }): Promise<unknown> {
    throw new Error("forge.runDreamReplaySynthesis: not implemented until phase 6 (dream-replay)");
}

export function shutdownForge(): void {
    closeLibrary();
    _ready = false;
}
