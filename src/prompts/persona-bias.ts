// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.

/**
 * ── Persona Bias ────────────────────────────────────────────────
 * Canonical source of truth for how each onboarding-selected persona
 * affects runtime behaviour. Two pure functions, both no-side-effects:
 *
 *   getPersonaIdentityLine(p)   → string injected into dynamic prompt
 *   getPersonaToolWeights(p)    → category → multiplier map for tool router
 *
 * Both consumers gate their use behind BHAI_NO_PERSONA_BIAS=true.
 * Persona is stored in identity.extra (set during wizard) and read
 * once per agent turn — see src/agent.ts and src/tool-router.ts.
 */

export type Persona = "developer" | "founder" | "creator" | "researcher" | "explorer";

export const PERSONA_VALUES: readonly Persona[] = [
    "developer", "founder", "creator", "researcher", "explorer",
];

/** Narrow a possibly-unknown value to a Persona. Returns null if invalid. */
export function asPersona(v: unknown): Persona | null {
    if (typeof v !== "string") return null;
    return (PERSONA_VALUES as readonly string[]).indexOf(v) >= 0
        ? (v as Persona)
        : null;
}

// ── Identity lines ──────────────────────────────────────────────
// One-sentence soft preferences injected into the dynamic-context block
// on the first iteration of each conversation. Each line is < 30 tokens
// to keep the prompt budget tight (assembleDynamicPrompt has a 500-token
// total budget; this module reserves ~35).

const IDENTITY_LINES: Record<Persona, string> = {
    developer:
        "The user describes themselves as a developer. Bias toward terminal output, code-level explanations, and assume git/CLI familiarity.",
    founder:
        "The user describes themselves as a founder. Prefer concise, decision-oriented answers; surface tradeoffs early; keep emails and calendar work tight.",
    creator:
        "The user describes themselves as a creator. Be visually fluent, suggest concrete creative angles, and treat references and assets as first-class objects.",
    researcher:
        "The user describes themselves as a researcher. Cite sources, flag confidence, prefer breadth then depth, and surface contradictions and gaps.",
    explorer:
        "",  // Explorer means "no bias" — empty string signals "skip injection".
};

export function getPersonaIdentityLine(persona: Persona | null | undefined): string | null {
    if (!persona) return null;
    const line = IDENTITY_LINES[persona];
    return line && line.length > 0 ? line : null;
}

// ── Tool-router weights ─────────────────────────────────────────
// Multiplicative bias applied AFTER cosine scoring, BEFORE the final
// top-K sort. Category IDs MUST match those in src/tool-router.ts
// (real names — verified against the registry on 2026-05-17). All
// weights in [0.7, 1.4]; default for unlisted categories is 1.0.

type CategoryId = string;
type WeightMap = Readonly<Record<CategoryId, number>>;

const EMPTY: WeightMap = Object.freeze({});

const WEIGHTS: Readonly<Record<Persona, WeightMap>> = {
    developer: Object.freeze({
        coding:         1.35,
        codebase:       1.30,
        shell:          1.25,
        code_execution: 1.25,
        github:         1.20,
        browser:        1.10,
    }),
    founder: Object.freeze({
        scheduling:     1.30,
        communication:  1.30,
        research:       1.20,
        document:       1.20,
        google_api:     1.20,
    }),
    creator: Object.freeze({
        media:          1.30,
        video_editing:  1.30,
        presentation:   1.25,
        file_system:    1.15,
        marketing:      1.25,
    }),
    researcher: Object.freeze({
        research:       1.40,
        web_search:     1.30,
        browser:        1.20,
        codebase:       1.10,
        memory:         1.15,
        document:       1.20,
    }),
    explorer: EMPTY,
};

export function getPersonaToolWeights(persona: Persona | null | undefined): WeightMap {
    if (!persona) return EMPTY;
    return WEIGHTS[persona] || EMPTY;
}

/** Convenience: multiply a single category's score by the persona's weight. */
export function applyPersonaWeight(
    persona: Persona | null | undefined,
    category: CategoryId,
    score: number,
): number {
    const weights = getPersonaToolWeights(persona);
    const w = weights[category];
    return typeof w === "number" ? score * w : score;
}
