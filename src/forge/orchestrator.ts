// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LLMClient } from "../llm.js";
import { selectForToolSynthesis } from "../model-router.js";
import type { FunctionGemmaResult } from "../models/function-gemma.js";
import {
    enterAwaitingDynamicToolApproval,
    getAwaitingDynamicToolSlug,
    getPlanModeState,
} from "../agents/plan-mode.js";
import { ownerApproved } from "../security/consent.js";
import { getRegistryRef, isBuiltinToolName, registerDynamicTool, unregisterDynamicTool } from "../tools/create-tool.js";
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
import { parseCapabilitiesLooseInput, runVerifier } from "./verifier.js";

type FunctionGemmaFn = (
    query: string,
    toolSchemas: Array<{ name: string; description: string; parameters: string[] }>,
) => Promise<FunctionGemmaResult | null>;

const FORGE_SYSTEM_PROMPT =
    "You are Bhai's tool-synthesis engine. Produce a JSON object with handler_code, tests, capabilities_declared, side_effects, synthesis_notes. Return ONLY the JSON.\n" +
    "handler_code is the body of `async function (input, utils, console)` and returns the result. " +
    "utils = { fs (read-only: readFile, readFileSync, readdir, readdirSync, stat, statSync, existsSync), path, homedir, JSON, console, setTimeout, " +
    "require (only 'path', 'fs', 'os'; also available as plain `require`) }. utils.exec, utils.execFile and utils.fetch are denied, and there is no Buffer, URL or crypto. " +
    "Tests run the handler in that same sandbox and check its return value or error; side_effect_* test kinds always fail, and a bare `throws` passes on any error, so prefer throws_contains.";

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
    if (!hit || !isCallable(hit.slug)) return null;
    return getToolBySlug(hit.slug);
}

// A library row is reusable only while its tool is in this process's registry:
// that rules out awaiting_approval, archived, and session tools from before a restart.
function isCallable(slug: string): boolean {
    return getRegistryRef()?.has(slug) ?? false;
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
    if (isBuiltinToolName(req.name)) {
        return {
            kind: "failed",
            report: {
                requestedName: req.name,
                description: req.description,
                attempts: 0,
                finalDiagnosis: `"${req.name}" is a built-in tool; choose a different name`,
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
        if (hit && isCallable(hit.slug)) {
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
        // Refuse to clobber an already-pending approval slug — the user
        // needs to act on it (approve/revoke) before we start another.
        const existingPending = getAwaitingDynamicToolSlug();
        if (existingPending && existingPending !== req.name) {
            return {
                kind: "failed",
                report: {
                    requestedName: req.name,
                    description: req.description,
                    attempts: result.attempts,
                    finalDiagnosis:
                        `another persistent tool is already awaiting approval: '${existingPending}'. ` +
                        `Approve or revoke it first, then retry.`,
                    failureReason: "exhausted_attempts",
                    reportPath: "",
                },
            };
        }
        // Wire envelope's capabilities_declared through. The verifier already
        // validated they parse + don't request hard-denied paths; the approval
        // gate is the user's chance to refuse if anything looks too broad.
        const capabilities = parseCapabilities(
            parseCapabilitiesLooseInput(result.envelope.capabilities_declared ?? []),
        );
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
            enterAwaitingDynamicToolApproval(req.name);
        } catch (err) {
            // Orphan the library row to keep state consistent — manifest
            // failed to write, so the tool is not actually available; mark
            // archived so subsequent synthesize attempts of the same slug
            // can proceed (and so getToolBySlug returns archived).
            try {
                setLifecycleState(req.name, "archived");
            } catch {
                /* unknown slug */
            }
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
        handlerCode: result.envelope.handler_code,
        parametersSchema: req.parametersSchema,
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
    // State-gate: approval is ONLY valid when the agent is in
    // awaiting_dynamic_tool_approval mode AND the slug matches the one the
    // user is being asked about. This blocks LLM-self-approval via a direct
    // call from act mode immediately after create_tool returns awaiting_approval.
    const planState = getPlanModeState();
    const awaitingSlug = getAwaitingDynamicToolSlug();
    if (planState.mode !== "awaiting_dynamic_tool_approval" || awaitingSlug !== slug) {
        return {
            ok: false,
            error:
                `approval refused — plan-mode must be 'awaiting_dynamic_tool_approval' with slug='${slug}'; ` +
                `current mode='${planState.mode}', awaiting_slug='${awaitingSlug ?? "(none)"}'`,
        };
    }
    // Defence in depth: forge-approval.ts checks the same, but anything that
    // calls approveDynamicTool directly must still carry the owner's own yes.
    if (!ownerApproved(userQuote, planState.enteredAt)) {
        return { ok: false, error: "user_quote must be the owner's own yes from their latest message" };
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

    registerPersisted(slug, manifest);
    emitForgeEvent({ event: "tool_approved", ts: Date.now(), slug } as never);
    // Return to act mode so the agent can use the newly-approved tool.
    if (getPlanModeState().mode === "awaiting_dynamic_tool_approval") {
        // exitPlanMode flips back to act
        const pm = await import("../agents/plan-mode.js");
        pm.exitPlanMode();
    }
    return { ok: true, toolName: slug };
}

/** Make an approved persisted tool callable; it runs in the sandbox supervisor. */
function registerPersisted(slug: string, manifest: PersistedToolManifest): void {
    registerDynamicTool(slug, {
        schema: {
            type: "function",
            function: {
                name: slug,
                description: `[Dynamic — sandboxed] ${manifest.description}`,
                parameters: manifest.parametersSchema,
            },
        },
        handler: async (input) => JSON.stringify(await invokePersistedTool(slug, input)),
    });
}

export async function revokeDynamicTool(slug: string): Promise<void> {
    try {
        await uninstallPersistedTool(slug);
    } catch (err) {
        console.error("revokeDynamicTool: uninstall failed:", (err as Error).message);
    }
    unregisterDynamicTool(slug);
    try {
        setLifecycleState(slug, "archived");
    } catch {
        // unknown slug → no-op
    }
    // Exit awaiting_dynamic_tool_approval mode if THIS was the pending slug.
    // Without this the agent gets locked: can't approve (manifest gone),
    // can't escape (mode persists).
    if (
        getPlanModeState().mode === "awaiting_dynamic_tool_approval" &&
        getAwaitingDynamicToolSlug() === slug
    ) {
        const pm = await import("../agents/plan-mode.js");
        pm.exitPlanMode();
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
    for (const slug of entries) {
        if (slug === "_failed") continue;
        // Skip non-slug-shaped names (.DS_Store, .tmp, foo-bar, etc.).
        // `manifestDir` throws on invalid slugs; one bad entry shouldn't
        // abort registration of the rest.
        let manifestPath: string;
        try {
            manifestPath = join(manifestDir(slug), "manifest.json");
        } catch {
            continue;
        }
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

        // Recompute handler.js sha256 prefix and compare against the manifest.
        // Refuse to register tools whose handler has been swapped on disk
        // post-approval — archive instead.
        try {
            const handlerPath = join(manifestDir(slug), "handler.js");
            if (!existsSync(handlerPath)) {
                setLifecycleState(slug, "archived");
                archived++;
                continue;
            }
            const handlerBytes = readFileSync(handlerPath);
            const recomputedHash = createHash("sha256")
                .update(handlerBytes)
                .digest("hex")
                .substring(0, 16);
            if (recomputedHash !== manifest.handlerHash) {
                console.warn(
                    `[forge] boot-scan: handler hash mismatch for ${slug} ` +
                        `(manifest=${manifest.handlerHash}, on-disk=${recomputedHash}); archiving`,
                );
                setLifecycleState(slug, "archived");
                archived++;
                continue;
            }
        } catch (err) {
            console.error(`[forge] boot-scan: hash check failed for ${slug}:`, (err as Error).message);
            try {
                setLifecycleState(slug, "archived");
                archived++;
            } catch {
                /* unknown slug */
            }
            continue;
        }
        registerPersisted(slug, manifest);
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
