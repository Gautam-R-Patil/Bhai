// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── HTML → PDF renderer ─────────────────────────
// Takes a template HTML + CSS pair, substitutes placeholders, loads into a
// headless Chromium page, and calls page.pdf(). Serializes concurrent renders
// via a Promise queue because Playwright page.pdf() can hang under contention.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright";
import { renderTemplate } from "../placeholders.js";
import { readTemplateSource, readTemplateStyles, type TemplateMeta } from "../templates.js";

export interface RenderHtmlPdfOptions {
    outputPath: string;
    format?: "Letter" | "A4";
    margin?: { top?: string; bottom?: string; left?: string; right?: string };
    landscape?: boolean;
    /** Override the template HTML with an inline string (used by the markdown renderer). */
    inlineHtml?: string;
}

// ── Queue ───────────────────────────────────────
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
}

// ── Shared browser ──────────────────────────────
let sharedBrowser: Browser | null = null;
let browserStartup: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
    if (sharedBrowser?.isConnected()) return sharedBrowser;
    if (browserStartup) return browserStartup;
    const { chromium } = await import("playwright");
    browserStartup = chromium
        .launch({ headless: true, args: ["--disable-web-security", "--no-sandbox"] })
        .then((b) => {
            sharedBrowser = b;
            b.on("disconnected", () => {
                sharedBrowser = null;
            });
            return b;
        })
        .finally(() => {
            browserStartup = null;
        });
    return browserStartup;
}

// ── HTML shell ──────────────────────────────────
function wrapHtml(body: string, styles: string): string {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
${PRINT_RESET}
${styles}
</style></head>
<body>${body}</body></html>`;
}

const PRINT_RESET = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@page { margin: 0; }
`;

export async function renderHtmlTemplateToPdf(
    tpl: TemplateMeta,
    data: Record<string, unknown>,
    opts: RenderHtmlPdfOptions,
): Promise<string> {
    const rawHtml = opts.inlineHtml ?? readTemplateSource(tpl);
    const styles = readTemplateStyles(tpl) ?? "";

    const renderedBody = renderTemplate(rawHtml, data);
    const fullHtml = rawHtml.trim().startsWith("<!DOCTYPE") ? renderedBody : wrapHtml(renderedBody, styles);

    return serialize(async () => {
        const browser = await getBrowser();
        const ctx = await browser.newContext();
        const page = await ctx.newPage();

        // Write to a temp file so relative assets (images, fonts) can resolve
        // against the template directory.
        const tmpFile = path.join(os.tmpdir(), `atlas-doc-${crypto.randomBytes(4).toString("hex")}.html`);
        fs.writeFileSync(tmpFile, fullHtml, "utf-8");

        try {
            const baseDir = tpl.dir ?? process.cwd();
            const fileUrl = `file://${tmpFile}`;
            await page.goto(fileUrl, { waitUntil: "networkidle", timeout: 30_000 });
            // If the template references a sibling asset like an image logo,
            // resolve it by setting base href via script.
            await page.evaluate(
                /* javascript-obfuscator:disable */ (base: string) => {
                    const b = document.createElement("base");
                    b.setAttribute("href", `file://${base}/`);
                    document.head.prepend(b);
                },
                /* javascript-obfuscator:enable */ baseDir,
            );
            await page.waitForTimeout(150);

            const format = opts.format ?? tpl.page?.format ?? "Letter";
            const margin = opts.margin ??
                tpl.page?.margin ?? {
                    top: "0.5in",
                    bottom: "0.5in",
                    left: "0.5in",
                    right: "0.5in",
                };
            const landscape = opts.landscape ?? tpl.page?.landscape ?? false;

            fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
            await page.pdf({
                path: opts.outputPath,
                format,
                printBackground: true,
                margin,
                landscape,
                preferCSSPageSize: false,
            });
            return opts.outputPath;
        } finally {
            await page.close().catch(() => undefined);
            await ctx.close().catch(() => undefined);
            try {
                fs.unlinkSync(tmpFile);
            } catch {
                // non-fatal
            }
        }
    });
}

/** For tests / shutdown hooks. */
export async function closeHtmlRenderer(): Promise<void> {
    if (sharedBrowser) {
        await sharedBrowser.close().catch(() => undefined);
        sharedBrowser = null;
    }
}
