// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LayoutArchetype, PresentationOutline, Slide } from "./types.js";

// ── Rule 1: Action titles must contain a verb ──
// Heuristic: require at least one word that looks verb-like.
// "Revenue" → fail. "Mobile revenue grew 42%" → pass.
// This is permissive — a strict POS-tagger would over-reject; the goal is
// to catch the most egregious noun-label titles.

const COMMON_VERBS_FRAG = [
    // Past tense / participles
    "grew",
    "grow",
    "growing",
    "growth",
    "drove",
    "drive",
    "driving",
    "drives",
    "shipped",
    "ship",
    "ships",
    "shipping",
    "launched",
    "launch",
    "launches",
    "built",
    "build",
    "builds",
    "building",
    "made",
    "make",
    "makes",
    "making",
    "ran",
    "run",
    "runs",
    "running",
    "showed",
    "show",
    "shows",
    "showing",
    "told",
    "tell",
    "tells",
    "telling",
    "gave",
    "give",
    "gives",
    "giving",
    "took",
    "take",
    "takes",
    "taking",
    "put",
    "puts",
    "putting",
    "got",
    "get",
    "gets",
    "getting",
    // Common business verbs
    "increase",
    "increased",
    "increases",
    "increasing",
    "decrease",
    "decreased",
    "decreases",
    "decreasing",
    "improve",
    "improved",
    "improves",
    "improving",
    "reduce",
    "reduced",
    "reduces",
    "reducing",
    "expand",
    "expanded",
    "expands",
    "expanding",
    "acquire",
    "acquired",
    "acquires",
    "acquiring",
    "enable",
    "enables",
    "enabling",
    "enabled",
    "deliver",
    "delivers",
    "delivering",
    "delivered",
    "prove",
    "proves",
    "proving",
    "proved",
    "proven",
    "beat",
    "beats",
    "beating",
    "meet",
    "meets",
    "meeting",
    "met",
    "exceed",
    "exceeds",
    "exceeding",
    "exceeded",
    "cut",
    "cuts",
    "cutting",
    "reach",
    "reached",
    "reaches",
    "reaching",
    "serve",
    "serves",
    "serving",
    "served",
    "boost",
    "boosted",
    "boosts",
    "boosting",
    "launch",
    "launched",
    "launches",
    "need",
    "needs",
    "needed",
    "needing",
    "drive",
    "drives",
    "driven",
    "drove",
    "save",
    "saves",
    "saved",
    "saving",
    "transform",
    "transforms",
    "transformed",
    "disrupt",
    "disrupts",
    "disrupted",
    "solve",
    "solves",
    "solved",
    "solving",
    "win",
    "wins",
    "winning",
    "won",
    "lose",
    "loses",
    "lost",
    "losing",
    "invest",
    "invests",
    "invested",
    "investing",
    "raise",
    "raises",
    "raised",
    "raising",
    "scale",
    "scales",
    "scaled",
    "scaling",
    // Auxiliary / linking that still signal a sentence
    "is",
    "are",
    "was",
    "were",
    "has",
    "have",
    "had",
    "will",
    "can",
    "should",
    "must",
    "may",
    "does",
    "did",
    "do",
    "don't",
    "doesn't",
    "didn't",
    "bring",
    "brings",
    "brought",
    "bringing",
    "show",
    "shows",
    "showed",
    "showing",
    "hit",
    "hits",
    "hitting",
    "face",
    "faces",
    "faced",
    "facing",
    "needs",
    "need",
    "matter",
    "matters",
    "mattered",
    "mattering",
    "count",
    "counts",
    "counted",
    "counting",
    "work",
    "works",
    "worked",
    "working",
    "run",
    "runs",
    "ran",
    "running",
    "own",
    "owns",
    "owned",
    "owning",
    "know",
    "knows",
    "knew",
    "known",
    "knowing",
    "see",
    "sees",
    "saw",
    "seen",
    "seeing",
    "find",
    "finds",
    "found",
    "finding",
    "miss",
    "misses",
    "missed",
    "missing",
];
const VERB_SET = new Set(COMMON_VERBS_FRAG);

function looksLikeActionTitle(title: string): boolean {
    // Single-word titles are ambiguous (could be "Agenda" on a ToC slide or
    // "Revenue" as a lazy label). Exempt only single-word titles.
    const words = title
        .toLowerCase()
        .split(/[\s\p{P}]+/u)
        .filter(Boolean);
    if (words.length === 1) return true;
    return words.some((w) => VERB_SET.has(w));
}

// ── Rule 2: Body word count ──

function countBodyWords(slide: Slide): number {
    const parts: string[] = [];
    if (slide.body) parts.push(slide.body);
    if (slide.bullets) parts.push(...slide.bullets);
    if (slide.columns)
        slide.columns.forEach((c) => {
            parts.push(c.heading, c.body);
        });
    if (slide.steps)
        slide.steps.forEach((s) => {
            parts.push(s.label, s.detail ?? "");
        });
    if (slide.quote?.text) parts.push(slide.quote.text);
    return parts.join(" ").split(/\s+/).filter(Boolean).length;
}

// ── Rule 3: Bullet count ──

function tooManyBullets(slide: Slide): boolean {
    return (slide.bullets?.length ?? 0) > 4;
}

// ── Rule 4: Parallel grammar (heuristic) ──
// All bullets should start with the same "shape" — all verbs, or all nouns.
// We approximate by checking the first word of each bullet: if the mix includes
// verbs AND ings AND plural nouns, flag it.

function bulletsNotParallel(slide: Slide): boolean {
    const b = slide.bullets;
    if (!b || b.length < 2) return false;
    const firsts = b.map((x) => (x.split(/\s+/)[0] ?? "").toLowerCase().replace(/[^\w]/g, ""));
    if (firsts.length < 2) return false;
    const endings = firsts.map((w) => {
        if (w.endsWith("ing")) return "ing";
        if (w.endsWith("ed") && w.length > 3) return "ed";
        if (VERB_SET.has(w)) return "verb";
        if (w.endsWith("s") && w.length > 2) return "plural";
        return "other";
    });
    const unique = new Set(endings);
    return unique.size > 2; // highly mixed → likely not parallel
}

// ── Rule 5: Layout variety ──
// No 3 consecutive slides with the same archetype.

function layoutRunWarnings(outline: PresentationOutline): string[] {
    const warnings: string[] = [];
    let run: LayoutArchetype | null = null;
    let count = 0;
    outline.slides.forEach((s, i) => {
        if (s.archetype === run) {
            count++;
            if (count >= 3) {
                warnings.push(`Slide ${i + 1}: ${count} consecutive '${s.archetype}' slides (consider mixing layouts)`);
            }
        } else {
            run = s.archetype;
            count = 1;
        }
    });
    return warnings;
}

// ── Aggregate audit ──

export interface DesignAudit {
    passes: boolean;
    warnings: string[];
    slideIssues: Array<{ index: number; issues: string[] }>;
}

export function auditOutline(outline: PresentationOutline): DesignAudit {
    const warnings: string[] = [];
    const slideIssues: Array<{ index: number; issues: string[] }> = [];

    outline.slides.forEach((slide, i) => {
        const issues: string[] = [];

        // Rule 1
        if (
            slide.archetype !== "section-divider" &&
            slide.archetype !== "title" &&
            !looksLikeActionTitle(slide.title)
        ) {
            issues.push(`title "${slide.title}" may be a label (no verb detected)`);
        }

        // Rule 2
        const words = countBodyWords(slide);
        if (words > 75) {
            issues.push(`body is ${words} words (hard cap 75 — Duarte threshold)`);
        } else if (words > 40 && slide.archetype === "content") {
            issues.push(`body is ${words} words (>40 — consider splitting or converting to bento)`);
        }

        // Rule 3
        if (tooManyBullets(slide)) {
            issues.push(`${slide.bullets?.length} bullets (>4 — consider table or bento)`);
        }

        // Rule 4
        if (bulletsNotParallel(slide)) {
            issues.push("bullets may not be grammatically parallel");
        }

        if (issues.length > 0) {
            slideIssues.push({ index: i + 1, issues });
        }
    });

    warnings.push(...layoutRunWarnings(outline));

    return {
        passes: slideIssues.length === 0 && warnings.length === 0,
        warnings,
        slideIssues,
    };
}

// ── Auto-remediation — applies cheap fixes without LLM roundtrip ──

export function applyAutoFixes(outline: PresentationOutline): string[] {
    const fixes: string[] = [];

    outline.slides.forEach((slide, i) => {
        // Trim bullets over 4 — keep the first 4, surface the rest to speaker notes.
        if ((slide.bullets?.length ?? 0) > 4) {
            const overflow = slide.bullets!.slice(4);
            slide.bullets = slide.bullets!.slice(0, 4);
            slide.speakerNotes =
                (slide.speakerNotes ?? "") +
                (slide.speakerNotes ? "\n\n" : "") +
                `Additional points cut from slide: ${overflow.join("; ")}`;
            fixes.push(`Slide ${i + 1}: trimmed to 4 bullets`);
        }
    });

    return fixes;
}
