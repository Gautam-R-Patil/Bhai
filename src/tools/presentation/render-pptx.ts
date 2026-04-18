// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import path from "node:path";
import fs from "node:fs";
// pptxgenjs ships CJS + ESM; default-import interop varies, so we resolve
// the constructor at runtime and give it a typed handle.
import pptxgenjsModule from "pptxgenjs";
import { getPresentationsDir } from "../../config/paths.js";
import type { PresentationOutline, Slide, Theme, ChartSpec } from "./types.js";
import { getTheme } from "./themes.js";

type PptxCtor = new () => {
    layout: string;
    title?: string;
    author?: string;
    company?: string;
    subject?: string;
    addSlide: () => PptxSlide;
    writeFile: (opts: { fileName: string }) => Promise<string>;
};

type PptxSlide = {
    background?: { color: string };
    title?: string;
    addText: (text: unknown, opts: Record<string, unknown>) => void;
    addShape: (type: string, opts: Record<string, unknown>) => void;
    addImage: (opts: Record<string, unknown>) => void;
    addChart: (type: string, data: unknown, opts: Record<string, unknown>) => void;
    addTable: (rows: unknown[][], opts: Record<string, unknown>) => void;
    addNotes: (text: string) => void;
};

// Handle both ESM default and CJS-style module shapes.
const PptxGenJS = ((pptxgenjsModule as { default?: unknown }).default ?? pptxgenjsModule) as PptxCtor;

// Slide dimensions (16:9, inches).
const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const PAD = 0.6;                  // edge padding
const TITLE_H = 1.0;              // title area height
const BODY_Y = PAD + TITLE_H + 0.2;
const BODY_H = SLIDE_H - BODY_Y - PAD;

// ── Main Render Entry ─────────────────────────

export async function renderPptx(
    outline: PresentationOutline,
    opts?: { outputPath?: string },
): Promise<{ filePath: string; sizeKb: number; warnings: string[] }> {
    const theme = getTheme(outline.themeId);
    const pres = new PptxGenJS();

    pres.layout = "LAYOUT_WIDE";      // 13.333 x 7.5 inches
    pres.title = outline.title;
    pres.author = "A.T.L.A.S";
    pres.company = "A.T.L.A.S";
    pres.subject = outline.subtitle ?? "";

    const warnings: string[] = [];

    outline.slides.forEach((slide, i) => {
        const s = pres.addSlide();
        // Slide background
        s.background = { color: theme.colors.bg };
        // Alt text on slide itself via title
        try {
            s.title = slide.title;
        } catch { /* older versions — best effort */ }

        try {
            renderSlide(s, slide, theme, i === 0);
        } catch (err) {
            warnings.push(`Slide ${i + 1} (${slide.archetype}) render error: ${(err as Error).message}`);
            // Fallback: render as content-only so we don't lose the slide entirely
            renderTitleOnly(s, slide, theme);
        }

        if (slide.speakerNotes) {
            s.addNotes(slide.speakerNotes);
        }
    });

    // File path
    const outputPath = opts?.outputPath ?? makeOutputPath(outline);
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    await pres.writeFile({ fileName: outputPath });

    let sizeKb = 0;
    try {
        sizeKb = Math.round(fs.statSync(outputPath).size / 1024);
    } catch { /* file might be at slight variation of path */ }

    return { filePath: outputPath, sizeKb, warnings };
}

function makeOutputPath(outline: PresentationOutline): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safe = outline.title.slice(0, 50).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const name = safe || "presentation";
    return path.join(getPresentationsDir(), `${name}_${ts}.pptx`);
}

// ── Per-Slide Dispatch ────────────────────────

// PptxGenJS slide type is complex; keep the local handle typed loosely.
type SlideApi = PptxSlide;

function renderSlide(s: SlideApi, slide: Slide, theme: Theme, isFirst: boolean): void {
    switch (slide.archetype) {
        case "title":
            return renderTitle(s, slide, theme);
        case "section-divider":
            return renderSectionDivider(s, slide, theme);
        case "content":
            return renderContent(s, slide, theme);
        case "two-column":
            return renderTwoColumn(s, slide, theme);
        case "bento-3":
            return renderBento(s, slide, theme, 3);
        case "bento-4":
            return renderBento(s, slide, theme, 4);
        case "stat-callout":
            return renderStatCallout(s, slide, theme);
        case "quote":
            return renderQuote(s, slide, theme);
        case "chart-focus":
            return renderChartFocus(s, slide, theme);
        case "comparison-table":
            return renderComparisonTable(s, slide, theme);
        case "process-steps":
            return renderProcessSteps(s, slide, theme);
        case "timeline":
            return renderTimeline(s, slide, theme);
        case "image-full-bleed":
            return renderImageFullBleed(s, slide, theme);
        default:
            return isFirst ? renderTitle(s, slide, theme) : renderContent(s, slide, theme);
    }
}

// ── Layout implementations ────────────────────

function addTitle(s: SlideApi, title: string, theme: Theme, opts?: { size?: number; y?: number }): void {
    s.addText(title, {
        x: PAD,
        y: opts?.y ?? PAD,
        w: SLIDE_W - PAD * 2,
        h: TITLE_H,
        fontSize: opts?.size ?? 32,
        bold: true,
        color: theme.colors.text,
        fontFace: theme.fonts.heading,
        valign: "middle",
        align: "left",
    });
}

function renderTitle(s: SlideApi, slide: Slide, theme: Theme): void {
    // Accent stripe on the left
    s.addShape("rect", {
        x: 0, y: 0, w: 0.25, h: SLIDE_H,
        fill: { color: theme.colors.primary },
        line: { color: theme.colors.primary, width: 0 },
    });

    s.addText(slide.title, {
        x: PAD + 0.25,
        y: SLIDE_H / 2 - 1.3,
        w: SLIDE_W - PAD * 2 - 0.25,
        h: 1.6,
        fontSize: 54,
        bold: true,
        color: theme.colors.text,
        fontFace: theme.fonts.heading,
        valign: "bottom",
        align: "left",
    });

    if (slide.subtitle) {
        s.addText(slide.subtitle, {
            x: PAD + 0.25,
            y: SLIDE_H / 2 + 0.35,
            w: SLIDE_W - PAD * 2 - 0.25,
            h: 0.8,
            fontSize: 24,
            color: theme.colors.textMuted,
            fontFace: theme.fonts.body,
            valign: "top",
            align: "left",
        });
    }
}

function renderTitleOnly(s: SlideApi, slide: Slide, theme: Theme): void {
    addTitle(s, slide.title, theme);
}

function renderSectionDivider(s: SlideApi, slide: Slide, theme: Theme): void {
    s.background = { color: theme.colors.primary };
    s.addText(slide.title, {
        x: PAD,
        y: SLIDE_H / 2 - 1,
        w: SLIDE_W - PAD * 2,
        h: 2,
        fontSize: 48,
        bold: true,
        color: theme.colors.bg,
        fontFace: theme.fonts.heading,
        valign: "middle",
        align: "center",
    });
    if (slide.subtitle) {
        s.addText(slide.subtitle, {
            x: PAD,
            y: SLIDE_H / 2 + 0.8,
            w: SLIDE_W - PAD * 2,
            h: 0.6,
            fontSize: 20,
            color: theme.colors.bg,
            fontFace: theme.fonts.body,
            align: "center",
            transparency: 20,
        });
    }
}

function renderContent(s: SlideApi, slide: Slide, theme: Theme): void {
    addTitle(s, slide.title, theme);

    const bullets = slide.bullets ?? [];
    if (bullets.length > 0) {
        const textRuns = bullets.slice(0, 4).map((b) => ({
            text: b,
            options: {
                bullet: { type: "bullet" as const },
                paraSpaceAfter: 8,
            },
        }));
        s.addText(textRuns, {
            x: PAD,
            y: BODY_Y,
            w: SLIDE_W - PAD * 2,
            h: BODY_H,
            fontSize: 22,
            color: theme.colors.text,
            fontFace: theme.fonts.body,
            valign: "top",
        });
    } else if (slide.body) {
        s.addText(slide.body, {
            x: PAD,
            y: BODY_Y,
            w: SLIDE_W - PAD * 2,
            h: BODY_H,
            fontSize: 24,
            color: theme.colors.text,
            fontFace: theme.fonts.body,
            valign: "top",
        });
    }

    if (slide.imagePath) {
        addImageSafe(s, slide.imagePath, {
            x: SLIDE_W - PAD - 4,
            y: BODY_Y,
            w: 4,
            h: BODY_H - 0.2,
            altText: slide.imagePrompt ?? slide.title,
        });
    }
}

function renderTwoColumn(s: SlideApi, slide: Slide, theme: Theme): void {
    addTitle(s, slide.title, theme);
    const cols = slide.columns ?? [];
    const colW = (SLIDE_W - PAD * 2 - 0.5) / 2;

    [0, 1].forEach((i) => {
        const col = cols[i];
        if (!col) return;
        const x = PAD + i * (colW + 0.5);

        s.addShape("rect", {
            x, y: BODY_Y, w: colW, h: BODY_H,
            fill: { color: theme.colors.surface },
            line: { color: theme.colors.surface, width: 0 },
        });
        s.addText(col.heading, {
            x: x + 0.3, y: BODY_Y + 0.25, w: colW - 0.6, h: 0.7,
            fontSize: 22, bold: true, color: theme.colors.primary,
            fontFace: theme.fonts.heading, valign: "middle",
        });
        s.addText(col.body, {
            x: x + 0.3, y: BODY_Y + 1.0, w: colW - 0.6, h: BODY_H - 1.2,
            fontSize: 18, color: theme.colors.text,
            fontFace: theme.fonts.body, valign: "top",
        });
    });
}

function renderBento(s: SlideApi, slide: Slide, theme: Theme, count: 3 | 4): void {
    addTitle(s, slide.title, theme);
    const cols = (slide.columns ?? []).slice(0, count);
    if (count === 3) {
        const cardW = (SLIDE_W - PAD * 2 - 0.4) / 3;
        cols.forEach((c, i) => {
            const x = PAD + i * (cardW + 0.2);
            drawBentoCard(s, theme, x, BODY_Y, cardW, BODY_H, c.heading, c.body);
        });
    } else {
        const cardW = (SLIDE_W - PAD * 2 - 0.3) / 2;
        const cardH = (BODY_H - 0.3) / 2;
        cols.forEach((c, i) => {
            const row = Math.floor(i / 2);
            const col = i % 2;
            const x = PAD + col * (cardW + 0.3);
            const y = BODY_Y + row * (cardH + 0.3);
            drawBentoCard(s, theme, x, y, cardW, cardH, c.heading, c.body);
        });
    }
}

function drawBentoCard(
    s: SlideApi, theme: Theme,
    x: number, y: number, w: number, h: number,
    heading: string, body: string,
): void {
    s.addShape("roundRect", {
        x, y, w, h,
        fill: { color: theme.colors.surface },
        line: { color: theme.colors.surface, width: 0 },
        rectRadius: 0.1,
    });
    s.addText(heading, {
        x: x + 0.25, y: y + 0.2, w: w - 0.5, h: 0.6,
        fontSize: 20, bold: true, color: theme.colors.primary,
        fontFace: theme.fonts.heading,
    });
    s.addText(body, {
        x: x + 0.25, y: y + 0.9, w: w - 0.5, h: h - 1.1,
        fontSize: 16, color: theme.colors.text,
        fontFace: theme.fonts.body, valign: "top",
    });
}

function renderStatCallout(s: SlideApi, slide: Slide, theme: Theme): void {
    addTitle(s, slide.title, theme);
    const num = slide.bigNumber ?? "";
    const label = slide.body ?? slide.subtitle ?? "";

    s.addText(num, {
        x: PAD, y: BODY_Y, w: SLIDE_W - PAD * 2, h: BODY_H * 0.6,
        fontSize: 144, bold: true, color: theme.colors.primary,
        fontFace: theme.fonts.heading, align: "center", valign: "middle",
    });
    if (label) {
        s.addText(label, {
            x: PAD, y: BODY_Y + BODY_H * 0.6, w: SLIDE_W - PAD * 2, h: BODY_H * 0.35,
            fontSize: 24, color: theme.colors.textMuted,
            fontFace: theme.fonts.body, align: "center", valign: "top",
        });
    }
}

function renderQuote(s: SlideApi, slide: Slide, theme: Theme): void {
    const q = slide.quote ?? { text: slide.body ?? slide.title, author: undefined };
    s.addText(`"${q.text}"`, {
        x: PAD + 1, y: 1.5, w: SLIDE_W - PAD * 2 - 2, h: 3.5,
        fontSize: 36, italic: true, color: theme.colors.text,
        fontFace: theme.fonts.heading, align: "left", valign: "middle",
    });
    if (q.author) {
        s.addText(`— ${q.author}`, {
            x: PAD + 1, y: 5.2, w: SLIDE_W - PAD * 2 - 2, h: 0.6,
            fontSize: 20, color: theme.colors.primary,
            fontFace: theme.fonts.body, align: "left",
        });
    }
}

function renderChartFocus(s: SlideApi, slide: Slide, theme: Theme): void {
    addTitle(s, slide.title, theme);
    const spec = slide.chart;
    if (!spec || !spec.series?.length) {
        if (slide.body) {
            s.addText(slide.body, {
                x: PAD, y: BODY_Y, w: SLIDE_W - PAD * 2, h: BODY_H,
                fontSize: 20, color: theme.colors.text,
                fontFace: theme.fonts.body, valign: "top",
            });
        }
        return;
    }
    addNativeChart(s, spec, theme, PAD, BODY_Y, SLIDE_W - PAD * 2, BODY_H);
}

function renderComparisonTable(s: SlideApi, slide: Slide, theme: Theme): void {
    addTitle(s, slide.title, theme);
    const t = slide.table;
    if (!t || !t.headers?.length) return;

    const rows: unknown[][] = [];
    const headerRow = t.headers.map((h) => ({
        text: h,
        options: {
            bold: true,
            color: theme.colors.bg,
            fill: { color: theme.colors.primary },
            align: "left" as const,
            fontFace: theme.fonts.heading,
            fontSize: 14,
        },
    }));
    rows.push(headerRow);

    (t.rows ?? []).forEach((r) => {
        rows.push(
            r.map((cell) => ({
                text: cell,
                options: {
                    color: theme.colors.text,
                    fontFace: theme.fonts.body,
                    fontSize: 13,
                    fill: { color: theme.colors.bg },
                    align: "left" as const,
                },
            })),
        );
    });

    s.addTable(rows, {
        x: PAD,
        y: BODY_Y,
        w: SLIDE_W - PAD * 2,
        colW: t.headers.map(() => (SLIDE_W - PAD * 2) / t.headers.length),
        border: { type: "solid", pt: 0.5, color: theme.colors.textMuted },
    });
}

function renderProcessSteps(s: SlideApi, slide: Slide, theme: Theme): void {
    addTitle(s, slide.title, theme);
    const steps = (slide.steps ?? []).slice(0, 5);
    if (!steps.length) return;
    const gap = 0.2;
    const stepW = (SLIDE_W - PAD * 2 - gap * (steps.length - 1)) / steps.length;

    steps.forEach((step, i) => {
        const x = PAD + i * (stepW + gap);
        s.addShape("roundRect", {
            x, y: BODY_Y, w: stepW, h: BODY_H,
            fill: { color: theme.colors.surface },
            line: { color: theme.colors.primary, width: 1 },
            rectRadius: 0.1,
        });
        s.addText(`${i + 1}`, {
            x: x + 0.2, y: BODY_Y + 0.2, w: 0.6, h: 0.6,
            fontSize: 28, bold: true, color: theme.colors.primary,
            fontFace: theme.fonts.heading,
        });
        s.addText(step.label, {
            x: x + 0.25, y: BODY_Y + 0.9, w: stepW - 0.5, h: 0.8,
            fontSize: 18, bold: true, color: theme.colors.text,
            fontFace: theme.fonts.heading, valign: "top",
        });
        if (step.detail) {
            s.addText(step.detail, {
                x: x + 0.25, y: BODY_Y + 1.75, w: stepW - 0.5, h: BODY_H - 1.9,
                fontSize: 14, color: theme.colors.textMuted,
                fontFace: theme.fonts.body, valign: "top",
            });
        }
    });
}

function renderTimeline(s: SlideApi, slide: Slide, theme: Theme): void {
    addTitle(s, slide.title, theme);
    const steps = (slide.steps ?? []).slice(0, 6);
    if (!steps.length) return;

    const lineY = BODY_Y + BODY_H / 2;
    s.addShape("line", {
        x: PAD, y: lineY, w: SLIDE_W - PAD * 2, h: 0,
        line: { color: theme.colors.primary, width: 3 },
    });

    const step = (SLIDE_W - PAD * 2) / Math.max(steps.length - 1, 1);
    steps.forEach((st, i) => {
        const cx = PAD + i * step;
        s.addShape("ellipse", {
            x: cx - 0.15, y: lineY - 0.15, w: 0.3, h: 0.3,
            fill: { color: theme.colors.accent },
            line: { color: theme.colors.primary, width: 1 },
        });
        const textAbove = i % 2 === 0;
        const ty = textAbove ? BODY_Y + 0.2 : lineY + 0.4;
        s.addText(st.label, {
            x: cx - 1, y: ty, w: 2, h: 0.6,
            fontSize: 14, bold: true, color: theme.colors.text,
            fontFace: theme.fonts.heading, align: "center",
        });
        if (st.detail) {
            s.addText(st.detail, {
                x: cx - 1, y: ty + 0.65, w: 2, h: 0.8,
                fontSize: 11, color: theme.colors.textMuted,
                fontFace: theme.fonts.body, align: "center", valign: "top",
            });
        }
    });
}

function renderImageFullBleed(s: SlideApi, slide: Slide, theme: Theme): void {
    if (slide.imagePath) {
        addImageSafe(s, slide.imagePath, {
            x: 0, y: 0, w: SLIDE_W, h: SLIDE_H,
            altText: slide.imagePrompt ?? slide.title,
        });
        // Scrim for text legibility
        s.addShape("rect", {
            x: 0, y: SLIDE_H - 2.5, w: SLIDE_W, h: 2.5,
            fill: { color: "000000", transparency: 40 },
            line: { color: "000000", width: 0 },
        });
    }
    s.addText(slide.title, {
        x: PAD, y: SLIDE_H - 2, w: SLIDE_W - PAD * 2, h: 1.2,
        fontSize: 40, bold: true, color: "FFFFFF",
        fontFace: theme.fonts.heading, valign: "bottom",
    });
    if (slide.subtitle) {
        s.addText(slide.subtitle, {
            x: PAD, y: SLIDE_H - 0.9, w: SLIDE_W - PAD * 2, h: 0.6,
            fontSize: 20, color: "FFFFFF",
            fontFace: theme.fonts.body, valign: "top",
        });
    }
}

// ── Helpers ───────────────────────────────────

function addImageSafe(
    s: SlideApi,
    imagePath: string,
    opts: { x: number; y: number; w: number; h: number; altText: string },
): void {
    try {
        if (!fs.existsSync(imagePath)) return;
        s.addImage({
            path: imagePath,
            x: opts.x, y: opts.y, w: opts.w, h: opts.h,
            altText: opts.altText,
            sizing: { type: "cover", w: opts.w, h: opts.h },
        });
    } catch {
        /* render without image */
    }
}

function addNativeChart(
    s: SlideApi,
    spec: ChartSpec,
    theme: Theme,
    x: number, y: number, w: number, h: number,
): void {
    const chartData = spec.series.map((ser) => ({
        name: ser.name,
        labels: spec.categories,
        values: ser.values,
    }));

    const typeMap: Record<ChartSpec["kind"], string> = {
        bar: "bar",
        line: "line",
        pie: "pie",
        doughnut: "doughnut",
        area: "area",
        scatter: "scatter",
    };

    try {
        s.addChart(typeMap[spec.kind] ?? "bar", chartData, {
            x, y, w, h,
            showTitle: !!spec.title,
            title: spec.title ?? "",
            chartColors: theme.chartPalette,
            showLegend: true,
            legendPos: "b",
            catAxisLabelColor: theme.colors.textMuted,
            valAxisLabelColor: theme.colors.textMuted,
            catAxisLabelFontFace: theme.fonts.body,
            valAxisLabelFontFace: theme.fonts.body,
            titleColor: theme.colors.text,
            titleFontFace: theme.fonts.heading,
            titleFontSize: 18,
        });
    } catch {
        // Fallback: render the data as a simple text listing
        const lines = spec.series
            .flatMap((ser) => ser.values.map((v, i) => `${spec.categories[i] ?? ""}: ${v}`))
            .slice(0, 10)
            .join("\n");
        s.addText(lines, {
            x, y, w, h,
            fontSize: 16, color: theme.colors.text,
            fontFace: theme.fonts.body, valign: "top",
        });
    }
}
