// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Markdown → PDF renderer ─────────────────────
// Loads a markdown template, interpolates placeholders, converts to HTML via
// markdown-it, then hands off to the HTML renderer. Used by cover letters /
// simple reports where markdown is the most ergonomic authoring format.

import MarkdownIt from "markdown-it";
import { renderTemplate } from "../placeholders.js";
import { readTemplateSource, readTemplateStyles, type TemplateMeta } from "../templates.js";
import { type RenderHtmlPdfOptions, renderHtmlTemplateToPdf } from "./html.js";

const md = new MarkdownIt({
    html: true,
    breaks: false,
    linkify: true,
    typographer: true,
});

const DEFAULT_MD_STYLES = `
body {
    font-family: Georgia, "Times New Roman", serif;
    color: #1a1a1a;
    font-size: 11.5pt;
    line-height: 1.55;
    max-width: 7.5in;
    margin: 0 auto;
    padding: 0.6in 0.6in 0.6in 0.6in;
}
h1 { font-size: 20pt; margin: 0.3em 0 0.5em; font-weight: 700; }
h2 { font-size: 14pt; margin: 1.2em 0 0.5em; font-weight: 700; }
h3 { font-size: 12pt; margin: 1em 0 0.4em; font-weight: 700; }
p { margin: 0.6em 0; }
a { color: #0b5fff; text-decoration: none; }
ul, ol { margin: 0.5em 0 0.5em 1.3em; }
li { margin: 0.2em 0; }
hr { border: none; border-top: 1px solid #ccc; margin: 1em 0; }
code { font-family: "Menlo", "Consolas", monospace; font-size: 90%; background: #f3f3f3; padding: 0.1em 0.3em; border-radius: 3px; }
pre { background: #f3f3f3; padding: 0.7em; border-radius: 5px; overflow-x: hidden; white-space: pre-wrap; font-size: 90%; }
blockquote { border-left: 3px solid #888; padding-left: 0.8em; color: #555; margin: 0.8em 0; }
table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }
th, td { border: 1px solid #ccc; padding: 0.4em 0.6em; text-align: left; }
thead { background: #f0f0f0; }
`;

export async function renderMarkdownTemplateToPdf(
    tpl: TemplateMeta,
    data: Record<string, unknown>,
    opts: RenderHtmlPdfOptions,
): Promise<string> {
    const rawMd = readTemplateSource(tpl);
    // Interpolate with raw mode — don't HTML-escape inside markdown bodies.
    const interpolated = renderTemplate(rawMd, data, { raw: true });
    const bodyHtml = md.render(interpolated);

    const styles = readTemplateStyles(tpl) ?? DEFAULT_MD_STYLES;
    const full = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${styles}</style></head><body>${bodyHtml}</body></html>`;

    // Delegate to the HTML renderer with inline HTML override.
    return renderHtmlTemplateToPdf(tpl, data, {
        ...opts,
        inlineHtml: full,
    });
}

/** Render raw markdown text (not a template) directly to PDF. */
export async function renderMarkdownStringToPdf(
    mdText: string,
    outputPath: string,
    opts: Partial<RenderHtmlPdfOptions> = {},
): Promise<string> {
    const bodyHtml = md.render(mdText);
    const full = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${DEFAULT_MD_STYLES}</style></head><body>${bodyHtml}</body></html>`;
    const stub: TemplateMeta = {
        id: "__inline-markdown__",
        name: "inline",
        description: "",
        documentTypes: ["generic"],
        supports: ["pdf"],
        renderKind: "markdown",
        source: "inline",
        dir: process.cwd(),
        origin: "bundled",
    };
    return renderHtmlTemplateToPdf(
        stub,
        {},
        {
            ...opts,
            outputPath,
            inlineHtml: full,
        },
    );
}
