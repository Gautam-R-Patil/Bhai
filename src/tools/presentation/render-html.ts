// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import path from "node:path";
import { getPresentationsDir } from "../../config/paths.js";
import { getTheme } from "./themes.js";
import type { PresentationOutline, Slide, Theme } from "./types.js";

// Self-contained Reveal.js from CDN (one-file HTML).
// For strict offline output we'd bundle reveal locally — deferred.

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function embedImage(imagePath: string): string | null {
    try {
        if (!fs.existsSync(imagePath)) return null;
        const buf = fs.readFileSync(imagePath);
        const ext = path.extname(imagePath).slice(1).toLowerCase() || "png";
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
        return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
        return null;
    }
}

function slideHtml(slide: Slide, theme: Theme): string {
    const title = escapeHtml(slide.title);
    const imgDataUri = slide.imagePath ? embedImage(slide.imagePath) : null;

    switch (slide.archetype) {
        case "title":
            return `
<section class="atlas-title">
  <h1>${title}</h1>
  ${slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : ""}
</section>`;

        case "section-divider":
            return `
<section class="atlas-divider" style="background:#${theme.colors.primary}; color:#${theme.colors.bg}">
  <h1>${title}</h1>
  ${slide.subtitle ? `<p>${escapeHtml(slide.subtitle)}</p>` : ""}
</section>`;

        case "content": {
            const bullets = (slide.bullets ?? [])
                .slice(0, 4)
                .map((b) => `<li>${escapeHtml(b)}</li>`)
                .join("");
            const body = slide.body ? `<p>${escapeHtml(slide.body)}</p>` : "";
            const img = imgDataUri
                ? `<img class="side" src="${imgDataUri}" alt="${escapeHtml(slide.imagePrompt ?? title)}"/>`
                : "";
            return `
<section>
  <h2>${title}</h2>
  <div class="two-col">
    <div class="col">${bullets ? `<ul>${bullets}</ul>` : body}</div>
    ${img ? `<div class="col">${img}</div>` : ""}
  </div>
</section>`;
        }

        case "two-column": {
            const cols = (slide.columns ?? [])
                .slice(0, 2)
                .map((c) => `<div class="col"><h3>${escapeHtml(c.heading)}</h3><p>${escapeHtml(c.body)}</p></div>`)
                .join("");
            return `
<section>
  <h2>${title}</h2>
  <div class="two-col">${cols}</div>
</section>`;
        }

        case "bento-3":
        case "bento-4": {
            const n = slide.archetype === "bento-3" ? 3 : 4;
            const cards = (slide.columns ?? [])
                .slice(0, n)
                .map(
                    (c) =>
                        `<div class="bento-card"><h3>${escapeHtml(c.heading)}</h3><p>${escapeHtml(c.body)}</p></div>`,
                )
                .join("");
            const gridCls = n === 3 ? "bento-3" : "bento-4";
            return `
<section>
  <h2>${title}</h2>
  <div class="${gridCls}">${cards}</div>
</section>`;
        }

        case "stat-callout":
            return `
<section class="stat">
  <h2>${title}</h2>
  <div class="big-number">${escapeHtml(slide.bigNumber ?? "")}</div>
  ${slide.body ? `<p class="stat-label">${escapeHtml(slide.body)}</p>` : ""}
</section>`;

        case "quote": {
            const q = slide.quote ?? { text: slide.body ?? slide.title };
            return `
<section class="quote">
  <blockquote>“${escapeHtml(q.text)}”</blockquote>
  ${q.author ? `<cite>— ${escapeHtml(q.author)}</cite>` : ""}
</section>`;
        }

        case "chart-focus": {
            // HTML export: show the chart data as a simple table fallback
            // (real chart rendering would need Chart.js bundled; deferred)
            if (!slide.chart) {
                return `<section><h2>${title}</h2></section>`;
            }
            const c = slide.chart;
            const header = `<tr><th></th>${c.categories.map((cat) => `<th>${escapeHtml(cat)}</th>`).join("")}</tr>`;
            const rows = c.series
                .map(
                    (s) =>
                        `<tr><td><strong>${escapeHtml(s.name)}</strong></td>${s.values.map((v) => `<td>${v}</td>`).join("")}</tr>`,
                )
                .join("");
            return `
<section>
  <h2>${title}</h2>
  <table class="chart-table"><thead>${header}</thead><tbody>${rows}</tbody></table>
</section>`;
        }

        case "comparison-table": {
            if (!slide.table) return `<section><h2>${title}</h2></section>`;
            const header = `<tr>${slide.table.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
            const rows = slide.table.rows
                .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
                .join("");
            return `
<section>
  <h2>${title}</h2>
  <table class="data-table"><thead>${header}</thead><tbody>${rows}</tbody></table>
</section>`;
        }

        case "process-steps":
        case "timeline": {
            const steps = (slide.steps ?? [])
                .slice(0, 5)
                .map(
                    (s, i) =>
                        `<div class="step"><div class="step-num">${i + 1}</div><h3>${escapeHtml(s.label)}</h3>${s.detail ? `<p>${escapeHtml(s.detail)}</p>` : ""}</div>`,
                )
                .join("");
            return `
<section>
  <h2>${title}</h2>
  <div class="steps">${steps}</div>
</section>`;
        }

        case "image-full-bleed": {
            const bg = imgDataUri ? `background-image:url('${imgDataUri}')` : `background:#${theme.colors.primary}`;
            return `
<section class="hero" style="${bg}">
  <div class="hero-overlay">
    <h1>${title}</h1>
    ${slide.subtitle ? `<p>${escapeHtml(slide.subtitle)}</p>` : ""}
  </div>
</section>`;
        }

        default:
            return `<section><h2>${title}</h2></section>`;
    }
}

const CSS = (theme: Theme) => `
:root {
  --bg: #${theme.colors.bg};
  --surface: #${theme.colors.surface};
  --text: #${theme.colors.text};
  --muted: #${theme.colors.textMuted};
  --primary: #${theme.colors.primary};
  --accent: #${theme.colors.accent};
  --heading-font: '${theme.fonts.heading}', system-ui, sans-serif;
  --body-font: '${theme.fonts.body}', system-ui, sans-serif;
}
.reveal { background: var(--bg); color: var(--text); font-family: var(--body-font); }
.reveal h1, .reveal h2, .reveal h3 { font-family: var(--heading-font); color: var(--text); }
.reveal h1 { font-size: 2.6em; }
.reveal h2 { font-size: 1.8em; margin-bottom: 0.6em; }
.reveal section { text-align: left; padding: 0.5em 1.5em; }
.atlas-title h1 { font-size: 3.2em; }
.atlas-title .subtitle { color: var(--muted); font-size: 1.2em; }
.atlas-divider { text-align: center !important; }
.atlas-divider h1 { font-size: 3em; color: inherit; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5em; align-items: start; }
.col h3 { color: var(--primary); }
.side { max-width: 100%; height: auto; border-radius: 8px; }
.bento-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1em; }
.bento-4 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1em; }
.bento-card { background: var(--surface); padding: 1em; border-radius: 12px; }
.bento-card h3 { color: var(--primary); margin: 0 0 0.3em 0; }
.stat { text-align: center !important; }
.stat .big-number { font-size: 9em; font-weight: bold; color: var(--primary); font-family: var(--heading-font); line-height: 1; margin: 0.3em 0; }
.stat .stat-label { color: var(--muted); font-size: 1.3em; }
.quote blockquote { font-size: 1.8em; font-style: italic; border-left: 4px solid var(--primary); padding-left: 1em; }
.quote cite { display: block; color: var(--primary); margin-top: 1em; font-size: 1.1em; }
.chart-table, .data-table { width: 100%; border-collapse: collapse; font-size: 0.8em; }
.chart-table th, .chart-table td, .data-table th, .data-table td {
  padding: 0.5em 0.8em; border: 1px solid var(--muted);
}
.chart-table thead tr, .data-table thead tr { background: var(--primary); color: var(--bg); }
.steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1em; }
.step { background: var(--surface); padding: 1em; border-radius: 12px; border-top: 3px solid var(--primary); }
.step-num { background: var(--primary); color: var(--bg); width: 2em; height: 2em; line-height: 2em; text-align: center; border-radius: 50%; font-weight: bold; margin-bottom: 0.5em; }
.hero { background-size: cover; background-position: center; color: white; min-height: 100vh; display: flex; align-items: flex-end; }
.hero-overlay { background: linear-gradient(transparent, rgba(0,0,0,0.7)); padding: 2em; width: 100%; }
.hero h1 { color: white; }
ul { padding-left: 1.2em; }
li { margin-bottom: 0.3em; }
`;

export async function renderHtml(
    outline: PresentationOutline,
    opts?: { outputPath?: string },
): Promise<{ filePath: string; sizeKb: number }> {
    const theme = getTheme(outline.themeId);
    const slides = outline.slides.map((s) => slideHtml(s, theme)).join("\n");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(outline.title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/theme/white.css">
<style>${CSS(theme)}</style>
</head>
<body>
<div class="reveal">
  <div class="slides">
    ${slides}
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js"></script>
<script>Reveal.initialize({ hash: true, controls: true, progress: true });</script>
</body>
</html>`;

    const outputPath = opts?.outputPath ?? makeHtmlOutputPath(outline);
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, html, "utf-8");

    const sizeKb = Math.round(fs.statSync(outputPath).size / 1024);
    return { filePath: outputPath, sizeKb };
}

function makeHtmlOutputPath(outline: PresentationOutline): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safe = outline.title
        .slice(0, 50)
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    const name = safe || "presentation";
    return path.join(getPresentationsDir(), `${name}_${ts}.html`);
}
