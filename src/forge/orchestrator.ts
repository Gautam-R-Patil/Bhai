// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LLMClient } from "../llm.js";
import { selectForToolSynthesis } from "../model-router.js";
import type { FunctionGemmaResult } from "../models/function-gemma.js";
import { getRegistryRef } from "../tools/create-tool.js";
import { parseCapabilities, type Capabilities } from "./capabilities.js";
import {
    closeLibrary,
    countTools,
    getToolBySlug,
    insertTool,
    listTools,
    openLibrary,
    setLifecycleState,
} from "./library.js";
import { lookupTool as runLookupPipeline } from "./lookup.js";
import { getDynamicStoreDir, manifestDir, readManifest, writeManifest } from "./manifest.js";
import { migrateLegacyDynamicTools } from "./migration.js";
import { buildSynthesisPrompt } from "./prompt-builder.js";
import {
    installPersistedTool,
    invokePersistedTool,
    reinstallPersistedTool,
    uninstallPersistedTool,
} from "./sandbox-supervisor.js";
import { emitForgeEvent, initForgeTelemetry } from "./telemetry.js";
import type {
    ForgeStats,
    PersistedToolManifest,
    SynthesisRequest,
    SynthesisResult,
    ToolMetadata,
} from "./types.js";
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
        const scan = await scanAndRegisterApprovedTools().catch((err) => {
            console.error("🔧 Forge: boot scan failed:", (err as Error).message);
            return { registered: 0, archived: 0 };
        });
        console.log(
            `🔧 Forge: ready (${counts.total} tools in library, migrated ${migration.migrated} legacy, ` +
                `${scan.registered} persisted re-registered, ${scan.archived} archived)`,
        );
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
    const handlerHash = hashSync(result.envelope.handler_code);
    try {
        insertTool({
            slug: req.name,
            description: req.description,
            schemaJson: JSON.stringify(req.parametersSchema),
            handlerHash,
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

    // Persistent tier — write manifest, mark awaiting_approval, return without
    // registering in the agent's tool registry. The user must approve via
    // approveDynamicTool before the tool becomes callable.
    if (req.persistent) {
        const capabilities = parseCapabilities({
            // Phase 3's envelope ships capabilities_declared as a string array.
            // Empty array becomes default ({fs_read:[],...}) — caller must
            // surface a "no capabilities declared" warning in the approval UI.
            fs_read: [],
            fs_write: [],
            net: [],
            exec: [],
        });
        const manifest: PersistedToolManifest = {
            slug: req.name,
            description: req.description,
            capabilities,
            parametersSchema: req.parametersSchema,
            version: "0.1.0",
            approvedAt: 0,
            userQuote: "",
            handlerHash,
        };
        try {
            await installPersistedTool(req.name, result.envelope.handler_code, manifest);
            setLifecycleState(req.name, "awaiting_approval");
        } catch (err) {
            return {
                kind: "failed",
                report: {
                    requestedName: req.name,
                    description: req.description,
                    attempts: result.attempts,
                    finalDiagnosis: `manifest write failed: ${(err as Error).message}`,
                    failureReason: "exhausted_attempts",
                    reportPath: "",
                },
            };
        }
        return {
            kind: "awaiting_approval",
            slug: req.name,
            capabilitiesRequested: capabilities,
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

export async function approveDynamicTool(
    slug: string,
    userQuote: string,
): Promise<{ ok: true; toolName: string } | { ok: false; error: string }> {
    if (!userQuote || userQuote.trim().length < 10) {
        return { ok: false, error: "user_quote too short or empty (must be ≥10 non-whitespace chars)" };
    }
    const manifest = readManifest(slug);
    if (!manifest) {
        return { ok: false, error: `manifest not found for slug ${slug}` };
    }
    // Refresh approval metadata.
    const approved: PersistedToolManifest = {
        ...manifest,
        approvedAt: Date.now(),
        userQuote,
    };
    try {
        await writeManifest(slug, approved);
        await reinstallPersistedTool(slug);
        setLifecycleState(slug, "active");
    } catch (err) {
        return { ok: false, error: `install failed: ${(err as Error).message}` };
    }

    const registry = getRegistryRef();
    if (registry) {
        const handler = async (input: Record<string, unknown>) => {
            const res = await invokePersistedTool(slug, input);
            return JSON.stringify(res);
        };
        registry.set(slug, {
            schema: {
                type: "function",
                function: {
                    name: slug,
                    description: `[Dynamic — sandboxed] ${manifest.description}`,
                    parameters: manifest.parametersSchema,
                },
            },
            handler,
        });
    }
    emitForgeEvent({ event: "tool_approved", ts: Date.now(), slug } as never);
    return { ok: true, toolName: slug };
}

export async function revokeDynamicTool(slug: string): Promise<void> {
    try {
        await uninstallPersistedTool(slug);
    } catch (err) {
        console.error("revokeDynamicTool: uninstall failed:", (err as Error).message);
    }
    const registry = getRegistryRef();
    if (registry) {
        registry.delete(slug);
    }
    try {
        setLifecycleState(slug, "archived");
    } catch {
        // unknown slug → no-op
    }
    emitForgeEvent({ event: "tool_revoked", ts: Date.now(), slug } as never);
}

/// Boot-scan: walk ~/.atlas/store/dynamic/* and re-register any active
/// (approved) manifests in the agent's tool registry.
async function scanAndRegisterApprovedTools(): Promise<{ registered: number; archived: number }> {
    const dir = getDynamicStoreDir();
    if (!existsSync(dir)) {
        return { registered: 0, archived: 0 };
    }
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return { registered: 0, archived: 0 };
    }
    let registered = 0;
    let archived = 0;
    const registry = getRegistryRef();
    for (const slug of entries) {
        if (slug === "_failed") continue;
        // If no manifest.json exists, this is a Phase 1-3 legacy tool (or a
        // freshly-migrated one). Skip silently — only Phase 4 persistent tools
        // are managed here.
        const manifestPath = join(manifestDir(slug), "manifest.json");
        if (!existsSync(manifestPath)) continue;
        const manifest = readManifest(slug);
        if (!manifest) {
            // Manifest present but invalid → archive the row.
            try {
                setLifecycleState(slug, "archived");
                archived++;
            } catch {
                // unknown slug in library; skip
            }
            continue;
        }
        if (manifest.approvedAt === 0) continue; // awaiting_approval — don't register
        const meta = getToolBySlug(slug);
        if (!meta || meta.lifecycleState !== "active") continue;
        if (registry) {
            const handler = async (input: Record<string, unknown>) => {
                const res = await invokePersistedTool(slug, input);
                return JSON.stringify(res);
            };
            registry.set(slug, {
                schema: {
                    type: "function",
                    function: {
                        name: slug,
                        description: `[Dynamic — sandboxed] ${manifest.description}`,
                        parameters: manifest.parametersSchema,
                    },
                },
                handler,
            });
        }
        try {
            await reinstallPersistedTool(slug);
        } catch (err) {
            console.error(`boot-scan: failed to pre-warm ${slug}:`, (err as Error).message);
        }
        registered++;
    }
    return { registered, archived };
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
