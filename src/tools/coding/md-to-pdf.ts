// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── render_md_to_pdf ──────────────────────────
// Converts a Markdown file to a PDF on disk, using the project's
// existing Playwright + markdown-it dependencies (no new installs).
// Primary use: agent wants to send a design doc / walkthrough over
// Telegram or WhatsApp where PDF previews are native — MD is not.
//
// Flow:
//   1. Read the MD file off disk
//   2. markdown-it → HTML
//   3. Wrap in a small CSS shell (readable font stack, fenced-code
//      block styling, sensible margins) so the PDF looks like a doc
//   4. Playwright Chromium → page.setContent → page.pdf → write bytes

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPathBlockedReason, isPathAllowed } from "../../security/allowlist.js";
import { auditLog } from "../../security/audit-log.js";
import { logToolAction } from "../../utils/debug-log.js";
import type { ToolDefinition } from "../get-current-time.js";

const PDF_CSS = `
body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.55; color: #1a1a1a; max-width: 720px; margin: 40px auto; padding: 0 20px; }
h1 { font-size: 28px; border-bottom: 2px solid #222; padding-bottom: 8px; margin-top: 0; }
h2 { font-size: 20px; margin-top: 28px; color: #222; }
h3 { font-size: 16px; margin-top: 20px; color: #333; }
code { font-family: "SF Mono", Menlo, Monaco, "Courier New", monospace; background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 14px; overflow: auto; font-size: 13px; }
pre code { background: transparent; padding: 0; }
blockquote { border-left: 4px solid #dfe2e5; padding: 2px 14px; color: #555; margin: 14px 0; }
table { border-collapse: collapse; margin: 14px 0; }
th, td { border: 1px solid #dfe2e5; padding: 8px 12px; text-align: left; }
th { background: #f6f8fa; }
ul, ol { padding-left: 28px; }
li { margin: 4px 0; }
hr { border: none; border-top: 1px solid #e1e4e8; margin: 24px 0; }
a { color: #0366d6; text-decoration: none; }
a:hover { text-decoration: underline; }
`;

export const mdToPdfTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "render_md_to_pdf",
            description:
                "Render a Markdown file to a PDF at the given path (or alongside the MD). Used when " +
                "sending design docs / walkthroughs / reports on channels where PDF previews are native " +
                "(Telegram, WhatsApp, email). Returns { pdf_path, bytes }. Headless Chromium + " +
                "markdown-it; no external tool needed.",
            parameters: {
                type: "object",
                properties: {
                    md_path: { type: "string", description: "Absolute or relative path to the source .md file." },
                    pdf_path: {
                        type: "string",
                        description:
                            "Optional destination path for the PDF. Defaults to the same directory + basename with .pdf extension.",
                    },
                },
                required: ["md_path"],
            },
        },
    },

    async handler(input) {
        const mdPathRaw = typeof input.md_path === "string" ? input.md_path.trim() : "";
        if (!mdPathRaw) return JSON.stringify({ success: false, error: "md_path required" });
        const mdPath = path.resolve(mdPathRaw);
        if (!existsSync(mdPath)) return JSON.stringify({ success: false, error: `file not found: ${mdPath}` });
        if (!isPathAllowed(mdPath)) {
            return JSON.stringify({ success: false, error: getPathBlockedReason(mdPath) ?? "path not allowed" });
        }

        const pdfPath =
            typeof input.pdf_path === "string" && input.pdf_path
                ? path.resolve(input.pdf_path)
                : mdPath.replace(/\.md$/i, "") + ".pdf";
        if (!isPathAllowed(pdfPath)) {
            return JSON.stringify({ success: false, error: getPathBlockedReason(pdfPath) ?? "pdf path not allowed" });
        }

        auditLog("render_md_to_pdf", { md: mdPath, pdf: pdfPath });
        logToolAction({ tool: "render_md_to_pdf", filePath: mdPath, action: `render to ${path.basename(pdfPath)}` });

        let md: string;
        try {
            md = readFileSync(mdPath, "utf-8");
        } catch (err) {
            return JSON.stringify({ success: false, error: `read failed: ${(err as Error).message}` });
        }

        // markdown-it → HTML
        let bodyHtml: string;
        try {
            const MarkdownIt = (await import("markdown-it")).default;
            const mdIt = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: false });
            bodyHtml = mdIt.render(md);
        } catch (err) {
            return JSON.stringify({ success: false, error: `markdown render failed: ${(err as Error).message}` });
        }

        const title = (md.match(/^#\s+(.+)$/m)?.[1] || path.basename(mdPath, ".md"))
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>${PDF_CSS}</style></head><body>${bodyHtml}</body></html>`;

        // Playwright → PDF
        try {
            const pw = await import("playwright-core");
            const browser = await pw.chromium.launch({ headless: true });
            try {
                const ctx = await browser.newContext();
                const page = await ctx.newPage();
                await page.setContent(html, { waitUntil: "networkidle" });
                const pdfBuffer = await page.pdf({
                    format: "A4",
                    margin: { top: "20mm", right: "16mm", bottom: "20mm", left: "16mm" },
                    printBackground: true,
                });
                writeFileSync(pdfPath, pdfBuffer);
                await ctx.close();
            } finally {
                await browser.close();
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: `pdf render failed: ${(err as Error).message}` });
        }

        let bytes = 0;
        try {
            bytes = readFileSync(pdfPath).length;
        } catch {
            /* size is informational; still report success */
        }
        return JSON.stringify({ success: true, pdf_path: pdfPath, bytes });
    },
};
