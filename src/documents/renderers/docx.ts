// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── DOCX renderer ───────────────────────────────
// Two modes:
//   1. docxtemplater against a bundled .docx template — when a template file
//      is present in the template directory.
//   2. Programmatic generation via `docx` — when rendering a GeneralDocument
//      blocks tree without a template (fallback).

import fs from "node:fs";
import path from "node:path";
import type { DocumentBlock, GeneralDocument, Resume } from "../schema.js";
import { readTemplateBinary, type TemplateMeta } from "../templates.js";

export interface RenderDocxOptions {
    outputPath: string;
}

/** Render using a docxtemplater template if available, otherwise fall back. */
export async function renderDocxTemplate(
    tpl: TemplateMeta | null,
    data: Record<string, unknown>,
    opts: RenderDocxOptions,
): Promise<string> {
    if (tpl && tpl.renderKind === "docx") {
        return renderWithDocxtemplater(tpl, data, opts);
    }
    // Fallback to programmatic generation
    return renderProgrammaticDocx(data, opts);
}

async function renderWithDocxtemplater(
    tpl: TemplateMeta,
    data: Record<string, unknown>,
    opts: RenderDocxOptions,
): Promise<string> {
    const { default: Docxtemplater } = await import("docxtemplater");
    const PizZip = (await import("pizzip")).default;

    const content = readTemplateBinary(tpl);
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
    });
    doc.render(data);
    const buf = doc.getZip().generate({ type: "nodebuffer" });
    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
    fs.writeFileSync(opts.outputPath, buf);
    return opts.outputPath;
}

function isResume(data: unknown): data is Resume {
    return !!(
        data &&
        typeof data === "object" &&
        ("basics" in (data as object) || "work" in (data as object) || "education" in (data as object))
    );
}

function isGeneralDocument(data: unknown): data is GeneralDocument {
    return !!(
        data &&
        typeof data === "object" &&
        "blocks" in (data as object) &&
        Array.isArray((data as GeneralDocument).blocks)
    );
}

/** Fallback DOCX generation from structured data using `docx`. */
async function renderProgrammaticDocx(data: Record<string, unknown>, opts: RenderDocxOptions): Promise<string> {
    const docx = await import("docx");
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = docx;

    const children: InstanceType<typeof Paragraph>[] = [];

    if (isResume(data)) {
        children.push(...buildResumeDocxChildren(data, docx));
    } else if (isGeneralDocument(data)) {
        children.push(...buildGeneralDocxChildren(data, docx));
    } else {
        children.push(
            new Paragraph({
                children: [new TextRun(JSON.stringify(data, null, 2))],
            }),
        );
    }

    const doc = new Document({
        sections: [
            {
                properties: {},
                children,
            },
        ],
    });

    const buf = await Packer.toBuffer(doc);
    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
    fs.writeFileSync(opts.outputPath, buf);
    return opts.outputPath;
}

function buildResumeDocxChildren(r: Resume, docx: typeof import("docx")): InstanceType<typeof docx.Paragraph>[] {
    const { Paragraph, TextRun, HeadingLevel, AlignmentType } = docx;
    const out: InstanceType<typeof Paragraph>[] = [];

    if (r.basics?.name) {
        out.push(
            new Paragraph({
                heading: HeadingLevel.TITLE,
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: r.basics.name, bold: true, size: 40 })],
            }),
        );
    }
    if (r.basics?.label) {
        out.push(
            new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: r.basics.label, italics: true })],
            }),
        );
    }
    const contactLine = [r.basics?.email, r.basics?.phone, r.basics?.url, r.basics?.location?.city]
        .filter(Boolean)
        .join(" · ");
    if (contactLine) {
        out.push(
            new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: contactLine, size: 20 })],
            }),
        );
    }
    if (r.basics?.summary) {
        out.push(new Paragraph({ children: [new TextRun("")] }));
        out.push(new Paragraph({ children: [new TextRun(r.basics.summary)] }));
    }

    if (r.work?.length) {
        out.push(sectionHeading("Experience", docx));
        for (const w of r.work) {
            out.push(
                new Paragraph({
                    children: [
                        new TextRun({ text: `${w.position ?? ""}`, bold: true }),
                        new TextRun({ text: ` — ${w.name ?? ""}`, bold: false }),
                    ],
                }),
            );
            const dateRange = [w.startDate, w.endDate ?? "Present"].filter(Boolean).join(" – ");
            if (dateRange) {
                out.push(
                    new Paragraph({
                        children: [new TextRun({ text: dateRange, italics: true, size: 20 })],
                    }),
                );
            }
            if (w.summary) {
                out.push(new Paragraph({ children: [new TextRun(w.summary)] }));
            }
            for (const h of w.highlights ?? []) {
                out.push(
                    new Paragraph({
                        bullet: { level: 0 },
                        children: [new TextRun(h)],
                    }),
                );
            }
            out.push(new Paragraph({ children: [new TextRun("")] }));
        }
    }

    if (r.education?.length) {
        out.push(sectionHeading("Education", docx));
        for (const e of r.education) {
            out.push(
                new Paragraph({
                    children: [
                        new TextRun({ text: e.institution ?? "", bold: true }),
                        new TextRun({ text: e.area ? ` — ${e.studyType ?? ""} ${e.area}` : "" }),
                    ],
                }),
            );
            const dates = [e.startDate, e.endDate].filter(Boolean).join(" – ");
            if (dates) {
                out.push(new Paragraph({ children: [new TextRun({ text: dates, italics: true, size: 20 })] }));
            }
        }
    }

    if (r.skills?.length) {
        out.push(sectionHeading("Skills", docx));
        for (const s of r.skills) {
            const kw = (s.keywords ?? []).join(", ");
            out.push(
                new Paragraph({
                    children: [new TextRun({ text: `${s.name ?? ""}: `, bold: true }), new TextRun(kw)],
                }),
            );
        }
    }

    if (r.projects?.length) {
        out.push(sectionHeading("Projects", docx));
        for (const p of r.projects) {
            out.push(
                new Paragraph({
                    children: [new TextRun({ text: p.name ?? "", bold: true })],
                }),
            );
            if (p.description) {
                out.push(new Paragraph({ children: [new TextRun(p.description)] }));
            }
            for (const h of p.highlights ?? []) {
                out.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(h)] }));
            }
        }
    }

    return out;
}

function buildGeneralDocxChildren(
    g: GeneralDocument,
    docx: typeof import("docx"),
): InstanceType<typeof docx.Paragraph>[] {
    const { Paragraph, TextRun, HeadingLevel, AlignmentType } = docx;
    const out: InstanceType<typeof Paragraph>[] = [];

    out.push(
        new Paragraph({
            heading: HeadingLevel.TITLE,
            children: [new TextRun({ text: g.title, bold: true })],
        }),
    );
    if (g.subtitle) {
        out.push(
            new Paragraph({
                children: [new TextRun({ text: g.subtitle, italics: true })],
            }),
        );
    }
    if (g.author || g.date) {
        const line = [g.author, g.date].filter(Boolean).join(" · ");
        out.push(new Paragraph({ children: [new TextRun({ text: line, size: 20 })] }));
    }
    if (g.recipient) {
        const r = g.recipient;
        const addr = [r.name, r.title, r.company, r.address].filter(Boolean);
        for (const line of addr) {
            out.push(new Paragraph({ children: [new TextRun(String(line))] }));
        }
    }
    out.push(new Paragraph({ children: [new TextRun("")] }));

    for (const block of g.blocks) {
        out.push(...blockToDocx(block, docx));
    }
    return out;
}

function blockToDocx(block: DocumentBlock, docx: typeof import("docx")): InstanceType<typeof docx.Paragraph>[] {
    const { Paragraph, TextRun, HeadingLevel } = docx;
    switch (block.type) {
        case "heading": {
            const hlv =
                block.level === 1
                    ? HeadingLevel.HEADING_1
                    : block.level === 2
                      ? HeadingLevel.HEADING_2
                      : block.level === 3
                        ? HeadingLevel.HEADING_3
                        : HeadingLevel.HEADING_4;
            return [
                new Paragraph({
                    heading: hlv,
                    children: [new TextRun({ text: block.text, bold: true })],
                }),
            ];
        }
        case "paragraph":
            return [new Paragraph({ children: [new TextRun(block.text)] })];
        case "list":
            return block.items.map(
                (item) =>
                    new Paragraph({
                        bullet: block.ordered ? undefined : { level: 0 },
                        numbering: block.ordered ? { reference: "default-numbering", level: 0 } : undefined,
                        children: [new TextRun(item)],
                    }),
            );
        case "table": {
            // Simple table fallback: render rows as tab-separated paragraphs.
            const paragraphs: InstanceType<typeof Paragraph>[] = [];
            if (block.headers) {
                paragraphs.push(
                    new Paragraph({
                        children: [new TextRun({ text: block.headers.join("\t"), bold: true })],
                    }),
                );
            }
            for (const row of block.rows) {
                paragraphs.push(new Paragraph({ children: [new TextRun(row.join("\t"))] }));
            }
            return paragraphs;
        }
        case "divider":
            return [new Paragraph({ children: [new TextRun("————————————————")] })];
        case "spacer":
            return [new Paragraph({ children: [new TextRun("")] })];
        case "markdown":
            // Strip markdown markers for DOCX output (best-effort).
            return [new Paragraph({ children: [new TextRun(stripMd(block.text))] })];
        case "image":
            // Image embedding in programmatic DOCX would need buffer loading —
            // skip for v1 fallback.
            return [
                new Paragraph({
                    children: [new TextRun({ text: `[image: ${block.alt ?? block.src}]`, italics: true })],
                }),
            ];
        default:
            return [];
    }
}

function sectionHeading(text: string, docx: typeof import("docx")): InstanceType<typeof docx.Paragraph> {
    const { Paragraph, TextRun, HeadingLevel } = docx;
    return new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text, bold: true })],
    });
}

function stripMd(text: string): string {
    return text
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/`(.*?)`/g, "$1")
        .replace(/^#+\s*/gm, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}
