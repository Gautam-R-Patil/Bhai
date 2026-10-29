// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Tiny template engine ────────────────────────
// Just enough to render bundled templates without pulling in Handlebars.
//
// Supported:
//   {{path.to.value}}                    — interpolation (HTML-escaped by default)
//   {{{path.to.value}}}                  — raw (unescaped)
//   {{#if path.to.value}}…{{/if}}
//   {{#each items}}…{{@index}} {{this.name}}…{{/each}}
//   {{else}} inside if                   — simple single-branch else
//
// Enough to cover resume/cover-letter templates; complex logic belongs in code,
// not in templates.

type Scope = Record<string, unknown>;

const HTML_ENTITY_MAP: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => HTML_ENTITY_MAP[c] ?? c);
}

function lookupPath(scope: Scope, dotted: string): unknown {
    if (dotted === "this" || dotted === ".") return scope.this ?? scope;
    const parts = dotted.split(".");
    let cur: unknown = scope;
    for (const part of parts) {
        if (part === "this" || part === "") continue;
        if (cur == null) return undefined;
        if (typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
}

function stringify(v: unknown): string {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return v.map(stringify).join(", ");
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

function isTruthy(v: unknown): boolean {
    if (v == null) return false;
    if (v === false || v === 0 || v === "") return false;
    if (Array.isArray(v) && v.length === 0) return false;
    if (typeof v === "object" && Object.keys(v as object).length === 0) return false;
    return true;
}

export interface RenderOptions {
    /** If true, values are NOT HTML-escaped — useful for plain-text/markdown templates. */
    raw?: boolean;
}

/**
 * Render a template string against a data scope.
 * Balanced block parsing — handles nested {{#if}} / {{#each}}.
 */
export function renderTemplate(tmpl: string, data: Scope, opts: RenderOptions = {}): string {
    const esc = opts.raw ? (s: string) => s : escapeHtml;

    function render(src: string, scope: Scope): string {
        let out = "";
        let i = 0;
        while (i < src.length) {
            const open = src.indexOf("{{", i);
            if (open === -1) {
                out += src.slice(i);
                break;
            }
            out += src.slice(i, open);

            // triple-brace raw
            if (src.startsWith("{{{", open)) {
                const close = src.indexOf("}}}", open + 3);
                if (close === -1) {
                    out += src.slice(open);
                    break;
                }
                const key = src.slice(open + 3, close).trim();
                out += stringify(lookupPath(scope, key));
                i = close + 3;
                continue;
            }

            const close = src.indexOf("}}", open + 2);
            if (close === -1) {
                out += src.slice(open);
                break;
            }
            const raw = src.slice(open + 2, close).trim();

            if (raw.startsWith("#if ")) {
                const cond = raw.slice(4).trim();
                const { body, elseBody, end } = consumeBlock(src, close + 2, "if");
                if (isTruthy(lookupPath(scope, cond))) {
                    out += render(body, scope);
                } else if (elseBody !== null) {
                    out += render(elseBody, scope);
                }
                i = end;
                continue;
            }
            if (raw.startsWith("#unless ")) {
                const cond = raw.slice(8).trim();
                const { body, elseBody, end } = consumeBlock(src, close + 2, "unless");
                if (!isTruthy(lookupPath(scope, cond))) {
                    out += render(body, scope);
                } else if (elseBody !== null) {
                    out += render(elseBody, scope);
                }
                i = end;
                continue;
            }
            if (raw.startsWith("#each ")) {
                const listKey = raw.slice(6).trim();
                const { body, end } = consumeBlock(src, close + 2, "each");
                const list = lookupPath(scope, listKey);
                if (Array.isArray(list)) {
                    for (let idx = 0; idx < list.length; idx++) {
                        const item = list[idx];
                        const inner: Scope = {
                            ...scope,
                            this: item,
                            "@index": idx,
                            "@first": idx === 0,
                            "@last": idx === list.length - 1,
                        };
                        // if item is an object, merge its keys into top-level too
                        // so templates can write {{name}} instead of {{this.name}}.
                        const merged =
                            item && typeof item === "object" && !Array.isArray(item)
                                ? { ...inner, ...(item as Record<string, unknown>) }
                                : inner;
                        out += render(body, merged);
                    }
                }
                i = end;
                continue;
            }
            if (raw.startsWith("/") || raw === "else") {
                // stray close/else — pass through literally (defensive)
                out += src.slice(open, close + 2);
                i = close + 2;
                continue;
            }

            // simple interpolation
            out += esc(stringify(lookupPath(scope, raw)));
            i = close + 2;
        }
        return out;
    }

    return render(tmpl, data);
}

/**
 * Given a source string and the index right after `{{#xxx ...}}`, return the
 * body content until the matching `{{/xxx}}`, handling nested blocks and
 * optional `{{else}}`.
 */
function consumeBlock(
    src: string,
    startIdx: number,
    tag: "if" | "each" | "unless",
): { body: string; elseBody: string | null; end: number } {
    let depth = 1;
    let i = startIdx;
    const bodyStart = startIdx;
    let elseStart: number | null = null;
    let bodyEnd = -1;
    let blockEnd = -1;

    while (i < src.length) {
        const open = src.indexOf("{{", i);
        if (open === -1) break;
        const close = src.indexOf("}}", open + 2);
        if (close === -1) break;
        const raw = src.slice(open + 2, close).trim();
        if (raw.startsWith("#if ") || raw.startsWith("#each ") || raw.startsWith("#unless ")) {
            depth++;
        } else if (raw === `/${tag}` || raw === `/if` || raw === `/each` || raw === `/unless`) {
            // close: only decrement at depth-specific level; we accept any close tag.
            depth--;
            if (depth === 0) {
                // Only set bodyEnd here if `{{else}}` didn't already set it,
                // otherwise the else branch location would be lost.
                if (bodyEnd === -1) bodyEnd = open;
                blockEnd = close + 2;
                break;
            }
        } else if (raw === "else" && depth === 1 && (tag === "if" || tag === "unless")) {
            elseStart = close + 2;
            bodyEnd = open;
        }
        i = close + 2;
    }

    if (blockEnd === -1) {
        return { body: src.slice(bodyStart), elseBody: null, end: src.length };
    }
    if (elseStart !== null && bodyEnd !== -1 && bodyEnd >= bodyStart) {
        // blockEnd is the position right after `}}` of the closing tag. The
        // else body extends from elseStart up to the `{{` of that same close.
        const closingTagIdx = src.lastIndexOf("{{", blockEnd);
        return {
            body: src.slice(bodyStart, bodyEnd),
            elseBody: src.slice(elseStart, closingTagIdx >= 0 ? closingTagIdx : blockEnd - 2),
            end: blockEnd,
        };
    }
    return {
        body: src.slice(bodyStart, bodyEnd === -1 ? blockEnd : bodyEnd),
        elseBody: null,
        end: blockEnd,
    };
}
