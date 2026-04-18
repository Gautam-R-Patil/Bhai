// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Flatten a GeneralDocument's blocks array to a single markdown string so
// templates can render them with a plain {{{body}}} placeholder instead of
// trying to branch inside the template language.

import type { DocumentBlock, GeneralDocument } from "./schema.js";

export function blocksToMarkdown(blocks: DocumentBlock[]): string {
    const out: string[] = [];
    for (const b of blocks) {
        switch (b.type) {
            case "heading":
                out.push(`${"#".repeat(b.level ?? 1)} ${b.text}`);
                break;
            case "paragraph":
                out.push(b.text);
                break;
            case "list":
                if (b.ordered) {
                    out.push(b.items.map((item, i) => `${i + 1}. ${item}`).join("\n"));
                } else {
                    out.push(b.items.map((item) => `- ${item}`).join("\n"));
                }
                break;
            case "table": {
                const headers = b.headers ?? [];
                const lines: string[] = [];
                if (headers.length) {
                    lines.push(`| ${headers.join(" | ")} |`);
                    lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
                }
                for (const row of b.rows) {
                    lines.push(`| ${row.join(" | ")} |`);
                }
                out.push(lines.join("\n"));
                break;
            }
            case "divider":
                out.push("---");
                break;
            case "spacer":
                out.push("&nbsp;");
                break;
            case "markdown":
                out.push(b.text);
                break;
            case "image":
                out.push(`![${b.alt ?? ""}](${b.src})`);
                break;
        }
    }
    return out.join("\n\n");
}

/** Enrich data with a pre-rendered `body` markdown string for templates. */
export function enrichWithBody(doc: GeneralDocument): GeneralDocument & { body: string } {
    return { ...doc, body: blocksToMarkdown(doc.blocks) };
}
