// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Render orchestrator ─────────────────────────
// Given a stored document + desired format, picks the right template and
// renderer and returns the output path under getExportsDir().

import { generateFilePath } from "../config/paths.js";
import { enrichWithBody } from "./blocks-to-md.js";
import { renderDocxTemplate } from "./renderers/docx.js";
import { renderHtmlTemplateToPdf } from "./renderers/html.js";
import { renderMarkdownTemplateToPdf } from "./renderers/markdown.js";
import type { GeneralDocument, StoredDocument } from "./schema.js";
import { getTemplate, pickDefaultTemplate, type TemplateFormat, type TemplateMeta } from "./templates.js";

export interface RenderResult {
    path: string;
    format: TemplateFormat;
    templateId: string | null;
    sizeBytes: number;
}

export async function renderDocument(
    doc: StoredDocument,
    format: TemplateFormat,
    templateIdOverride?: string,
): Promise<RenderResult> {
    const tplId = templateIdOverride ?? doc.templateId;
    let tpl: TemplateMeta | null = tplId ? getTemplate(tplId) : null;
    // If the saved template doesn't support the requested format, fall back
    // to a format-compatible default rather than erroring — common case:
    // user saved a PDF-only template but now wants DOCX.
    if (tpl && !tpl.supports.includes(format)) {
        const fallback = pickDefaultTemplate(doc.type, format);
        tpl = fallback ?? null;
    }
    if (!tpl) {
        tpl = pickDefaultTemplate(doc.type, format);
    }
    if (!tpl && format === "pdf") {
        throw new Error(`No template available for type=${doc.type} format=${format}`);
    }

    const safeBase =
        doc.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 40) || doc.type;
    const ext = format === "docx" ? "docx" : "pdf";
    const outputPath = generateFilePath(safeBase, ext, "Exports");

    // For block-based general documents, pre-flatten blocks into a markdown
    // `body` string so markdown templates can render with {{{body}}}.
    const rawData = doc.data as Record<string, unknown>;
    const data: Record<string, unknown> =
        doc.type !== "resume" && Array.isArray((rawData as GeneralDocument).blocks)
            ? (enrichWithBody(rawData as GeneralDocument) as unknown as Record<string, unknown>)
            : rawData;

    if (format === "docx") {
        // If template is DOCX → templater. Otherwise programmatic fallback.
        const usedTpl = tpl && tpl.renderKind === "docx" ? tpl : null;
        await renderDocxTemplate(usedTpl, data, { outputPath });
    } else {
        // PDF
        if (!tpl) throw new Error("No PDF template found");
        if (tpl.renderKind === "markdown") {
            await renderMarkdownTemplateToPdf(tpl, data, { outputPath });
        } else {
            // html + resumed-theme both go through HTML path; resumed-theme
            // will be added later via a separate renderer.
            await renderHtmlTemplateToPdf(tpl, data, { outputPath });
        }
    }

    const sizeBytes = (await import("node:fs")).statSync(outputPath).size;
    return {
        path: outputPath,
        format,
        templateId: tpl?.id ?? null,
        sizeBytes,
    };
}
