// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient } from "../../llm.js";
import { MODELS } from "../../llm.js";
import { extractJSON } from "../../utils/json-extract.js";
import { LAYOUT_ARCHETYPES, type PresentationOutline, type Slide } from "./types.js";

// ── Edit Operations ──────────────────────────

export type EditOp =
    | { kind: "edit_title"; index: number; title: string }
    | { kind: "edit_subtitle"; index: number; subtitle: string }
    | { kind: "edit_bullets"; index: number; bullets: string[] }
    | { kind: "edit_body"; index: number; body: string }
    | { kind: "edit_speaker_notes"; index: number; speakerNotes: string }
    | { kind: "change_archetype"; index: number; archetype: Slide["archetype"] }
    | { kind: "add_slide"; afterIndex: number; slide: Slide }
    | { kind: "remove_slide"; index: number }
    | { kind: "reorder"; fromIndex: number; toIndex: number }
    | { kind: "change_theme"; themeId: string };

// ── LLM-driven patch generation ──────────────
// The user gives a natural-language instruction; the LLM emits a list of
// concrete edit operations targeting specific slide indices.

function buildPatchPrompt(
    outline: PresentationOutline,
    instruction: string,
): string {
    const summary = outline.slides.map((s, i) =>
        `  ${i + 1}. [${s.archetype}] "${s.title}"`).join("\n");

    return `You are editing an existing presentation.

CURRENT DECK "${outline.title}" (theme=${outline.themeId}, ${outline.slides.length} slides):
${summary}

USER INSTRUCTION:
${instruction}

Return STRICT JSON — an array of edit operations to apply, in order:
{
  "ops": [
    {"kind": "edit_title", "index": 0, "title": "new title"},
    {"kind": "edit_bullets", "index": 2, "bullets": ["new", "bullets"]},
    {"kind": "edit_speaker_notes", "index": 1, "speakerNotes": "..."},
    {"kind": "change_archetype", "index": 3, "archetype": "bento-3"},
    {"kind": "add_slide", "afterIndex": 4, "slide": { "archetype": "content", "title": "New action-title slide", "bullets": [...] }},
    {"kind": "remove_slide", "index": 5},
    {"kind": "reorder", "fromIndex": 2, "toIndex": 4},
    {"kind": "change_theme", "themeId": "midnight"}
  ]
}

CRITICAL RULES:
- index is ZERO-based over the CURRENT deck (before any edits apply).
- Multiple ops are applied IN ORDER — after removing a slide, later indices shift. You MUST account for that when combining ops. Prefer one op per slide when possible.
- When adding a slide, the "slide" object must include an "archetype" from: ${LAYOUT_ARCHETYPES.join(", ")}.
- All new titles must contain a verb (action titles). "Revenue" is bad; "Revenue grew 42% YoY" is good.
- Bullets must stay <=4 items, grammatically parallel.
- Only output the JSON — no prose, no fences, no commentary.
- If the instruction is ambiguous, pick the most reasonable interpretation and proceed.`;
}

// ── Apply a single operation ──────────────────

export function applyOp(outline: PresentationOutline, op: EditOp): void {
    switch (op.kind) {
        case "edit_title": {
            const s = outline.slides[op.index];
            if (s) s.title = op.title;
            return;
        }
        case "edit_subtitle": {
            const s = outline.slides[op.index];
            if (s) s.subtitle = op.subtitle;
            return;
        }
        case "edit_bullets": {
            const s = outline.slides[op.index];
            if (s) s.bullets = op.bullets.slice(0, 4);
            return;
        }
        case "edit_body": {
            const s = outline.slides[op.index];
            if (s) s.body = op.body;
            return;
        }
        case "edit_speaker_notes": {
            const s = outline.slides[op.index];
            if (s) s.speakerNotes = op.speakerNotes;
            return;
        }
        case "change_archetype": {
            const s = outline.slides[op.index];
            if (s && (LAYOUT_ARCHETYPES as readonly string[]).includes(op.archetype)) {
                s.archetype = op.archetype;
            }
            return;
        }
        case "add_slide": {
            const insertAt = Math.min(Math.max(op.afterIndex + 1, 0), outline.slides.length);
            outline.slides.splice(insertAt, 0, op.slide);
            return;
        }
        case "remove_slide": {
            if (op.index >= 0 && op.index < outline.slides.length) {
                outline.slides.splice(op.index, 1);
            }
            return;
        }
        case "reorder": {
            const { fromIndex, toIndex } = op;
            if (
                fromIndex < 0 || fromIndex >= outline.slides.length ||
                toIndex < 0 || toIndex >= outline.slides.length ||
                fromIndex === toIndex
            ) return;
            const [slide] = outline.slides.splice(fromIndex, 1);
            outline.slides.splice(toIndex, 0, slide);
            return;
        }
        case "change_theme": {
            outline.themeId = op.themeId;
            return;
        }
    }
}

// ── High-level modify: instruction → ops → apply ──

export async function generatePatch(
    llm: LLMClient,
    outline: PresentationOutline,
    instruction: string,
): Promise<EditOp[]> {
    const prompt = buildPatchPrompt(outline, instruction);
    const response = await llm.chat({
        messages: [{ role: "user", content: prompt }],
        modelOverride: MODELS.SONNET,
        systemPrompt: "Return only the JSON object with an 'ops' array. No prose.",
    });

    const text = response.choices?.[0]?.message?.content ?? "";
    const jsonStr = extractJSON(typeof text === "string" ? text : JSON.stringify(text));
    if (!jsonStr) throw new Error("Modify LLM call did not return parseable JSON");

    const parsed = JSON.parse(jsonStr) as { ops?: EditOp[] };
    if (!parsed.ops || !Array.isArray(parsed.ops)) {
        throw new Error("Modify response missing 'ops' array");
    }
    return parsed.ops;
}

export function applyPatch(outline: PresentationOutline, ops: EditOp[]): string[] {
    const summary: string[] = [];
    for (const op of ops) {
        try {
            applyOp(outline, op);
            summary.push(describeOp(op));
        } catch (err) {
            summary.push(`FAILED: ${op.kind} — ${(err as Error).message}`);
        }
    }
    return summary;
}

function describeOp(op: EditOp): string {
    switch (op.kind) {
        case "edit_title": return `Edited title of slide ${op.index + 1}`;
        case "edit_subtitle": return `Edited subtitle of slide ${op.index + 1}`;
        case "edit_bullets": return `Edited bullets of slide ${op.index + 1} (${op.bullets.length} items)`;
        case "edit_body": return `Edited body of slide ${op.index + 1}`;
        case "edit_speaker_notes": return `Edited speaker notes of slide ${op.index + 1}`;
        case "change_archetype": return `Changed slide ${op.index + 1} layout to ${op.archetype}`;
        case "add_slide": return `Added new ${op.slide.archetype} slide after position ${op.afterIndex + 1}`;
        case "remove_slide": return `Removed slide ${op.index + 1}`;
        case "reorder": return `Moved slide ${op.fromIndex + 1} to position ${op.toIndex + 1}`;
        case "change_theme": return `Changed theme to ${op.themeId}`;
    }
}
