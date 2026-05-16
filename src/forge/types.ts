// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import type { Capabilities } from "./capabilities.js";

// ── Lifecycle ─────────────────────────────────────

export type ToolLifecycleState =
    | "proposed" // synthesis queued, not yet run
    | "verifying" // verifier loop in progress
    | "awaiting_approval" // persisted tool, user must approve
    | "active" // callable from registry
    | "graduated" // promoted to Stage 3 (skill)
    | "published" // submitted to marketplace
    | "archived"; // disabled, recoverable

export type ToolSource = "synchronous" | "dream_replay" | "sideloaded" | "migrated";

// ── Synthesis request + result ────────────────────

export interface SynthesisRequest {
    name: string;
    description: string;
    parametersSchema: Record<string, unknown>;
    persistent: boolean;
    originIntent?: string;
    source: ToolSource;
    // Track B-only fields
    patternClass?: "repeated_sequence" | "recovery_after_failure" | "workaround_signal" | "long_task_collapse";
    evidenceIds?: string[];
}

export type SynthesisResult =
    | {
          kind: "lookup_hit";
          slug: string;
          reusedFrom: { matchSimilarity: number; source: "function_gemma" | "library_embedding" };
      }
    | { kind: "synthesized"; slug: string; attempts: number; testsPassed: number; testsTotal: number }
    | { kind: "awaiting_approval"; slug: string; capabilitiesRequested: string[] }
    | { kind: "failed"; report: SynthesisFailureReport };

// NOTE: The variants here carry `slug: string` rather than `tool: ToolMetadata` as the
// orchestrator deep-dive (forge-deep-dives/04-routing-orchestrator.md) sketches. The
// Phase 1 plan deliberately keeps the result narrow — callers in Phase 2+ resolve the
// slug to a ToolMetadata via library.getToolBySlug() when they need the full record.
// This avoids forcing every result producer to construct a ToolMetadata and lets the
// library remain the single source of truth for tool data.

export interface SynthesisFailureReport {
    requestedName: string;
    description: string;
    attempts: number;
    finalDiagnosis: string;
    failureReason: "exhausted_attempts" | "sast_unrecoverable" | "parse_unrecoverable" | "budget_exceeded";
    reportPath: string; // ~/.atlas/store/dynamic/_failed/<ts>_<slug>.json
}

// ── Tool metadata (what library.ts returns) ───────

export interface ToolMetadata {
    slug: string;
    description: string;
    schema: ChatCompletionTool["function"]["parameters"];
    source: ToolSource;
    originIntent: string | null;
    createdAt: number;
    updatedAt: number;
    graduatedAt: number | null;
    publishedAt: number | null;
    archivedAt: number | null;
    invocationCount: number;
    successCount: number;
    lifecycleState: ToolLifecycleState;
}

// ── Manifest entry extension (used by installer.ts) ──

export interface DynamicManifestEntry {
    itemId: string; // "forge_<slug>"
    type: "dynamic";
    name: string;
    version: string;
    installedAt: number;
    autoUpdate: false; // dynamic tools never auto-update
    path: string;
    forgeMeta: {
        source: ToolSource;
        originIntent?: string;
        synthesisModelId?: string;
        verifierAttempts?: number;
    };
}

// ── Telemetry (forge-telemetry.jsonl) ─────────────

export type ForgeTelemetryEvent =
    | { event: "forge_boot"; ts: number; libraryRows: number; manifestEntries: number; bootMs: number }
    | { event: "migration_completed"; ts: number; migratedCount: number; failedCount: number; durationMs: number }
    | {
          event: "lookup_attempted";
          ts: number;
          description: string;
          matchSimilarity: number | null;
          source: "function_gemma" | "library_embedding" | "miss";
      }
    | { event: "synthesis_started"; ts: number; slug: string; source: ToolSource; track: "A" | "B" }
    | { event: "synthesis_completed"; ts: number; slug: string; attempts: number; durationMs: number }
    | { event: "synthesis_failed"; ts: number; slug: string; attempts: number; reason: string }
    | { event: "tool_persisted"; ts: number; slug: string; size: { handlerBytes: number; testCount: number } }
    | { event: "tool_archived"; ts: number; slug: string; reason: "decay" | "manual" | "graduation_demoted" };

// ── Forge-wide stats (returned by getForgeStats) ──

export interface ForgeStats {
    libraryRows: number;
    activeToolsCount: number;
    archivedToolsCount: number;
    graduatedSkillsCount: number;
    publishedToolsCount: number;
    todaySynthesisAttempts: number;
    todaySynthesisSuccesses: number;
    todayLookupHits: number;
}

// NOTE: ForgeStats fields here are the Phase 1 surface. The orchestrator deep-dive
// describes additional aggregate metrics (successRateAcrossActiveTools, nightly synthesis
// counts) that depend on data Phases 3-6 will start emitting. Extend this interface as
// later phases land, keeping field names consistent with what's already shipped.

// ── Persisted dynamic tool manifest ───────────────

export interface PersistedToolManifest {
    /** Slug, must match /^[a-z][a-z0-9_]*$/ — same regex as create-tool.ts:324. */
    slug: string;
    /** One-sentence description (shown in tool schema + approval prompt). */
    description: string;
    /** Capabilities declared by the verifier and validated by validateCapabilities. */
    capabilities: Capabilities;
    /** JSON-schema for the tool's parameters object. */
    parametersSchema: Record<string, unknown>;
    /** Semantic version — initial value "0.1.0", bumped on update. */
    version: string;
    /** Wall-clock ms epoch the user clicked approve. */
    approvedAt: number;
    /** Verbatim text the user used to approve. Audit-trail; required for revoke proof. */
    userQuote: string;
    /** First 16 hex chars of sha256(handler.js content). Tampering detector. */
    handlerHash: string;
}
