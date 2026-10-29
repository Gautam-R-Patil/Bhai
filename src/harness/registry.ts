// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness: Dimension Registry ──────────────────────────────────────
// Catalogs every tunable "harness dimension" in Bhai — numeric weights,
// thresholds, k-values, phase ratios, and role prompts — as live get/set
// descriptors. The active harness-config.json overrides defaults at boot.
// All reads use getDimensionValue(id) ?? hardcodedDefault so the system
// degrades gracefully if the registry is not initialized.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { HarnessDimension, HarnessConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ATLAS_DATA_DIR = process.env.ATLAS_DATA_DIR || join(__dirname, "../../data");
const ACTIVE_CONFIG_PATH = join(ATLAS_DATA_DIR, "harness/active/harness-config.json");

// ── Internal state ──────────────────────────────────────────────────────────

const _registry = new Map<string, HarnessDimension>();
const _values = new Map<string, unknown>(); // live value store

// ── Numeric dimension factory ───────────────────────────────────────────────

function numericDim(
    id: string,
    description: string,
    defaultValue: number,
    filePath: string,
    lineRef: string,
    minValue = 0,
    maxValue = 1,
): HarnessDimension<number> {
    _values.set(id, defaultValue);
    return {
        id,
        description,
        get currentValue() { return _values.get(id) as number; },
        set currentValue(v: number) { _values.set(id, v); },
        defaultValue,
        minValue,
        maxValue,
        filePath,
        lineRef,
        get() { return _values.get(id) as number; },
        set(v: number) { _values.set(id, Math.max(minValue, Math.min(maxValue, v))); },
    };
}

function intDim(
    id: string,
    description: string,
    defaultValue: number,
    filePath: string,
    lineRef: string,
    minValue = 1,
    maxValue = 200,
): HarnessDimension<number> {
    _values.set(id, defaultValue);
    return {
        id,
        description,
        get currentValue() { return _values.get(id) as number; },
        set currentValue(v: number) { _values.set(id, v); },
        defaultValue,
        minValue,
        maxValue,
        filePath,
        lineRef,
        get() { return _values.get(id) as number; },
        set(v: number) { _values.set(id, Math.round(Math.max(minValue, Math.min(maxValue, v)))); },
    };
}

function stringDim(
    id: string,
    description: string,
    defaultValue: string,
    filePath: string,
    lineRef: string,
): HarnessDimension<string> {
    _values.set(id, defaultValue);
    return {
        id,
        description,
        get currentValue() { return _values.get(id) as string; },
        set currentValue(v: string) { _values.set(id, v); },
        defaultValue,
        filePath,
        lineRef,
        get() { return _values.get(id) as string; },
        set(v: string) { _values.set(id, v); },
    };
}

// ── Default role prompts ────────────────────────────────────────────────────

const DEFAULT_RESEARCHER_PROMPT = `You are a researcher. Be concise and factual. Cite sources. Use web search and memory tools to find accurate information. Summarize key findings clearly.`;

const DEFAULT_CODER_PROMPT = `You are a coder. Write clean, working code. Always read existing files before modifying them. Test your changes. Follow the existing code style and patterns.`;

const DEFAULT_BROWSER_PROMPT = `You are a browser automation agent. Always scan the page after navigating. Use precise element references. Retry on failure with different selectors.`;

const DEFAULT_SYSTEM_PROMPT = `You are a system automation agent. Use AppleScript for app automation on macOS. Take screenshots to verify actions completed correctly.`;

const DEFAULT_GENERAL_PROMPT = `You are a general-purpose agent. Be efficient — use the minimum number of tool calls needed to complete the task.`;

// ── Registry population ─────────────────────────────────────────────────────

function buildRegistry(): void {
    const dims: HarnessDimension[] = [
        // Memory fusion weights (sqlite.ts:1421)
        numericDim("memory.fusion.relevanceWeight", "Weight given to RRF relevance score in the generative-agents blend", 0.5, "src/memory/sqlite.ts", "1421"),
        numericDim("memory.fusion.recencyWeight", "Weight given to recency (exponential decay) in the generative-agents blend", 0.25, "src/memory/sqlite.ts", "1421"),
        numericDim("memory.fusion.importanceWeight", "Weight given to stored importance score in the generative-agents blend", 0.25, "src/memory/sqlite.ts", "1421"),

        // SAN weight (sqlite.ts:1440)
        numericDim("memory.san.weight", "Spreading activation network boost multiplier applied to existing+new nodes", 0.3, "src/memory/sqlite.ts", "1440"),

        // Cross-encoder blend (sqlite.ts:1508)
        numericDim("memory.crossEncoder.blend", "Cross-encoder re-rank blend: (blend)×RRF_score + (1-blend)×rerankSim×0.02", 0.6, "src/memory/sqlite.ts", "1508"),

        // Recall k-values (agent.ts:1403,1423)
        intDim("memory.recall.k", "Top-k memories returned by semantic recall()", 5, "src/agent.ts", "1423", 3, 50),
        intDim("memory.coreMemory.k", "Top-k core memories injected at iteration 1", 10, "src/agent.ts", "1403", 3, 30),
        intDim("memory.conversationRecall.k", "Top-k conversation memories recalled", 3, "src/agent.ts", "1426", 1, 10),

        // HyDE trigger (sqlite.ts:1570)
        intDim("memory.hyde.minResults", "Minimum results below which HyDE is triggered", 3, "src/memory/sqlite.ts", "1570", 0, 10),
        numericDim("memory.hyde.minTopScore", "Minimum top score below which HyDE is triggered", 0.15, "src/memory/sqlite.ts", "1571"),

        // Agent context cap (agent.ts:1629)
        intDim("agent.contextCap", "Maximum characters of injected context (MAX_INJECTION_CHARS)", 8000, "src/agent.ts", "1629", 2000, 20000),

        // Evaluator thresholds (evaluator.ts:34-36)
        intDim("evaluator.acceptThreshold", "Score >= this → accept verdict (no retry)", 70, "src/agents/evaluator.ts", "34", 50, 95),
        intDim("evaluator.retryThreshold", "Score >= this → retry verdict (< this → replan)", 40, "src/agents/evaluator.ts", "35", 20, 69),
        intDim("evaluator.maxRetries", "Maximum retry attempts before returning best result", 2, "src/agents/evaluator.ts", "36", 0, 5),

        // Swarm escalation thresholds (swarm.ts:265,283)
        intDim("swarm.multiCriticThreshold", "Evaluation score below which multi-critic debate is triggered", 60, "src/agents/swarm.ts", "265", 30, 90),
        intDim("swarm.moaThreshold", "Evaluation score below which MoA re-synthesis is triggered", 70, "src/agents/swarm.ts", "283", 30, 95),

        // Tool router thresholds (tool-router.ts:1215,1439)
        numericDim("toolRouter.llmConfidenceThreshold", "Minimum LLM classifier confidence to accept its category result", 0.4, "src/tool-router.ts", "1215"),
        numericDim("toolRouter.mcpSimilarityThreshold", "Minimum cosine similarity for MCP tool inclusion", 0.25, "src/tool-router.ts", "1439"),
        intDim("toolRouter.maxToolsTotal", "Hard cap on total tools passed to LLM per call", 36, "src/tool-router.ts", "1168", 10, 80),

        // Research phase ratios (executor.ts:82-84)
        numericDim("research.discoveryPhaseRatio", "Fraction of depth rounds allocated to Phase 1 (discovery)", 0.4, "src/research/executor.ts", "82"),
        numericDim("research.deepReadPhaseRatio", "Fraction of depth rounds allocated to Phase 2 (deep reading)", 0.4, "src/research/executor.ts", "83"),

        // Decomposition library (decomposition-library.ts:43)
        numericDim("decomposition.matchThreshold", "Jaccard similarity threshold for template matching", 0.4, "src/agents/decomposition-library.ts", "43"),

        // Sub-agent role prompts
        stringDim("subagent.researcher.systemPrompt", "System prompt for researcher sub-agent role", DEFAULT_RESEARCHER_PROMPT, "src/agents/sub-agent.ts", "204"),
        stringDim("subagent.coder.systemPrompt", "System prompt for coder sub-agent role", DEFAULT_CODER_PROMPT, "src/agents/sub-agent.ts", "214"),
        stringDim("subagent.browser.systemPrompt", "System prompt for browser sub-agent role", DEFAULT_BROWSER_PROMPT, "src/agents/sub-agent.ts", "221"),
        stringDim("subagent.system.systemPrompt", "System prompt for system sub-agent role", DEFAULT_SYSTEM_PROMPT, "src/agents/sub-agent.ts", "228"),
        stringDim("subagent.general.systemPrompt", "System prompt for general sub-agent role", DEFAULT_GENERAL_PROMPT, "src/agents/sub-agent.ts", "235"),
    ];

    for (const dim of dims) {
        _registry.set(dim.id, dim);
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

let _initialized = false;

/** Load the registry and apply any active harness config from disk. */
export function initRegistry(): void {
    if (_initialized) return;
    buildRegistry();
    _initialized = true;

    if (existsSync(ACTIVE_CONFIG_PATH)) {
        try {
            const raw = readFileSync(ACTIVE_CONFIG_PATH, "utf-8");
            const config = JSON.parse(raw) as HarnessConfig;
            applyConfig(config);
            console.log(`[HARNESS] Loaded active config from ${ACTIVE_CONFIG_PATH} (candidate: ${config.candidateId})`);
        } catch (err) {
            console.warn(`[HARNESS] Failed to load active harness config (using defaults):`, (err as Error).message);
        }
    }
}

/** Get the current value of a dimension. Returns undefined if not registered. */
export function getDimensionValue<T>(id: string): T | undefined {
    const dim = _registry.get(id);
    return dim ? (dim.get() as T) : undefined;
}

/** Set the value of a dimension. Silently no-ops if not registered. */
export function setDimensionValue(id: string, value: unknown): void {
    const dim = _registry.get(id);
    if (dim) (dim as HarnessDimension<unknown>).set(value);
}

/** Get all registered dimensions (for inspection and proposer context). */
export function getRegistry(): HarnessDimension[] {
    return [..._registry.values()];
}

/** Get a single dimension descriptor. */
export function getDimension(id: string): HarnessDimension | undefined {
    return _registry.get(id);
}

/** Apply a harness config by overriding dimension values in bulk. */
export function applyConfig(config: HarnessConfig): void {
    for (const [id, value] of Object.entries(config.dimensions)) {
        setDimensionValue(id, value);
    }
}

/** Serialize all current dimension values into a HarnessConfig snapshot. */
export function snapshotConfig(candidateId: string): HarnessConfig {
    const dimensions: Record<string, unknown> = {};
    for (const [id, dim] of _registry.entries()) {
        dimensions[id] = dim.get();
    }
    return {
        candidateId,
        dimensions,
        createdAt: new Date().toISOString(),
    };
}

/** Reset all dimensions to their default values. */
export function resetToDefaults(): void {
    for (const dim of _registry.values()) {
        (dim as HarnessDimension<unknown>).set(dim.defaultValue);
    }
}

/** Persist the current config as the active config on disk. */
export function persistActiveConfig(candidateId: string): void {
    const config = snapshotConfig(candidateId);
    const dir = dirname(ACTIVE_CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

/** Return a human-readable summary of the registry for use in proposer prompts. */
export function formatRegistrySummary(): string {
    const lines: string[] = ["# Bhai Harness Dimensions\n"];
    const groups: Record<string, HarnessDimension[]> = {};
    for (const dim of _registry.values()) {
        const group = dim.id.split(".")[0];
        if (!groups[group]) groups[group] = [];
        groups[group].push(dim);
    }
    for (const [group, dims] of Object.entries(groups)) {
        lines.push(`## ${group}`);
        for (const d of dims) {
            const range = d.minValue !== undefined
                ? ` [${d.minValue}–${d.maxValue}]`
                : "";
            lines.push(`- **${d.id}**: ${d.description}`);
            lines.push(`  Current: \`${JSON.stringify(d.get())}\`, Default: \`${JSON.stringify(d.defaultValue)}\`${range} (${d.lineRef})`);
        }
        lines.push("");
    }
    return lines.join("\n");
}
