// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { randomBytes } from "node:crypto";
import type { ChatCompletionTool, LLMClient } from "../../llm.js";
import { MODELS } from "../../llm.js";
import { extractJSON } from "../../utils/json-extract.js";
import { type DeckArchetype, LAYOUT_ARCHETYPES, type PresentationOutline, type Slide } from "./types.js";

// ── Outline via tool-use (forced-structured args, always parseable) ──
// Rather than prompt for JSON and hope the model returns clean JSON, we
// define a single tool the model must call. The tool-call arguments are
// parsed by the API, so we get guaranteed-valid JSON with no regex rescue.

const SLIDE_PROPERTY = {
    type: "object",
    required: ["archetype", "title"],
    properties: {
        archetype: {
            type: "string",
            enum: [...LAYOUT_ARCHETYPES],
            description:
                "Layout archetype. Prefer variety: bento-3 for 3 parallel points, stat-callout for one big number, quote for a pulled quote, chart-focus for data, timeline for milestones, two-column for comparisons. 'content' is the fallback; avoid using it for more than 40% of the deck.",
        },
        title: {
            type: "string",
            description:
                "Action title (contains a verb, not a noun label). GOOD: 'Mobile revenue grew 42% YoY'. BAD: 'Revenue', 'Market Overview'. No emoji, no check-marks, no X-marks in titles.",
        },
        subtitle: { type: "string" },
        bullets: {
            type: "array",
            items: { type: "string" },
            description: "Max 4 items, grammatically parallel (all verb-initial OR all noun-initial). No emoji.",
            maxItems: 4,
        },
        body: {
            type: "string",
            description:
                "Free-form text (used for quote, stat-callout label, image-full-bleed caption, or short paragraph).",
        },
        columns: {
            type: "array",
            items: {
                type: "object",
                required: ["heading", "body"],
                properties: {
                    heading: { type: "string" },
                    body: { type: "string" },
                },
            },
            description: "For two-column (2 items), bento-3 (3 items), bento-4 (4 items).",
        },
        bigNumber: { type: "string", description: "For stat-callout. Keep short: '42%', '$1.2M', '3x', '100K users'." },
        quote: {
            type: "object",
            properties: {
                text: { type: "string" },
                author: { type: "string" },
            },
        },
        chart: {
            type: "object",
            properties: {
                kind: { type: "string", enum: ["bar", "line", "pie", "doughnut", "area", "scatter"] },
                title: { type: "string" },
                categories: { type: "array", items: { type: "string" } },
                series: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: { type: "string" },
                            values: { type: "array", items: { type: "number" } },
                        },
                    },
                },
            },
        },
        steps: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    label: { type: "string" },
                    detail: { type: "string" },
                },
            },
            description: "For process-steps (3-5 items) or timeline (3-6 items).",
        },
        table: {
            type: "object",
            properties: {
                headers: { type: "array", items: { type: "string" } },
                rows: { type: "array", items: { type: "array", items: { type: "string" } } },
            },
        },
        imagePrompt: {
            type: "string",
            description:
                "Specific, photorealistic subject. FORBIDDEN: diverse-hands-on-keyboard, lightbulbs, handshakes, empty conference rooms, clipart, generic stock-photo clichés.",
        },
        speakerNotes: {
            type: "string",
            description: "60-90 words, conversational, expanding on the slide — what the presenter should say.",
        },
    },
} as const;

function buildEmitOutlineTool(): ChatCompletionTool {
    return {
        type: "function",
        function: {
            name: "emit_presentation_outline",
            description:
                "Emit the complete presentation outline as structured data. Call this exactly once with the full deck.",
            parameters: {
                type: "object",
                required: ["title", "slides"],
                properties: {
                    title: { type: "string", description: "Deck title." },
                    subtitle: { type: "string" },
                    slides: {
                        type: "array",
                        items: SLIDE_PROPERTY,
                        description:
                            "Ordered slides. First slide MUST be archetype 'title'. Use varied archetypes — no more than 40% 'content' layout.",
                    },
                },
            },
        },
    };
}

// ── Few-shot nudges in the system prompt (design canon baked in) ──

const SYSTEM_PROMPT = `You are a senior presentation designer producing professional, non-generic slide decks.

HARD RULES — you will be judged on these:
1. Action titles only — every title must contain a verb. "Mobile revenue grew 42% YoY" ✓. "Revenue" ✗.
2. Max 40 words of body per slide. Split if longer.
3. ≤4 bullets; use bento/stat/chart instead of 5+ bullets.
4. Bullets must be grammatically parallel.
5. LAYOUT VARIETY is non-negotiable. A good 8-slide deck uses 6+ different archetypes.
   - Use 'content' (title + bullets) for AT MOST 40% of slides.
   - The rest: hero, stat-callout, bento-3, bento-4, two-column, quote, chart-focus, timeline, process-steps, comparison-table, section-divider, image-full-bleed.
   - Never 3 consecutive slides of the same archetype.
6. First slide is archetype='title'. Add section-divider between major parts if deck ≥8 slides.
7. No emoji, no ✓/✗, no checkmarks in titles or bullets. Use plain text.
8. Speaker notes: 60-90 words, conversational.

RESPOND BY CALLING emit_presentation_outline EXACTLY ONCE with the full deck. Do not emit prose.`;

function buildUserMessage(args: {
    prompt: string;
    numSlides: number;
    audience: string;
    tone: string;
    archetype: DeckArchetype;
}): string {
    return `Create a presentation outline.

TOPIC: ${args.prompt}

META:
- Target slides: ${args.numSlides}
- Audience: ${args.audience}
- Tone: ${args.tone}
- Deck archetype: ${args.archetype}

Make it visually varied. Pick the BEST archetype for each slide's content — do not default to 'content' everywhere. A deck that's all title+bullets looks AI-generated; a varied deck looks designed.

Call emit_presentation_outline now.`;
}

// ── Main entry ───────────────────────────────

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
    const numSlides = Math.max(3, Math.min(30, args.numSlides ?? 8));
    const audience = args.audience ?? "general professional audience";
    const tone = args.tone ?? "clear and confident";
    const archetype = args.archetype ?? "general";

    const tool = buildEmitOutlineTool();
    const userMessage = buildUserMessage({ prompt: args.prompt, numSlides, audience, tone, archetype });

    // Try up to 2 attempts: Haiku first (fast, reliable), then Sonnet as backup.
    // We catch model failures and fall back; we never let a bad JSON response
    // kill the whole flow since tool-use guarantees structure.
    const attempts: { model: string; label: string }[] = [
        { model: MODELS.HAIKU, label: "Haiku" },
        { model: MODELS.SONNET, label: "Sonnet" },
    ];

    let lastError: string = "";
    for (const { model, label } of attempts) {
        try {
            const response = await llm.chat({
                messages: [{ role: "user", content: userMessage }],
                tools: [tool],
                modelOverride: model,
                systemPrompt: SYSTEM_PROMPT,
            });

            const choice = response.choices?.[0];
            if (!choice) {
                lastError = `${label}: no choices in response`;
                continue;
            }

            // Extract tool call — preferred, always structured
            const toolCall = choice.message?.tool_calls?.[0];
            const rawArgs = toolCall?.function?.arguments;

            let parsed: { title?: string; subtitle?: string; slides?: Slide[] } | null = null;

            if (rawArgs) {
                try {
                    parsed = JSON.parse(rawArgs);
                } catch {
                    // Some providers (Gemini) sometimes embed the JSON in wrappers
                    const recovered = extractJSON(rawArgs);
                    if (recovered) {
                        try {
                            parsed = JSON.parse(recovered);
                        } catch {
                            /* fall through */
                        }
                    }
                }
            }

            // Fallback: if no tool call (some models may reply with prose), try to extract JSON from content
            if (!parsed) {
                const content = choice.message?.content;
                const text = typeof content === "string" ? content : "";
                const jsonStr = extractJSON(text);
                if (jsonStr) {
                    try {
                        parsed = JSON.parse(jsonStr);
                    } catch {
                        /* fall through */
                    }
                }
            }

            if (!parsed || !Array.isArray(parsed.slides) || parsed.slides.length === 0) {
                lastError = `${label}: outline missing slides array`;
                continue;
            }

            const slides = normalizeSlides(parsed.slides);

            return {
                id: cryptoRandomId(),
                title: parsed.title?.toString().trim() || "Untitled Presentation",
                subtitle: parsed.subtitle?.toString().trim(),
                audience,
                tone,
                archetype,
                themeId: args.themeId ?? "clean",
                slides,
                createdAt: new Date().toISOString(),
            };
        } catch (err) {
            lastError = `${label}: ${(err as Error).message}`;
            // Continue to next attempt
        }
    }

    throw new Error(`Outline generation failed after all attempts. Last: ${lastError}`);
}

// ── Sanitize slides: enforce archetype enum + strip emoji from titles ──

const EMOJI_RE =
    /[\u{2600}-\u{27BF}\u{1F000}-\u{1FFFF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u2713\u2717\u2714\u2716]/gu;

function normalizeSlides(raw: Slide[]): Slide[] {
    const validArchetypes = new Set<string>(LAYOUT_ARCHETYPES as readonly string[]);
    const cleaned: Slide[] = raw.map((s) => {
        if (!validArchetypes.has(s.archetype)) {
            s.archetype = "content";
        }
        if (typeof s.title === "string") {
            s.title = s.title.replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
        }
        if (Array.isArray(s.bullets)) {
            s.bullets = s.bullets
                .map((b) => {
                    if (typeof b !== "string") return "";
                    return b
                        .replace(EMOJI_RE, "")
                        .replace(/^\s*[•\-–—*·●◆▪►▸]\s*/, "") // strip leading bullet markers (LLMs sometimes add them)
                        .replace(/\s+/g, " ")
                        .trim();
                })
                .filter((b) => b.length > 0)
                .slice(0, 4);
        }
        return s;
    });

    // Ensure the first slide is the title slide
    if (cleaned[0] && cleaned[0].archetype !== "title") {
        cleaned.unshift({
            archetype: "title",
            title: cleaned[0].title || "Untitled",
        });
    }

    // Layout variety: if 'content' dominates, convert some content slides
    // into more interesting archetypes based on their payload shape.
    diversifyLayouts(cleaned);

    return cleaned;
}

function diversifyLayouts(slides: Slide[]): void {
    const n = slides.length;
    if (n <= 2) return;

    const contentCount = slides.filter((s) => s.archetype === "content").length;
    const contentRatio = contentCount / n;

    // Break long runs of identical archetypes (no 3+ in a row)
    for (let i = 2; i < n; i++) {
        if (slides[i].archetype === slides[i - 1].archetype && slides[i].archetype === slides[i - 2].archetype) {
            const alt = promoteArchetype(slides[i]);
            if (alt) slides[i].archetype = alt;
        }
    }

    // If more than 50% content, try to promote a few to richer archetypes
    if (contentRatio > 0.5) {
        for (const slide of slides) {
            if (slide.archetype !== "content") continue;
            const alt = promoteArchetype(slide);
            if (alt) slide.archetype = alt;
        }
    }
}

// Pick a richer archetype for a slide based on what fields it already has.
function promoteArchetype(slide: Slide): Slide["archetype"] | null {
    if (slide.bigNumber) return "stat-callout";
    if (slide.quote?.text) return "quote";
    if (slide.chart) return "chart-focus";
    if (slide.table?.headers?.length) return "comparison-table";
    if (slide.steps?.length && slide.steps.length >= 3) {
        return slide.steps.length >= 5 ? "timeline" : "process-steps";
    }
    if (slide.columns?.length === 2) return "two-column";
    if (slide.columns?.length === 3) return "bento-3";
    if (slide.columns?.length === 4) return "bento-4";
    return null;
}

function cryptoRandomId(): string {
    return randomBytes(6).toString("hex");
}
