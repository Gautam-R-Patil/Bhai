// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LLMClient } from "../llm.js";
import { selectForToolSynthesis } from "../model-router.js";
import type { FunctionGemmaResult } from "../models/function-gemma.js";
import { closeLibrary, countTools, getToolBySlug, insertTool, listTools, openLibrary } from "./library.js";
import { lookupTool as runLookupPipeline } from "./lookup.js";
import { migrateLegacyDynamicTools } from "./migration.js";
import { buildSynthesisPrompt } from "./prompt-builder.js";
import { emitForgeEvent, initForgeTelemetry } from "./telemetry.js";
import type { ForgeStats, SynthesisRequest, SynthesisResult, ToolMetadata } from "./types.js";
import { runVerifier } from "./verifier.js";

type FunctionGemmaFn = (
    query: string,
    toolSchemas: Array<{ name: string; description: string; parameters: string[] }>,
) => Promise<FunctionGemmaResult | null>;

const FORGE_SYSTEM_PROMPT =
    "You are ATLAS's tool-synthesis engine. Produce a JSON object with handler_code, tests, capabilities_declared, side_effects, synthesis_notes. Return ONLY the JSON.";

let _ready = false;
let _embedFn: ((text: string) => Promise<Float32Array>) | null = null;
let _llmClient: LLMClient | null = null;

function atlasHome(): string {
    return process.env.ATLAS_HOME ?? join(homedir(), ".atlas");
}

function hashSync(s: string): string {
    return createHash("sha256").update(s).digest("hex").substring(0, 16);
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

export function setForgeLLM(llm: LLMClient): void {
    _llmClient = llm;
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

async function loadFunctionGemmaFn(): Promise<FunctionGemmaFn | undefined> {
    try {
        return (await import("../models/function-gemma.js")).routeWithFunctionGemma;
    } catch {
        return undefined;
    }
}

export async function lookupTool(description: string, _schema: Record<string, unknown>): Promise<ToolMetadata | null> {
    if (!_ready || !_embedFn) return null;

    const fgFn = await loadFunctionGemmaFn();

    const hit = await runLookupPipeline({
        description,
        embedFn: _embedFn,
        functionGemmaFn: fgFn,
    });
    if (!hit) return null;
    return getToolBySlug(hit.slug);
}

export async function synthesizeTool(req: SynthesisRequest): Promise<SynthesisResult> {
    if (!_ready) {
        return {
            kind: "failed",
            report: {
                requestedName: req.name,
                description: req.description,
                attempts: 0,
                finalDiagnosis: "forge not ready",
                failureReason: "exhausted_attempts",
                reportPath: "",
            },
        };
    }

    if (process.env.ATLAS_NO_FORGE_LOOKUP !== "true" && _embedFn) {
        const fgFn = await loadFunctionGemmaFn();
        const hit = await runLookupPipeline({
            description: req.description,
            embedFn: _embedFn,
            functionGemmaFn: fgFn,
        });
        if (hit) {
            return {
                kind: "lookup_hit",
                slug: hit.slug,
                reusedFrom: { matchSimilarity: hit.matchSimilarity, source: hit.source },
            };
        }
    }

    if (process.env.ATLAS_FORGE_STUB_LLM === "true") {
        return await synthesizeWithStubLLM(req);
    }

    if (process.env.ATLAS_NO_FORGE_VERIFIER === "true") {
        return await synthesizeWithStubLLM(req);
    }

    if (!_llmClient) {
        return {
            kind: "failed",
            report: {
                requestedName: req.name,
                description: req.description,
                attempts: 0,
                finalDiagnosis: "LLM client not configured",
                failureReason: "exhausted_attempts",
                reportPath: "",
            },
        };
    }

    const home = atlasHome();
    const failedDir = join(home, "store", "dynamic", "_failed");

    const modelSel = selectForToolSynthesis(req.source === "dream_replay");

    const prompt = buildSynthesisPrompt({
        name: req.name,
        description: req.description,
        parametersSchema: req.parametersSchema,
        exemplars: [],
        trackB: req.source === "dream_replay",
        patternClass: req.patternClass,
        evidenceSummary: undefined,
    });

    const maxAttempts = req.source === "dream_replay" ? 10 : 3;

    const llm = _llmClient;
    const llmFn = async (p: string): Promise<string> => {
        const response = await llm.chat({
            messages: [{ role: "user", content: p }],
            systemPrompt: FORGE_SYSTEM_PROMPT,
            modelOverride: modelSel.modelId,
            thinkingLevel: modelSel.thinkingLevel,
            responseFormat: "json_object",
        });
        return response?.choices?.[0]?.message?.content ?? "";
    };

    const result = await runVerifier({
        slug: req.name,
        initialPrompt: prompt,
        llmFn,
        maxAttempts,
        failedReportDir: failedDir,
    });

    if (!result.ok) {
        return {
            kind: "failed",
            report: {
                requestedName: req.name,
                description: req.description,
                attempts: result.attempts,
                finalDiagnosis: `verifier ${result.failureReason} after ${result.attempts} attempts; see ${result.reportPath}`,
                failureReason: result.failureReason,
                reportPath: result.reportPath,
            },
        };
    }

    if (!_embedFn) throw new Error("embedFn not set");
    const embedding = await _embedFn(req.description);
    try {
        insertTool({
            slug: req.name,
            description: req.description,
            schemaJson: JSON.stringify(req.parametersSchema),
            handlerHash: hashSync(result.envelope.handler_code),
            embedding,
            source: req.source,
            originIntent: req.originIntent,
            createdAt: Date.now(),
        });
    } catch (err) {
        return {
            kind: "failed",
            report: {
                requestedName: req.name,
                description: req.description,
                attempts: result.attempts,
                finalDiagnosis: `library insert failed: ${(err as Error).message}`,
                failureReason: "exhausted_attempts",
                reportPath: "",
            },
        };
    }

    return {
        kind: "synthesized",
        slug: req.name,
        attempts: result.attempts,
        testsPassed: result.envelope.tests.length,
        testsTotal: result.envelope.tests.length,
    };
}

async function synthesizeWithStubLLM(req: SynthesisRequest): Promise<SynthesisResult> {
    if (!_embedFn) throw new Error("embedFn not set");
    const embedding = await _embedFn(req.description);
    try {
        insertTool({
            slug: req.name,
            description: req.description,
            schemaJson: JSON.stringify(req.parametersSchema),
            handlerHash: "stub",
            embedding,
            source: req.source,
            originIntent: req.originIntent,
            createdAt: Date.now(),
        });
    } catch (err) {
        return {
            kind: "failed",
            report: {
                requestedName: req.name,
                description: req.description,
                attempts: 1,
                finalDiagnosis: `library insert failed: ${(err as Error).message}`,
                failureReason: "exhausted_attempts",
                reportPath: "",
            },
        };
    }
    return { kind: "synthesized", slug: req.name, attempts: 1, testsPassed: 1, testsTotal: 1 };
}

export async function approveDynamicTool(_slug: string, _userQuote: string): Promise<void> {
    throw new Error("forge.approveDynamicTool: not implemented until phase 4 (sandbox + approval gate)");
}

export async function revokeDynamicTool(_slug: string): Promise<void> {
    throw new Error("forge.revokeDynamicTool: not implemented until phase 4");
}

interface PendingQueue {
    candidates: Array<SynthesisRequest & { queuedAt: number }>;
    lastUpdated: number;
}

function pendingPath(): string {
    return join(atlasHome(), "data", "forge-pending.json");
}

function loadPending(): PendingQueue {
    const p = pendingPath();
    if (!existsSync(p)) return { candidates: [], lastUpdated: 0 };
    try {
        return JSON.parse(readFileSync(p, "utf-8"));
    } catch {
        return { candidates: [], lastUpdated: 0 };
    }
}

function savePending(q: PendingQueue): void {
    const p = pendingPath();
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    q.lastUpdated = Date.now();
    writeFileSync(p, JSON.stringify(q, null, 2));
}

export async function queueSynthesisCandidate(req: SynthesisRequest): Promise<void> {
    if (!_ready) return;
    const q = loadPending();
    if (q.candidates.some((c) => c.description === req.description)) return;
    q.candidates.push({ ...req, queuedAt: Date.now() });
    savePending(q);
}

export function consumeNextPendingCandidate(): SynthesisRequest | null {
    if (!_ready) return null;
    const q = loadPending();
    const next = q.candidates.shift();
    if (!next) return null;
    savePending(q);
    const { queuedAt: _queuedAt, ...req } = next;
    return req;
}

export async function runDreamReplaySynthesis(_window: { from: number; to: number }): Promise<unknown> {
    throw new Error("forge.runDreamReplaySynthesis: not implemented until phase 6 (dream-replay)");
}

export function shutdownForge(): void {
    closeLibrary();
    _ready = false;
}
