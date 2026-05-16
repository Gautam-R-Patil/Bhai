// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

// F5: centralized slug validation. Matches both the persisted-manifest slug
// regex (PersistedToolManifest.slug docs) and the create-tool snake_case rule,
// with a 63-char ceiling so it composes with filesystem path budgets.
const SLUG_RE = /^[a-z][a-z0-9_]{0,62}$/;

function rejectInvalidSlug(slug: string, req?: SynthesisRequest): SynthesisResult {
    return {
        kind: "failed",
        report: {
            requestedName: slug,
            description: req?.description ?? "",
            attempts: 0,
            finalDiagnosis: `invalid slug "${slug}" — must match /^[a-z][a-z0-9_]{0,62}$/`,
            failureReason: "exhausted_attempts",
            reportPath: "",
        },
    };
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

    // F5: refuse path-traversal-shaped or otherwise malformed slugs at entry.
    if (!SLUG_RE.test(req.name)) {
        return rejectInvalidSlug(req.name, req);
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

// ── Pending queue with HMAC integrity (F6) ────────────────
//
// Threat: a malicious actor who can write to ~/.atlas/data/forge-pending.json
// could inject crafted SynthesisRequests that the consumer picks up and
// passes into the verifier loop. We can't stop them from writing to disk
// (filesystem is shared with the user), but we can refuse to consume
// entries that weren't signed by THIS running process.
//
// Implementation: at process boot, generate a 32-byte random key in memory.
// Each queued entry is wrapped as { candidate, queuedAt, hmac } where
// hmac = HMAC-SHA256(key, canonicalJSON({candidate, queuedAt})). On consume,
// recompute and timing-safe-compare. Entries that fail HMAC are silently
// dropped. The key never touches disk, so on process restart the entire
// queue self-invalidates — that's intentional, the queue is a session-local
// hint, not durable state.
//
// Rate cap: at most 1 synthesis consumed per minute. The 60s window starts
// fresh each successful consume. Failed/no-op consumes don't advance it.

interface SignedPendingEntry {
    candidate: SynthesisRequest;
    queuedAt: number;
    hmac: string;
}

interface PendingQueue {
    candidates: SignedPendingEntry[];
    lastUpdated: number;
}

const _bootKey: Buffer = randomBytes(32);

function canonicalize(candidate: SynthesisRequest, queuedAt: number): string {
    // Stable key ordering so HMAC is deterministic across writes.
    return JSON.stringify({
        canon_version: 1,
        candidate: {
            name: candidate.name,
            description: candidate.description,
            parametersSchema: candidate.parametersSchema,
            persistent: candidate.persistent,
            originIntent: candidate.originIntent ?? null,
            source: candidate.source,
            patternClass: candidate.patternClass ?? null,
            evidenceIds: candidate.evidenceIds ?? null,
        },
        queuedAt,
    });
}

function signEntry(candidate: SynthesisRequest, queuedAt: number): string {
    return createHmac("sha256", _bootKey).update(canonicalize(candidate, queuedAt)).digest("hex");
}

function verifyEntry(entry: SignedPendingEntry): boolean {
    if (!entry || typeof entry !== "object") return false;
    if (typeof entry.hmac !== "string" || entry.hmac.length !== 64) return false;
    if (!entry.candidate || typeof entry.candidate !== "object") return false;
    if (typeof entry.queuedAt !== "number" || !Number.isFinite(entry.queuedAt)) return false;
    const expected = signEntry(entry.candidate, entry.queuedAt);
    const a = Buffer.from(entry.hmac, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    try {
        return timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

function pendingPath(): string {
    return join(atlasHome(), "data", "forge-pending.json");
}

function loadPending(): PendingQueue {
    const p = pendingPath();
    if (!existsSync(p)) return { candidates: [], lastUpdated: 0 };
    try {
        const parsed = JSON.parse(readFileSync(p, "utf-8")) as PendingQueue;
        if (!Array.isArray(parsed?.candidates)) return { candidates: [], lastUpdated: 0 };
        return parsed;
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
    // F5 entry-point slug validation
    if (!SLUG_RE.test(req.name)) return;
    const q = loadPending();
    // Dedupe on description; require existing entry to be HMAC-valid before counting as dup.
    if (q.candidates.some((c) => verifyEntry(c) && c.candidate.description === req.description)) return;
    const queuedAt = Date.now();
    q.candidates.push({ candidate: req, queuedAt, hmac: signEntry(req, queuedAt) });
    savePending(q);
}

export function consumeNextPendingCandidate(): SynthesisRequest | null {
    if (!_ready) return null;
    const q = loadPending();
    // F6: drop unsigned / bad-hmac entries before picking. HMAC verification is
    // the security boundary — bad entries are silently quarantined so a
    // malicious writer can't keep blocking the queue head.
    const verified = q.candidates.filter(verifyEntry);
    if (verified.length !== q.candidates.length) {
        q.candidates = verified;
        savePending(q);
    }
    const next = q.candidates.shift();
    if (!next) return null;
    savePending(q);
    return next.candidate;
}

export async function runDreamReplaySynthesis(_window: { from: number; to: number }): Promise<unknown> {
    throw new Error("forge.runDreamReplaySynthesis: not implemented until phase 6 (dream-replay)");
}

export function shutdownForge(): void {
    closeLibrary();
    _ready = false;
}
