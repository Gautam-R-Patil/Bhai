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

async function loadLanguage(lang: Language): Promise<unknown> {
    if (lang === "typescript") {
        const mod = (await import("tree-sitter-typescript")) as { default?: { typescript?: unknown; tsx?: unknown }; typescript?: unknown; tsx?: unknown };
        return mod.default?.typescript ?? mod.typescript;
    }
    if (lang === "javascript") {
        // tsx grammar accepts JS; reuse it to avoid another native dep.
        const mod = (await import("tree-sitter-typescript")) as { default?: { tsx?: unknown }; tsx?: unknown };
        return mod.default?.tsx ?? mod.tsx;
    }
    if (lang === "python") {
        const mod = (await import("tree-sitter-python")) as { default?: { language?: unknown }; language?: unknown };
        return mod.default?.language ?? mod.language ?? mod.default;
    }
    if (lang === "rust") {
        const mod = (await import("tree-sitter-rust")) as { default?: { language?: unknown }; language?: unknown };
        return mod.default?.language ?? mod.language ?? mod.default;
    }
    if (lang === "go") {
        const mod = (await import("tree-sitter-go")) as { default?: { language?: unknown }; language?: unknown };
        return mod.default?.language ?? mod.language ?? mod.default;
    }
    return null;
}

async function getParser(lang: Language): Promise<ParserState | null> {
    if (parserCache.has(lang)) return parserCache.get(lang) ?? null;
    try {
        const Parser = (await import("tree-sitter")).default;
        const grammar = await loadLanguage(lang);
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
        if (process.env.BHAI_TS_DEBUG === "true") {
            console.warn(`[tree-sitter] failed to load ${lang} grammar:`, (err as Error).message);
        }
        parserCache.set(lang, null);
        return null;
    }
}

export function treeSitterSupports(lang: Language): boolean {
    // TS + JS are always on. Python / Rust / Go are behind BHAI_MULTI_TREE_SITTER
    // because the native tree-sitter 0.22 binding has a multi-grammar state bug
    // (node subclass tables collide when more than one grammar is loaded in the
    // same process). The extractors below work correctly on their own — the
    // guard just prevents the crash on combined workloads. Remove the flag once
    // tree-sitter core is upgraded to a version that fixes this.
    if (lang === "typescript" || lang === "javascript") return true;
    if (process.env.BHAI_MULTI_TREE_SITTER !== "true") return false;
    return lang === "python" || lang === "rust" || lang === "go";
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

// ── Per-language symbol node maps ─────────────

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

const PY_SYMBOL_KINDS: Record<string, ExtractedSymbol["kind"]> = {
    function_definition: "function",
    class_definition: "class",
};

const RUST_SYMBOL_KINDS: Record<string, ExtractedSymbol["kind"]> = {
    function_item: "function",
    struct_item: "struct",
    enum_item: "enum",
    trait_item: "trait",
    mod_item: "module",
    macro_definition: "function", // macros behave as callable symbols
    type_item: "type",
};

const GO_SYMBOL_KINDS: Record<string, ExtractedSymbol["kind"]> = {
    function_declaration: "function",
    method_declaration: "method",
};

// ── Dispatcher ────────────────────────────────

export async function extractSymbolsTS(source: string, lang: Language): Promise<ExtractedSymbol[]> {
    if (lang === "typescript" || lang === "javascript") return extractSymbolsTsJs(source, lang);
    if (lang === "python") return extractSymbolsPython(source);
    if (lang === "rust") return extractSymbolsRust(source);
    if (lang === "go") return extractSymbolsGo(source);
    return [];
}

async function extractSymbolsTsJs(source: string, lang: Language): Promise<ExtractedSymbol[]> {
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

// ── Python extraction ─────────────────────────

async function extractSymbolsPython(source: string): Promise<ExtractedSymbol[]> {
    const state = await getParser("python");
    if (!state) return [];
    const tree = (state.parser as { parse: (s: string) => { rootNode: TsNode } }).parse(source);
    const out: ExtractedSymbol[] = [];
    const seenRanges = new Set<number>();
    for (const n of walk(tree.rootNode)) {
        // decorated_definition wraps function_definition / class_definition.
        // We index only the inner node (so @decorator @classmethod foo yields
        // one "foo" symbol, not two duplicates).
        const kind = PY_SYMBOL_KINDS[n.type];
        if (kind) {
            if (seenRanges.has(n.startPosition.row)) continue;
            seenRanges.add(n.startPosition.row);
            const name = fieldText(n, "name");
            if (!name || name.length > 120) continue;
            out.push({
                name,
                kind,
                lineStart: n.startPosition.row + 1,
                lineEnd: n.endPosition.row + 1,
                signature: buildSignature(n, kind),
                exported: !name.startsWith("_"), // Python convention
            });
            continue;
        }
        // Module-level assignments (uppercase → constant, else variable).
        if (n.type === "assignment" && n.parent?.type === "module") {
            const left = n.childForFieldName("left");
            if (left?.type === "identifier") {
                const name = left.text;
                if (name && name.length <= 120) {
                    const k: ExtractedSymbol["kind"] = name === name.toUpperCase() ? "constant" : "variable";
                    out.push({
                        name,
                        kind: k,
                        lineStart: n.startPosition.row + 1,
                        lineEnd: n.endPosition.row + 1,
                        signature: buildSignature(n, k),
                        exported: !name.startsWith("_"),
                    });
                }
            }
        }
    }
    return out;
}

async function extractImportsPython(source: string): Promise<ExtractedImport[]> {
    const state = await getParser("python");
    if (!state) return [];
    const tree = (state.parser as { parse: (s: string) => { rootNode: TsNode } }).parse(source);
    const out: ExtractedImport[] = [];
    for (const n of walk(tree.rootNode)) {
        if (n.type === "import_statement") {
            for (const nm of n.descendantsOfType(["dotted_name", "aliased_import"])) {
                const base = nm.type === "aliased_import" ? nm.childForFieldName("name")?.text : nm.text;
                if (base) out.push({ specifier: base.split(".")[0], line: n.startPosition.row + 1 });
            }
        } else if (n.type === "import_from_statement") {
            const mod = n.childForFieldName("module_name")?.text;
            if (mod) out.push({ specifier: mod, line: n.startPosition.row + 1 });
        }
    }
    return out;
}

async function extractCallsPython(source: string): Promise<ExtractedCall[]> {
    const state = await getParser("python");
    if (!state) return [];
    const tree = (state.parser as { parse: (s: string) => { rootNode: TsNode } }).parse(source);
    const out: ExtractedCall[] = [];
    for (const n of walk(tree.rootNode)) {
        if (n.type !== "call") continue;
        const fn = n.childForFieldName("function");
        if (!fn) continue;
        let calleeName: string | undefined;
        if (fn.type === "identifier") calleeName = fn.text;
        else if (fn.type === "attribute") calleeName = fn.childForFieldName("attribute")?.text;
        if (!calleeName || calleeName.length < 2 || calleeName.length > 120) continue;
        out.push({
            fromSymbolName: findEnclosingSymbolName(n),
            calleeName,
            line: n.startPosition.row + 1,
        });
    }
    return out;
}

// ── Rust extraction ───────────────────────────

async function extractSymbolsRust(source: string): Promise<ExtractedSymbol[]> {
    const state = await getParser("rust");
    if (!state) return [];
    const tree = (state.parser as { parse: (s: string) => { rootNode: TsNode } }).parse(source);
    const out: ExtractedSymbol[] = [];
    for (const n of walk(tree.rootNode)) {
        const kind = RUST_SYMBOL_KINDS[n.type];
        if (!kind) continue;
        const name = fieldText(n, "name");
        if (!name || name.length > 120) continue;
        out.push({
            name,
            kind,
            lineStart: n.startPosition.row + 1,
            lineEnd: n.endPosition.row + 1,
            signature: buildSignature(n, kind),
            // In Rust, `pub` prefix marks exported. Check the first few tokens.
            exported: /^pub\b/.test(n.text.slice(0, 40)),
        });
    }
    return out;
}

async function extractImportsRust(source: string): Promise<ExtractedImport[]> {
    const state = await getParser("rust");
    if (!state) return [];
    const tree = (state.parser as { parse: (s: string) => { rootNode: TsNode } }).parse(source);
    const out: ExtractedImport[] = [];
    for (const n of walk(tree.rootNode)) {
        if (n.type !== "use_declaration") continue;
        // Take the crate root of the use tree: `use foo::bar::Baz;` → "foo"
        const txt = n.text.replace(/^use\s+/, "").replace(/[;\s].*$/, "");
        const crate = txt.split("::")[0];
        if (crate && crate.length > 0) {
            out.push({ specifier: crate, line: n.startPosition.row + 1 });
        }
    }
    return out;
}

async function extractCallsRust(source: string): Promise<ExtractedCall[]> {
    const state = await getParser("rust");
    if (!state) return [];
    const tree = (state.parser as { parse: (s: string) => { rootNode: TsNode } }).parse(source);
    const out: ExtractedCall[] = [];
    for (const n of walk(tree.rootNode)) {
        if (n.type === "call_expression") {
            const fn = n.childForFieldName("function");
            if (!fn) continue;
            let calleeName: string | undefined;
            if (fn.type === "identifier") calleeName = fn.text;
            else if (fn.type === "field_expression") calleeName = fn.childForFieldName("field")?.text;
            else if (fn.type === "scoped_identifier") calleeName = fn.childForFieldName("name")?.text;
            if (!calleeName || calleeName.length < 2 || calleeName.length > 120) continue;
            out.push({
                fromSymbolName: findEnclosingSymbolName(n),
                calleeName,
                line: n.startPosition.row + 1,
            });
        } else if (n.type === "macro_invocation") {
            const macro = n.childForFieldName("macro")?.text;
            if (!macro) continue;
            const calleeName = macro.split("::").pop();
            if (!calleeName || calleeName.length < 2 || calleeName.length > 120) continue;
            out.push({
                fromSymbolName: findEnclosingSymbolName(n),
                calleeName: `${calleeName}!`,
                line: n.startPosition.row + 1,
            });
        }
    }
    return out;
}

// ── Go extraction ─────────────────────────────

async function extractSymbolsGo(source: string): Promise<ExtractedSymbol[]> {
    const state = await getParser("go");
    if (!state) return [];
    const tree = (state.parser as { parse: (s: string) => { rootNode: TsNode } }).parse(source);
    const out: ExtractedSymbol[] = [];
    for (const n of walk(tree.rootNode)) {
        const kind = GO_SYMBOL_KINDS[n.type];
        if (kind) {
            const name = fieldText(n, "name");
            if (!name || name.length > 120) continue;
            out.push({
                name,
                kind,
                lineStart: n.startPosition.row + 1,
                lineEnd: n.endPosition.row + 1,
                signature: buildSignature(n, kind),
                // Go convention: capitalized identifiers are exported.
                exported: /^[A-Z]/.test(name),
            });
            continue;
        }
        // type_spec nodes are nested inside type_declaration; they carry
        // individual type definitions (struct, interface, alias).
        if (n.type === "type_spec") {
            const name = fieldText(n, "name");
            if (!name || name.length > 120) continue;
            const rhs = n.childForFieldName("type");
            let k: ExtractedSymbol["kind"] = "type";
            if (rhs?.type === "struct_type") k = "struct";
            else if (rhs?.type === "interface_type") k = "interface";
            out.push({
                name,
                kind: k,
                lineStart: n.startPosition.row + 1,
                lineEnd: n.endPosition.row + 1,
                signature: buildSignature(n, k),
                exported: /^[A-Z]/.test(name),
            });
        }
    }
    return out;
}

async function extractImportsGo(source: string): Promise<ExtractedImport[]> {
    const state = await getParser("go");
    if (!state) return [];
    const tree = (state.parser as { parse: (s: string) => { rootNode: TsNode } }).parse(source);
    const out: ExtractedImport[] = [];
    for (const n of walk(tree.rootNode)) {
        if (n.type !== "import_declaration") continue;
        for (const strNode of n.descendantsOfType("interpreted_string_literal")) {
            const specifier = strNode.text.slice(1, -1);
            if (specifier) {
                out.push({ specifier, line: strNode.startPosition.row + 1 });
            }
        }
    }
    return out;
}

async function extractCallsGo(source: string): Promise<ExtractedCall[]> {
    const state = await getParser("go");
    if (!state) return [];
    const tree = (state.parser as { parse: (s: string) => { rootNode: TsNode } }).parse(source);
    const out: ExtractedCall[] = [];
    for (const n of walk(tree.rootNode)) {
        if (n.type !== "call_expression") continue;
        const fn = n.childForFieldName("function");
        if (!fn) continue;
        let calleeName: string | undefined;
        if (fn.type === "identifier") calleeName = fn.text;
        else if (fn.type === "selector_expression") calleeName = fn.childForFieldName("field")?.text;
        if (!calleeName || calleeName.length < 2 || calleeName.length > 120) continue;
        out.push({
            fromSymbolName: findEnclosingSymbolName(n),
            calleeName,
            line: n.startPosition.row + 1,
        });
    }
    return out;
}

// ── Import extraction ─────────────────────────

export async function extractImportsTS(source: string, lang: Language): Promise<ExtractedImport[]> {
    if (lang === "python") return extractImportsPython(source);
    if (lang === "rust") return extractImportsRust(source);
    if (lang === "go") return extractImportsGo(source);
    return extractImportsTsJs(source, lang);
}

async function extractImportsTsJs(source: string, lang: Language): Promise<ExtractedImport[]> {
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
    // TS / JS
    "function_declaration",
    "method_definition",
    "arrow_function",
    "function_expression",
    "class_declaration",
    "abstract_class_declaration",
    // Python
    "function_definition",
    "class_definition",
    // Rust
    "function_item",
    "macro_definition",
    "impl_item",
    // Go
    "method_declaration",
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
    if (lang === "python") return extractCallsPython(source);
    if (lang === "rust") return extractCallsRust(source);
    if (lang === "go") return extractCallsGo(source);
    return extractCallsTsJs(source, lang);
}

async function extractCallsTsJs(source: string, lang: Language): Promise<ExtractedCall[]> {
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
