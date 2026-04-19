// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Code Parse Shared Types ───────────────────
// Types produced by every language extractor and consumed by the
// indexer. Keep these stable — changing them forces a sidecar rebuild.

export type SymbolKind =
    | "function"
    | "class"
    | "method"
    | "interface"
    | "type"
    | "enum"
    | "export"
    | "trait"
    | "struct"
    | "module"
    | "constant"
    | "variable";

export interface ExtractedSymbol {
    name: string;
    kind: SymbolKind;
    lineStart: number;
    lineEnd: number | null;
    signature: string | null;
    exported: boolean;
}

export interface ExtractedImport {
    specifier: string;
    line: number;
}

export interface ExtractedCall {
    fromSymbolName: string | null; // null when call is module-top-level
    calleeName: string;
    line: number;
}

export interface ParseResult {
    symbols: ExtractedSymbol[];
    imports: ExtractedImport[];
    calls: ExtractedCall[];
    loc: number;
    truncated: boolean;
    error: string | null;
}

export type Language =
    | "typescript"
    | "javascript"
    | "python"
    | "rust"
    | "go"
    | "java"
    | "c"
    | "cpp"
    | "csharp"
    | "ruby"
    | "swift"
    | "kotlin"
    | "php"
    | "shell"
    | "lua"
    | "file-only";

export const KEYWORD_NAMES = new Set([
    "if",
    "else",
    "for",
    "while",
    "switch",
    "case",
    "try",
    "catch",
    "return",
    "throw",
    "new",
    "delete",
    "typeof",
    "instanceof",
    "constructor",
    "do",
    "with",
    "async",
    "await",
    "yield",
    "const",
    "let",
    "var",
    "function",
    "class",
    "interface",
    "type",
    "enum",
    "import",
    "export",
    "from",
    "as",
    "break",
    "continue",
    "default",
    "finally",
    "in",
    "of",
    "this",
    "super",
    "public",
    "private",
    "protected",
    "static",
    "abstract",
    "readonly",
]);
