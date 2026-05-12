// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Layout Archetypes ────────────────────────
// Force the LLM to pick from a fixed set — this alone kills the
// "every slide is title + bullets" failure mode that makes AI decks
// look generic.

export type LayoutArchetype =
    | "title" // opening / closing slide
    | "section-divider" // "Part 2: Findings"
    | "content" // title + 1-4 bullets (default fallback)
    | "two-column" // side-by-side comparison
    | "bento-3" // 3 stat cards in a row
    | "bento-4" // 2x2 grid of callouts
    | "stat-callout" // one giant number with a label
    | "quote" // full-bleed quote + attribution
    | "chart-focus" // chart is the point of the slide
    | "comparison-table" // header row + data rows
    | "process-steps" // 3-5 ordered steps with arrows
    | "timeline" // horizontal timeline with milestones
    | "image-full-bleed"; // single hero image with minimal text

export const LAYOUT_ARCHETYPES: readonly LayoutArchetype[] = [
    "title",
    "section-divider",
    "content",
    "two-column",
    "bento-3",
    "bento-4",
    "stat-callout",
    "quote",
    "chart-focus",
    "comparison-table",
    "process-steps",
    "timeline",
    "image-full-bleed",
] as const;

// ── Chart Spec ────────────────────────────────

export type ChartKind = "bar" | "line" | "pie" | "doughnut" | "area" | "scatter";

export interface ChartSpec {
    kind: ChartKind;
    title?: string;
    categories: string[]; // x-axis labels
    series: { name: string; values: number[] }[];
}

// ── Slide ──────────────────────────────────────

export interface Slide {
    archetype: LayoutArchetype;
    title: string; // action title — must contain a verb
    subtitle?: string;
    bullets?: string[]; // <= 4 items, grammatically parallel
    body?: string; // for quote, stat-callout label, etc.
    columns?: { heading: string; body: string }[]; // two-column, bento-3/4
    bigNumber?: string; // stat-callout
    quote?: { text: string; author?: string };
    chart?: ChartSpec;
    steps?: { label: string; detail?: string }[]; // process-steps, timeline
    table?: { headers: string[]; rows: string[][] };
    imagePrompt?: string; // hint for asset resolver
    imagePath?: string; // set after asset resolution
    speakerNotes?: string; // ~60-90 words per slide
    citations?: string[]; // source URLs for research-backed slides
}

// ── Theme ─────────────────────────────────────

export interface Theme {
    id: string;
    name: string;
    mode: "light" | "dark";
    colors: {
        primary: string; // hex "RRGGBB" (no #)
        secondary: string;
        accent: string;
        bg: string;
        surface: string; // panel bg (slightly offset from bg)
        text: string;
        textMuted: string;
        positive: string; // semantic chart colors
        negative: string;
    };
    fonts: {
        heading: string; // PPT-safe only: Calibri/Aptos/Arial/Georgia/Cambria/Consolas
        body: string;
        mono: string;
    };
    chartPalette: string[]; // 6+ colors for series
}

// ── Outline (deck-level) ──────────────────────

export interface PresentationOutline {
    id: string; // uuid for follow-up ops
    title: string;
    subtitle?: string;
    audience: string; // "founders", "eng team", "investors"
    tone: string; // "formal", "conversational", "urgent"
    archetype: DeckArchetype;
    themeId: string;
    slides: Slide[];
    createdAt: string; // ISO
    sources?: string[]; // URLs from research
}

export type DeckArchetype =
    | "pitch" // Sequoia 10-slide
    | "sales" // problem → solution → proof → ask
    | "research" // hypothesis → method → findings
    | "qbr" // metrics + wins/misses + plan
    | "training" // learning objectives → concepts → recap
    | "keynote" // reveal / product launch
    | "board" // KPI + financials + asks
    | "general"; // fallback

// ── Style Card (injected into every slide-gen call) ──

export interface StyleCard {
    audience: string;
    tone: string;
    formality: 1 | 2 | 3 | 4 | 5; // 1=slack, 5=legal
    pov: "we" | "you" | "they" | "neutral";
    tense: "present" | "past";
    glossary: Record<string, string>; // term -> canonical form
    forbidden: string[]; // buzzwords to avoid
}

// ── Asset ─────────────────────────────────────

export interface Asset {
    kind: "photo" | "ai-image" | "screenshot" | "icon";
    path: string; // absolute path on disk
    altText: string; // required for accessibility
    attribution?: string; // required for Pexels/Unsplash
    hash: string; // for dedup
}

// ── Render Result ─────────────────────────────

export interface RenderResult {
    success: boolean;
    filePath?: string;
    sizeKb?: number;
    slideCount?: number;
    warnings?: string[];
    error?: string;
}
