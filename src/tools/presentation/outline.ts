// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { randomBytes } from "node:crypto";
import type { LLMClient } from "../../llm.js";
import { MODELS } from "../../llm.js";
import { extractJSON } from "../../utils/json-extract.js";
import { LAYOUT_ARCHETYPES, type PresentationOutline, type DeckArchetype, type Slide } from "./types.js";

// ── Outline Prompt ────────────────────────────

const LAYOUT_GUIDE = `
Available layouts (pick the best fit per slide):
- title: opening slide with deck name
- section-divider: between parts of a deck
- content: title + 1-4 short bullets (use sparingly — not every slide)
- two-column: side-by-side comparison
- bento-3: 3 stat cards horizontally
- bento-4: 2x2 grid of callout cards
- stat-callout: one giant number with a label
- quote: a pulled quote with attribution
- chart-focus: chart is the whole slide
- comparison-table: header row + data rows
- process-steps: 3-5 ordered steps
- timeline: horizontal milestones
- image-full-bleed: hero image + minimal text
`.trim();

const DESIGN_RULES = `
HARD RULES:
1. Titles must contain a VERB (action titles, not labels).
   GOOD: "Mobile revenue grew 42% YoY"
   BAD: "Revenue", "Market Overview"
2. Max 40 words of body text per slide. Hard fail at 75.
3. One idea per slide. If two ideas fit, split into two slides.
4. Bullets must be grammatically parallel (all verb-initial, or all noun-initial).
5. Max 4 bullets. 5+ → use bento/table/chart instead.
6. Vary layouts: never 3 consecutive slides with the same archetype.
7. Speaker notes ~60-90 words per slide, conversational, expanding on the slide.
`.trim();

function buildPrompt(
    userPrompt: string,
    numSlides: number,
    audience: string,
    tone: string,
    archetype: DeckArchetype,
): string {
    return `You are a senior presentation designer. Produce a high-quality slide deck outline.

USER REQUEST:
${userPrompt}

META:
- Target slide count: ${numSlides}
- Audience: ${audience}
- Tone: ${tone}
- Deck archetype: ${archetype}

${LAYOUT_GUIDE}

${DESIGN_RULES}

Return STRICT JSON matching this shape — no prose, no markdown fences, just the JSON object:
{
  "title": "deck title",
  "subtitle": "optional subtitle",
  "slides": [
    {
      "archetype": "title|content|two-column|bento-3|bento-4|stat-callout|quote|chart-focus|comparison-table|process-steps|timeline|image-full-bleed|section-divider",
      "title": "action title with a verb",
      "subtitle": "optional",
      "bullets": ["<=4 short parallel bullets"],
      "body": "free-form text for quote/stat-callout/image-full-bleed",
      "columns": [{"heading": "H", "body": "B"}],
      "bigNumber": "42%",
      "quote": {"text": "...", "author": "..."},
      "chart": {"kind": "bar|line|pie|doughnut|area|scatter", "title": "...", "categories": ["Q1","Q2"], "series": [{"name":"Revenue","values":[10,20]}]},
      "steps": [{"label": "Step 1", "detail": "..."}],
      "table": {"headers": ["Col A","Col B"], "rows": [["a1","b1"]]},
      "imagePrompt": "photorealistic specific subject, setting, lighting — no clipart, no cliché stock",
      "speakerNotes": "60-90 words expanding the slide"
    }
  ]
}

Only include fields relevant to the archetype chosen. The first slide must be archetype "title".`;
}

// ── Outline Generation ────────────────────────

export async function generateOutline(
    llm: LLMClient,
    args: {
        prompt: string;
        numSlides?: number;
        audience?: string;
        tone?: string;
        archetype?: DeckArchetype;
        themeId?: string;
    },
): Promise<PresentationOutline> {
    const numSlides = Math.max(3, Math.min(50, args.numSlides ?? 8));
    const audience = args.audience ?? "general professional audience";
    const tone = args.tone ?? "clear and confident";
    const archetype = args.archetype ?? "general";

    const prompt = buildPrompt(args.prompt, numSlides, audience, tone, archetype);

    // Stage-1: free-form reasoning + JSON (single call for MVP; two-call upgrade in Phase 4)
    const response = await llm.chat({
        messages: [{ role: "user", content: prompt }],
        modelOverride: MODELS.SONNET,
        systemPrompt: "Return only the JSON object. No prose before or after.",
    });

    const text = response.choices?.[0]?.message?.content ?? "";
    const jsonStr = extractJSON(typeof text === "string" ? text : JSON.stringify(text));
    if (!jsonStr) {
        throw new Error("Outline LLM call did not return parseable JSON");
    }

    let parsed: {
        title: string;
        subtitle?: string;
        slides: Slide[];
    };
    try {
        parsed = JSON.parse(jsonStr);
    } catch (err) {
        throw new Error(`Outline JSON parse failed: ${(err as Error).message}`);
    }

    // Validate + coerce archetypes
    const validArchetypes = new Set(LAYOUT_ARCHETYPES as readonly string[]);
    const slides: Slide[] = (parsed.slides ?? []).map((s: Slide) => {
        if (!validArchetypes.has(s.archetype)) {
            s.archetype = "content";
        }
        return s;
    });

    if (slides.length === 0) {
        throw new Error("Outline contained no slides");
    }

    return {
        id: cryptoRandomId(),
        title: parsed.title || "Untitled Presentation",
        subtitle: parsed.subtitle,
        audience,
        tone,
        archetype,
        themeId: args.themeId ?? "clean",
        slides,
        createdAt: new Date().toISOString(),
    };
}

function cryptoRandomId(): string {
    // 12 hex chars — collision risk negligible for per-user deck IDs
    return randomBytes(6).toString("hex");
}
