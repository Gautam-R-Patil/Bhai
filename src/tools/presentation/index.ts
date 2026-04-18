// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "../get-current-time.js";
import type { LLMClient } from "../../llm.js";
import { generateOutline } from "./outline.js";
import { renderPptx } from "./render-pptx.js";
import { getTelegramContext } from "../send-file.js";
import { listThemeIds } from "./themes.js";
import { resolveAssets, clearAssetCache } from "./assets.js";
import { auditOutline, applyAutoFixes } from "./design-rules.js";
import { generatePatch, applyPatch } from "./modify.js";
import { renderHtml } from "./render-html.js";
import type { DeckArchetype, PresentationOutline, Slide } from "./types.js";

// ── LLM client injection (follows swarm-tool.ts pattern) ──

let _llm: LLMClient | null = null;

export function setPresentationLLM(llm: LLMClient): void {
    _llm = llm;
}

// ── In-memory outline store ────────────────────
// Session-scoped; persists only for current process. Follow-up ops
// (modify, export, add_slide) key off outline_id from this map.

const outlineStore = new Map<string, PresentationOutline>();

export function getOutline(id: string): PresentationOutline | undefined {
    return outlineStore.get(id);
}

export function saveOutline(outline: PresentationOutline): void {
    outlineStore.set(outline.id, outline);
}

// ── Asset resolution for slides that want imagery ──
// Only slides with an archetype that benefits visually AND carry an imagePrompt
// get an image. Keeps decks from becoming image-soup.

async function resolveSlideImages(outline: PresentationOutline): Promise<void> {
    const imageArchetypes = new Set<Slide["archetype"]>([
        "image-full-bleed",
        "content",
        "section-divider",
    ]);

    const requests = outline.slides
        .map((slide, i) => ({ slide, i }))
        .filter(({ slide }) =>
            slide.imagePrompt &&
            slide.imagePrompt.trim().length > 0 &&
            imageArchetypes.has(slide.archetype),
        )
        .map(({ slide, i }) => ({
            id: String(i),
            opts: {
                prompt: slide.imagePrompt ?? "",
                slideTitle: slide.title,
                aspectRatio:
                    slide.archetype === "image-full-bleed"
                        ? ("16:9" as const)
                        : ("4:3" as const),
            },
        }));

    if (requests.length === 0) return;

    console.log(`  🖼️  Resolving ${requests.length} image(s) in parallel...`);
    const results = await resolveAssets(requests, 3);

    let resolved = 0;
    for (const [idStr, asset] of results) {
        if (!asset) continue;
        const idx = Number(idStr);
        const slide = outline.slides[idx];
        if (slide) {
            slide.imagePath = asset.path;
            if (asset.attribution) {
                slide.speakerNotes =
                    (slide.speakerNotes ?? "") +
                    (slide.speakerNotes ? "\n\n" : "") +
                    `Image: ${asset.attribution}`;
            }
            resolved++;
        }
    }
    console.log(`  🖼️  Resolved ${resolved}/${requests.length} images`);
}

// ── Tool: create_presentation ─────────────────

export const createPresentation: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "create_presentation",
            description:
                "Create a professional slide deck (PPTX by default) from a natural-language prompt. Produces an editable PowerPoint file with action-titled slides, varied layouts (bento grids, stat callouts, quotes, charts, two-column, timeline, etc.), and optional charts. Use when the user asks you to make a presentation, slide deck, pitch, PPT, PowerPoint, Keynote, slides, or similar. The file is saved locally and auto-sent to the user on the active channel.",
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description: "What the presentation should be about. Include the core topic, any key facts/data to cover, and the goal (e.g. 'pitch deck for an AI pet-collar startup raising seed, 10 slides, emphasize market size').",
                    },
                    num_slides: {
                        type: "number",
                        description: "Approximate target slide count (3-50). Defaults to 8.",
                    },
                    audience: {
                        type: "string",
                        description: "Who the deck is for (e.g. 'investors', 'engineering team', 'executives'). Influences tone and depth.",
                    },
                    tone: {
                        type: "string",
                        description: "Tone — e.g. 'formal', 'conversational', 'urgent', 'inspirational'.",
                    },
                    archetype: {
                        type: "string",
                        enum: ["pitch", "sales", "research", "qbr", "training", "keynote", "board", "general"],
                        description: "Deck type — 'pitch' for fundraising, 'sales' for customer-facing, 'research' for findings, 'qbr' for quarterly review, 'training' for educational, 'keynote' for product launch, 'board' for board meeting, 'general' otherwise.",
                    },
                    theme: {
                        type: "string",
                        description: `Visual theme id. Options: ${listThemeIds().join(", ")}. Defaults to 'clean'.`,
                    },
                    skip_images: {
                        type: "boolean",
                        description: "Skip image generation to make the render faster (title-and-text deck). Defaults to false.",
                    },
                },
                required: ["prompt"],
            },
        },
    },

    async handler(input) {
        if (!_llm) {
            return JSON.stringify({
                error: "Presentation tool not initialized — LLM client not injected.",
            });
        }

        try {
            const prompt = input.prompt as string;
            if (!prompt || prompt.trim().length === 0) {
                return JSON.stringify({ error: "Prompt is required." });
            }

            const numSlides = typeof input.num_slides === "number" ? input.num_slides : undefined;
            const audience = (input.audience as string | undefined) ?? undefined;
            const tone = (input.tone as string | undefined) ?? undefined;
            const archetype = (input.archetype as DeckArchetype | undefined) ?? undefined;
            const themeId = (input.theme as string | undefined) ?? undefined;

            console.log(`  📊 Creating presentation: "${prompt.substring(0, 80)}..."`);

            // Step 1: outline
            const outline = await generateOutline(_llm, {
                prompt,
                numSlides,
                audience,
                tone,
                archetype,
                themeId,
            });
            console.log(`  📋 Outline: "${outline.title}" (${outline.slides.length} slides, theme=${outline.themeId})`);

            // Step 1b: design audit + auto-fixes
            const autoFixes = applyAutoFixes(outline);
            if (autoFixes.length > 0) {
                console.log(`  🛠️  Auto-fixes applied: ${autoFixes.length}`);
            }
            const audit = auditOutline(outline);
            if (!audit.passes) {
                console.log(`  ⚠️  Design audit: ${audit.slideIssues.length} slides with issues, ${audit.warnings.length} deck warnings`);
            }

            saveOutline(outline);

            // Step 2: resolve images in parallel for slides that request them
            const skipImages = input.skip_images === true;
            if (!skipImages) {
                await resolveSlideImages(outline);
            }

            // Step 3: render
            const { filePath, sizeKb, warnings } = await renderPptx(outline);
            console.log(`  ✅ Rendered: ${filePath} (${sizeKb}KB)`);
            clearAssetCache();

            // Step 3: auto-deliver on active channel (Telegram for now; other channels via send_file)
            let delivered = false;
            const { bot, chatId } = getTelegramContext();
            if (bot && chatId) {
                try {
                    const { InputFile } = await import("grammy");
                    const fs = await import("node:fs");
                    const path = await import("node:path");
                    const buf = fs.readFileSync(filePath);
                    const filename = path.basename(filePath);
                    await bot.api.sendDocument(chatId, new InputFile(buf, filename), {
                        caption: outline.title,
                    });
                    delivered = true;
                    console.log(`  📤 Deck sent to Telegram`);
                } catch (sendErr) {
                    console.warn(`  ⚠️ Auto-send failed: ${(sendErr as Error).message}`);
                }
            }

            return JSON.stringify({
                success: true,
                outline_id: outline.id,
                title: outline.title,
                slide_count: outline.slides.length,
                file_path: filePath,
                size_kb: sizeKb,
                theme: outline.themeId,
                delivered,
                warnings: warnings.length > 0 ? warnings : undefined,
                auto_fixes: autoFixes.length > 0 ? autoFixes : undefined,
                design_audit: audit.passes
                    ? "pass"
                    : {
                        slide_issues: audit.slideIssues,
                        deck_warnings: audit.warnings,
                    },
                tip: delivered
                    ? "Deck sent to user. Tell them it's ready and mention the theme/slide count."
                    : "Deck saved — use send_file to deliver it to the user.",
            });
        } catch (err) {
            console.error(`  ❌ Presentation generation failed:`, err);
            return JSON.stringify({
                error: `Presentation generation failed: ${(err as Error).message}`,
            });
        }
    },
};

// ── Tool: list_presentations ──────────────────

export const listPresentations: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "list_presentations",
            description: "List presentations created in the current session. Returns their IDs, titles, slide counts, and file paths. Useful before calling export_presentation or modify_presentation on a specific deck.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },

    async handler() {
        const decks = Array.from(outlineStore.values()).map((o) => ({
            id: o.id,
            title: o.title,
            slide_count: o.slides.length,
            archetype: o.archetype,
            theme: o.themeId,
            created_at: o.createdAt,
        }));
        return JSON.stringify({ count: decks.length, presentations: decks });
    },
};

// ── Tool: modify_presentation ─────────────────

export const modifyPresentation: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "modify_presentation",
            description: "Modify an existing presentation created earlier in this session. Takes the outline_id (from create_presentation or list_presentations) and a natural-language instruction describing the changes. The agent will translate the instruction into concrete edits — change titles, bullets, layouts, add/remove slides, switch themes — and re-render the deck. Use when the user asks to edit, change, update, tweak, fix, or add to an existing deck.",
            parameters: {
                type: "object",
                properties: {
                    outline_id: {
                        type: "string",
                        description: "The id of the presentation to modify (from create_presentation's response or list_presentations).",
                    },
                    instruction: {
                        type: "string",
                        description: "What to change, in natural language. Examples: 'Change slide 3 title to say revenue grew 42% YoY', 'Add a closing CTA slide after slide 7', 'Remove slide 5', 'Switch the theme to midnight', 'Turn slide 4 into a bento-3 layout', 'Make the bullets on slide 2 more concise'.",
                    },
                    format: {
                        type: "string",
                        enum: ["pptx", "html"],
                        description: "Output format for the modified deck. Defaults to 'pptx'.",
                    },
                },
                required: ["outline_id", "instruction"],
            },
        },
    },

    async handler(input) {
        if (!_llm) {
            return JSON.stringify({ error: "Presentation tool not initialized — LLM client not injected." });
        }

        const outlineId = input.outline_id as string;
        const instruction = input.instruction as string;
        const format = ((input.format as string) ?? "pptx").toLowerCase();

        const outline = outlineStore.get(outlineId);
        if (!outline) {
            const known = Array.from(outlineStore.keys()).slice(0, 5);
            return JSON.stringify({
                error: `No presentation with id '${outlineId}' in current session.`,
                known_ids: known,
                tip: "Call list_presentations to see available decks.",
            });
        }

        try {
            console.log(`  ✏️  Modifying "${outline.title}" — "${instruction.substring(0, 80)}..."`);

            // Step 1: LLM turns instruction into ops
            const ops = await generatePatch(_llm, outline, instruction);
            console.log(`  ✏️  LLM produced ${ops.length} edit op(s)`);

            // Step 2: apply
            const changes = applyPatch(outline, ops);

            // Step 3: re-audit + auto-fix
            const autoFixes = applyAutoFixes(outline);
            const audit = auditOutline(outline);

            // Step 4: re-render (format-aware)
            let filePath: string;
            let sizeKb: number;
            let warnings: string[] = [];

            if (format === "html") {
                const res = await renderHtml(outline);
                filePath = res.filePath;
                sizeKb = res.sizeKb;
            } else {
                const res = await renderPptx(outline);
                filePath = res.filePath;
                sizeKb = res.sizeKb;
                warnings = res.warnings;
            }

            console.log(`  ✅ Re-rendered: ${filePath} (${sizeKb}KB)`);

            // Step 5: auto-deliver
            let delivered = false;
            const { bot, chatId } = getTelegramContext();
            if (bot && chatId) {
                try {
                    const { InputFile } = await import("grammy");
                    const fs = await import("node:fs");
                    const path = await import("node:path");
                    const buf = fs.readFileSync(filePath);
                    const filename = path.basename(filePath);
                    await bot.api.sendDocument(chatId, new InputFile(buf, filename), {
                        caption: `${outline.title} (modified)`,
                    });
                    delivered = true;
                } catch (sendErr) {
                    console.warn(`  ⚠️ Auto-send failed: ${(sendErr as Error).message}`);
                }
            }

            return JSON.stringify({
                success: true,
                outline_id: outline.id,
                title: outline.title,
                slide_count: outline.slides.length,
                file_path: filePath,
                size_kb: sizeKb,
                format,
                changes_made: changes,
                auto_fixes: autoFixes.length > 0 ? autoFixes : undefined,
                design_audit: audit.passes ? "pass" : { slide_issues: audit.slideIssues, deck_warnings: audit.warnings },
                warnings: warnings.length > 0 ? warnings : undefined,
                delivered,
            });
        } catch (err) {
            console.error(`  ❌ Modify failed:`, err);
            return JSON.stringify({ error: `Modify failed: ${(err as Error).message}` });
        }
    },
};

// ── Tool: export_presentation ─────────────────

export const exportPresentation: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "export_presentation",
            description: "Re-render an existing presentation in a different format (PPTX or HTML/Reveal.js). Use after create_presentation or modify_presentation when the user asks for the deck in a different format. The same outline produces all formats — no quality loss.",
            parameters: {
                type: "object",
                properties: {
                    outline_id: {
                        type: "string",
                        description: "The id of the presentation to export (from create_presentation's response or list_presentations).",
                    },
                    format: {
                        type: "string",
                        enum: ["pptx", "html"],
                        description: "Target format. Defaults to 'pptx'.",
                    },
                },
                required: ["outline_id", "format"],
            },
        },
    },

    async handler(input) {
        const outlineId = input.outline_id as string;
        const format = ((input.format as string) ?? "pptx").toLowerCase();

        const outline = outlineStore.get(outlineId);
        if (!outline) {
            return JSON.stringify({
                error: `No presentation with id '${outlineId}' in current session.`,
                tip: "Call list_presentations to see available decks.",
            });
        }

        try {
            let filePath: string;
            let sizeKb: number;

            if (format === "html") {
                const res = await renderHtml(outline);
                filePath = res.filePath;
                sizeKb = res.sizeKb;
            } else if (format === "pptx") {
                const res = await renderPptx(outline);
                filePath = res.filePath;
                sizeKb = res.sizeKb;
            } else {
                return JSON.stringify({ error: `Unsupported format '${format}'. Use 'pptx' or 'html'.` });
            }

            // Auto-deliver
            let delivered = false;
            const { bot, chatId } = getTelegramContext();
            if (bot && chatId) {
                try {
                    const { InputFile } = await import("grammy");
                    const fs = await import("node:fs");
                    const path = await import("node:path");
                    const buf = fs.readFileSync(filePath);
                    const filename = path.basename(filePath);
                    await bot.api.sendDocument(chatId, new InputFile(buf, filename), {
                        caption: `${outline.title} (${format})`,
                    });
                    delivered = true;
                } catch { /* fall through */ }
            }

            return JSON.stringify({
                success: true,
                outline_id: outline.id,
                file_path: filePath,
                size_kb: sizeKb,
                format,
                delivered,
            });
        } catch (err) {
            return JSON.stringify({ error: `Export failed: ${(err as Error).message}` });
        }
    },
};
