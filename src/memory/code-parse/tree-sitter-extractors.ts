// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Tree-sitter based extractors (SOTA S2) ─────
// Replaces the regex-based extractors for languages where we have a CST
// parser. Handles cases the regex path misses: TS generics, decorators,
// nested classes, namespaced types, async/generator variants, union/type
// declarations, etc.
//
// Loading is lazy — the grammar only initializes when the first file of
// a supported language is parsed. A failed initialization (missing
// native binding, grammar load error) fails open and leaves the caller
// to fall back to regex.

import type { ExtractedCall, ExtractedImport, ExtractedSymbol, Language } from "./types.js";

// ── Lazy grammar loader ───────────────────────

interface ParserState {
    parser: unknown;
    language: unknown;
}

const parserCache = new Map<Language, ParserState | null>(); // null = tried + failed

async function getParser(lang: Language): Promise<ParserState | null> {
    if (parserCache.has(lang)) return parserCache.get(lang) ?? null;
    try {
        const Parser = (await import("tree-sitter")).default;
        let grammar: unknown = null;
        if (lang === "typescript") {
            const mod = await import("tree-sitter-typescript");
            grammar = (mod as { default?: { typescript: unknown; tsx: unknown } }).default?.typescript ?? (mod as { typescript?: unknown }).typescript;
        } else if (lang === "javascript") {
            // tsx grammar accepts JS; reuse it to avoid another native dep.
            const mod = await import("tree-sitter-typescript");
            grammar = (mod as { default?: { tsx: unknown } }).default?.tsx ?? (mod as { tsx?: unknown }).tsx;
        }
        if (!grammar) {
            parserCache.set(lang, null);
            return null;
        }
        const p = new (Parser as new () => { setLanguage: (g: unknown) => void; parse: (s: string) => unknown })();
        p.setLanguage(grammar);
        const state: ParserState = { parser: p, language: grammar };
        parserCache.set(lang, state);
        return state;
    } catch (err) {
        if (process.env.ATLAS_TS_DEBUG === "true") {
            console.warn(`[tree-sitter] failed to load ${lang} grammar:`, (err as Error).message);
        }
        parserCache.set(lang, null);
        return null;
    }
}

export function treeSitterSupports(lang: Language): boolean {
    return lang === "typescript" || lang === "javascript";
}

// ── Node traversal helper ─────────────────────

interface TsNode {
    type: string;
    text: string;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    children: TsNode[];
    childForFieldName(name: string): TsNode | null;
    descendantsOfType(types: string | string[]): TsNode[];
    parent: TsNode | null;
}

function* walk(node: TsNode): Generator<TsNode> {
    yield node;
    for (const c of node.children) yield* walk(c);
}

function fieldText(n: TsNode, name: string): string | undefined {
    return n.childForFieldName(name)?.text;
}

function isExported(n: TsNode): boolean {
    // In tree-sitter-typescript, exported decls are wrapped in export_statement.
    let cur: TsNode | null = n.parent;
    while (cur) {
        if (cur.type === "export_statement") return true;
        if (cur.type === "program") break;
        cur = cur.parent;
    }
    return false;
}

// ── Symbol extraction ─────────────────────────

const TS_SYMBOL_KINDS: Record<string, ExtractedSymbol["kind"]> = {
    function_declaration: "function",
    method_definition: "method",
    class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "enum",
    module_declaration: "module",
    abstract_class_declaration: "class",
};

export async function extractSymbolsTS(source: string, lang: Language): Promise<ExtractedSymbol[]> {
    const state = await getParser(lang);
    if (!state) return [];
    const tree = (state.parser as { parse: (s: string) => { rootNode: TsNode } }).parse(source);
    const out: ExtractedSymbol[] = [];
    for (const n of walk(tree.rootNode)) {
        const kind = TS_SYMBOL_KINDS[n.type];
        if (kind) {
            const name = fieldText(n, "name") ?? n.descendantsOfType("identifier")[0]?.text;
            if (name && name.length >= 1 && name.length <= 120) {
                out.push({
                    name,
                    kind,
                    lineStart: n.startPosition.row + 1,
                    lineEnd: n.endPosition.row + 1,
                    signature: buildSignature(n, kind),
                    exported: isExported(n),
                });
            }
            continue;
        }
        // variable_declarator → const/let/var identifier(s)
        if (n.type === "variable_declarator") {
            const name = fieldText(n, "name") ?? n.descendantsOfType("identifier")[0]?.text;
            const valueNode = n.childForFieldName("value");
            if (!name || name.length > 120) continue;
            // Classify: function-typed values as "function", otherwise "variable"/"constant".
            let k: ExtractedSymbol["kind"] = "variable";
            if (valueNode && (valueNode.type === "arrow_function" || valueNode.type === "function_expression")) {
                k = "function";
            } else {
                // Walk up to the containing variable_statement / lexical_declaration to check for const
                let cur: TsNode | null = n.parent;
                while (cur && cur.type !== "lexical_declaration" && cur.type !== "variable_statement") cur = cur.parent;
                if (cur?.children[0]?.text === "const") k = "constant";
            }
            out.push({
                name,
                kind: k,
                lineStart: n.startPosition.row + 1,
                lineEnd: n.endPosition.row + 1,
                signature: buildSignature(n, k),
                exported: isExported(n),
            });
        }
    }
    return out;
}

function buildSignature(n: TsNode, kind: ExtractedSymbol["kind"]): string {
    const text = n.text.split("\n")[0].trim();
    // Clip at first { or => — we want just the declaration line
    const cut = Math.min(
        ...["{", "=>"].map((s) => {
            const i = text.indexOf(s);
            return i === -1 ? text.length : i;
        }),
    );
    return text.slice(0, cut).trim().slice(0, 200) || kind;
}

// ── Import extraction ─────────────────────────

export async function extractImportsTS(source: string, lang: Language): Promise<ExtractedImport[]> {
    const state = await getParser(lang);
    if (!state) return [];
    const tree = (state.parser as { parse: (s: string) => { rootNode: TsNode } }).parse(source);
    const out: ExtractedImport[] = [];
    for (const n of walk(tree.rootNode)) {
        if (n.type !== "import_statement") continue;
        const src = n.descendantsOfType("string")[0];
        if (!src) continue;
        // Strip quotes from the string literal
        const specifier = src.text.slice(1, -1);
        if (specifier) {
            out.push({
                specifier,
                line: n.startPosition.row + 1,
            });
        }
    }
    // Also match `require("foo")` calls
    for (const n of walk(tree.rootNode)) {
        if (n.type !== "call_expression") continue;
        const fn = n.childForFieldName("function");
        if (fn?.text !== "require") continue;
        const args = n.childForFieldName("arguments");
        const strArg = args?.descendantsOfType("string")[0];
        if (!strArg) continue;
        const specifier = strArg.text.slice(1, -1);
        if (specifier) {
            out.push({ specifier, line: n.startPosition.row + 1 });
        }
    }
    return out;
}

// ── Call extraction ───────────────────────────

const ENCLOSING_SYMBOL_TYPES = new Set([
    "function_declaration",
    "method_definition",
    "arrow_function",
    "function_expression",
    "class_declaration",
    "abstract_class_declaration",
]);

function findEnclosingSymbolName(n: TsNode): string | null {
    let cur: TsNode | null = n.parent;
    while (cur) {
        if (ENCLOSING_SYMBOL_TYPES.has(cur.type)) {
            // Function / method / class name
            const name = cur.childForFieldName("name")?.text;
            if (name) return name;
            // Arrow function assigned to a variable: const x = () => {...}
            if (cur.type === "arrow_function" || cur.type === "function_expression") {
                const decl = cur.parent;
                if (decl?.type === "variable_declarator") {
                    return decl.childForFieldName("name")?.text ?? null;
                }
            }
        }
        cur = cur.parent;
    }
    return null;
}

export async function extractCallsTS(source: string, lang: Language): Promise<ExtractedCall[]> {
    const state = await getParser(lang);
    if (!state) return [];
    const tree = (state.parser as { parse: (s: string) => { rootNode: TsNode } }).parse(source);
    const out: ExtractedCall[] = [];
    for (const n of walk(tree.rootNode)) {
        if (n.type !== "call_expression") continue;
        const fn = n.childForFieldName("function");
        if (!fn) continue;
        let calleeName: string | undefined;
        if (fn.type === "identifier") {
            calleeName = fn.text;
        } else if (fn.type === "member_expression") {
            // foo.bar() — take rightmost property name
            const prop = fn.childForFieldName("property");
            calleeName = prop?.text;
        }
        if (!calleeName || calleeName.length < 2 || calleeName.length > 120) continue;
        out.push({
            fromSymbolName: findEnclosingSymbolName(n),
            calleeName,
            line: n.startPosition.row + 1,
        });
    }
    return out;
}
