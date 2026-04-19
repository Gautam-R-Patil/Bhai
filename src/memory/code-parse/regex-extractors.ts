// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Regex Extractors ──────────────────────────
// Thin layer over src/tools/repo-map.ts PATTERNS for symbol extraction,
// plus patterns repo-map lacks: imports and calls. Line-by-line regex
// (no backtracking risk). Strings + comments stripped for imports/calls.

import type { ExtractedCall, ExtractedImport, ExtractedSymbol, Language, SymbolKind } from "./types.js";
import { KEYWORD_NAMES } from "./types.js";

// ── Symbol patterns (duplicated inline for direct control) ──
// Mirrors src/tools/repo-map.ts PATTERNS but typed against our SymbolKind.

interface SymbolPattern {
    regex: RegExp;
    kind: SymbolKind;
    exportGroup?: boolean;
}

const SYMBOL_PATTERNS: Record<Language, SymbolPattern[]> = {
    typescript: [
        { regex: /^(export\s+)?(?:async\s+)?function\s+(\w+)/, kind: "function", exportGroup: true },
        { regex: /^(export\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: "class", exportGroup: true },
        { regex: /^(export\s+)?interface\s+(\w+)/, kind: "interface", exportGroup: true },
        { regex: /^(export\s+)?type\s+(\w+)\s*[=<]/, kind: "type", exportGroup: true },
        { regex: /^(export\s+)?enum\s+(\w+)/, kind: "enum", exportGroup: true },
        { regex: /^(export\s+)?const\s+(\w+)\s*[=:]/, kind: "constant", exportGroup: true },
        { regex: /^(export\s+)?(?:let|var)\s+(\w+)\s*[=:]/, kind: "variable", exportGroup: true },
        // Matches class-body methods only. Arrow-function methods
        // (`foo = (x) => ...`) and object-literal methods are not captured.
        { regex: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/, kind: "method" },
        { regex: /^\s+(?:public|private|protected)\s+(?:static\s+)?(?:async\s+)?(\w+)\s*[(<]/, kind: "method" },
    ],
    javascript: [
        { regex: /^(export\s+)?(?:async\s+)?function\s+(\w+)/, kind: "function", exportGroup: true },
        { regex: /^(export\s+)?class\s+(\w+)/, kind: "class", exportGroup: true },
        { regex: /^(export\s+)?const\s+(\w+)\s*=/, kind: "constant", exportGroup: true },
        { regex: /^(export\s+)?(?:let|var)\s+(\w+)\s*=/, kind: "variable", exportGroup: true },
        { regex: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/, kind: "method" },
    ],
    python: [
        { regex: /^(?:async\s+)?def\s+(\w+)/, kind: "function" },
        { regex: /^class\s+(\w+)/, kind: "class" },
        { regex: /^\s{4}(?:async\s+)?def\s+(\w+)/, kind: "method" },
        { regex: /^([A-Z][A-Z_0-9]+)\s*=/, kind: "constant" },
    ],
    rust: [
        { regex: /^(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)/, kind: "function" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?struct\s+(\w+)/, kind: "struct" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?enum\s+(\w+)/, kind: "enum" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?trait\s+(\w+)/, kind: "trait" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?type\s+(\w+)/, kind: "type" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?mod\s+(\w+)/, kind: "module" },
        { regex: /^\s+(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)/, kind: "method" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?const\s+(\w+)/, kind: "constant" },
    ],
    go: [
        { regex: /^func\s+(\w+)/, kind: "function" },
        { regex: /^func\s+\(\w+\s+\*?\w+\)\s+(\w+)/, kind: "method" },
        { regex: /^type\s+(\w+)\s+struct/, kind: "struct" },
        { regex: /^type\s+(\w+)\s+interface/, kind: "interface" },
        { regex: /^type\s+(\w+)\s+/, kind: "type" },
        { regex: /^const\s+(\w+)\s+/, kind: "constant" },
    ],
    java: [
        { regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?class\s+(\w+)/, kind: "class" },
        { regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?interface\s+(\w+)/, kind: "interface" },
        { regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?enum\s+(\w+)/, kind: "enum" },
        {
            regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:synchronized\s+)?(?:final\s+)?(?:[\w<>[\],\s]+)\s+(\w+)\s*\(/,
            kind: "method",
        },
    ],
    c: [
        {
            regex: /^(?:static\s+)?(?:inline\s+)?(?:const\s+)?(?:unsigned\s+)?(?:void|int|char|float|double|long|short|size_t|bool|\w+_t|\w+\s*\*)\s+(\w+)\s*\(/,
            kind: "function",
        },
        { regex: /^struct\s+(\w+)\s*\{/, kind: "struct" },
    ],
    cpp: [
        {
            regex: /^(?:virtual\s+)?(?:static\s+)?(?:inline\s+)?(?:const\s+)?(?:[\w:]+(?:<[^>]*>)?[\s*&]+)(\w+)\s*\(/,
            kind: "function",
        },
        { regex: /^(?:template\s*<[^>]*>\s*)?class\s+(\w+)/, kind: "class" },
        { regex: /^(?:template\s*<[^>]*>\s*)?struct\s+(\w+)/, kind: "struct" },
        { regex: /^namespace\s+(\w+)/, kind: "module" },
        { regex: /^enum\s+(?:class\s+)?(\w+)/, kind: "enum" },
    ],
    csharp: [
        {
            regex: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:partial\s+)?class\s+(\w+)/,
            kind: "class",
        },
        { regex: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?interface\s+(\w+)/, kind: "interface" },
        { regex: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?enum\s+(\w+)/, kind: "enum" },
        {
            regex: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?(?:[\w<>[\]]+)\s+(\w+)\s*\(/,
            kind: "method",
        },
        { regex: /^namespace\s+(\w+)/, kind: "module" },
    ],
    ruby: [
        { regex: /^\s*def\s+(?:self\.)?(\w+)/, kind: "function" },
        { regex: /^\s*class\s+(\w+)/, kind: "class" },
        { regex: /^\s*module\s+(\w+)/, kind: "module" },
    ],
    swift: [
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?func\s+(\w+)/, kind: "function" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?class\s+(\w+)/, kind: "class" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?struct\s+(\w+)/, kind: "struct" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?enum\s+(\w+)/, kind: "enum" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?protocol\s+(\w+)/, kind: "interface" },
    ],
    kotlin: [
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+)?(?:suspend\s+)?fun\s+(\w+)/, kind: "function" },
        {
            regex: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+)?(?:data\s+|sealed\s+|abstract\s+)?class\s+(\w+)/,
            kind: "class",
        },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+)?interface\s+(\w+)/, kind: "interface" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+)?enum\s+class\s+(\w+)/, kind: "enum" },
    ],
    php: [
        { regex: /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+(\w+)/, kind: "function" },
        { regex: /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, kind: "class" },
        { regex: /^\s*interface\s+(\w+)/, kind: "interface" },
        { regex: /^\s*trait\s+(\w+)/, kind: "trait" },
    ],
    shell: [
        { regex: /^(\w+)\s*\(\)\s*\{/, kind: "function" },
        { regex: /^function\s+(\w+)/, kind: "function" },
    ],
    lua: [{ regex: /^(?:local\s+)?function\s+(\w[\w.]*)/, kind: "function" }],
    "file-only": [],
};

// ── Import patterns (per language) ──

const IMPORT_PATTERNS: Record<Language, RegExp[]> = {
    // Note: single-line imports only. Multi-line TS/JS imports (e.g.
    // `import {\n  a,\n  b,\n} from "./x"`) are not captured by this regex.
    typescript: [
        /^\s*import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\w+))?\s+from\s+['"]([^'"]+)['"]/,
        /^\s*import\s+['"]([^'"]+)['"]/,
        /^\s*(?:const|let|var)\s+\w+\s*=\s*require\(['"]([^'"]+)['"]\)/,
        /^\s*export\s+\*\s+from\s+['"]([^'"]+)['"]/,
        /^\s*export\s+\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/,
    ],
    javascript: [
        /^\s*import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\w+))?\s+from\s+['"]([^'"]+)['"]/,
        /^\s*import\s+['"]([^'"]+)['"]/,
        /^\s*(?:const|let|var)\s+\w+\s*=\s*require\(['"]([^'"]+)['"]\)/,
    ],
    python: [/^\s*from\s+([\w.]+)\s+import/, /^\s*import\s+([\w.]+)/],
    rust: [/^\s*use\s+([\w:]+)/, /^\s*(?:pub\s+)?extern\s+crate\s+(\w+)/],
    go: [
        /^\s*import\s+"([^"]+)"/,
        // Opens an import block; specifiers inside the parens (common in Go)
        // are not captured by this line-by-line regex.
        /^\s*import\s+\(\s*$/,
    ],
    java: [/^\s*import\s+([\w.]+)/],
    c: [/^\s*#include\s+[<"]([^>"]+)[>"]/],
    cpp: [/^\s*#include\s+[<"]([^>"]+)[>"]/],
    csharp: [/^\s*using\s+([\w.]+)/],
    ruby: [/^\s*require\s+['"]([^'"]+)['"]/, /^\s*require_relative\s+['"]([^'"]+)['"]/],
    swift: [/^\s*import\s+(\w+)/],
    kotlin: [/^\s*import\s+([\w.]+)/],
    php: [/^\s*use\s+([\w\\]+)/, /^\s*require(?:_once)?\s+['"]([^'"]+)['"]/],
    shell: [/^\s*(?:source|\.)\s+([^\s;]+)/],
    lua: [/^\s*(?:local\s+\w+\s*=\s*)?require\s*\(?['"]([^'"]+)['"]\)?/],
    "file-only": [],
};

// ── Call patterns (best-effort — only for full-tier languages) ──

const CALL_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

// Languages where we attempt call extraction.
const CALL_LANGS = new Set<Language>([
    "typescript",
    "javascript",
    "python",
    "rust",
    "go",
    "java",
    "csharp",
    "swift",
    "kotlin",
    "ruby",
    "php",
]);

// ── Utilities: strip strings and line comments ──

// Best-effort line-level strip. Does not handle:
//   • block comments `/* … */` (only matters if inline with a call)
//   • Python triple-quoted strings — interior lines scanned as code
function stripStringsAndComments(line: string, lang: Language): string {
    let out = line;
    // Strip // and # line comments (language-aware)
    const hashLangs: Language[] = ["python", "ruby", "shell"];
    if (hashLangs.includes(lang)) {
        out = out.replace(/#.*$/, "");
    } else {
        out = out.replace(/\/\/.*$/, "");
    }
    // Strip quoted strings: "...", '...', `...`
    out = out.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    out = out.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    out = out.replace(/`(?:[^`\\]|\\.)*`/g, "``");
    return out;
}

// ── Public extractors ──

export function extractSymbols(lang: Language, content: string): ExtractedSymbol[] {
    const patterns = SYMBOL_PATTERNS[lang];
    if (!patterns || patterns.length === 0) return [];
    const lines = content.split("\n");
    const out: ExtractedSymbol[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const p of patterns) {
            const m = p.regex.exec(line);
            if (!m) continue;
            // Captured name is the last non-empty group (1 or 2 depending on pattern).
            const name = m[2] && m[2].length > 0 ? m[2] : m[1];
            if (!name || KEYWORD_NAMES.has(name)) continue;
            const exported = p.exportGroup ? m[1] === "export " : false;
            out.push({
                name,
                kind: p.kind,
                lineStart: i + 1,
                lineEnd: null,
                signature: line.trim().slice(0, 240),
                exported,
            });
            break; // one symbol per line
        }
    }
    return out;
}

export function extractImports(lang: Language, content: string): ExtractedImport[] {
    const patterns = IMPORT_PATTERNS[lang];
    if (!patterns || patterns.length === 0) return [];
    const lines = content.split("\n");
    const out: ExtractedImport[] = [];
    for (let i = 0; i < lines.length; i++) {
        const stripped = stripStringsAndComments(lines[i], lang);
        for (const re of patterns) {
            const m = re.exec(lines[i]); // run against raw to preserve the specifier string
            if (m?.[1]) {
                out.push({ specifier: m[1], line: i + 1 });
                break;
            }
            // Still try stripped form as a secondary pass
            const m2 = re.exec(stripped);
            if (m2?.[1]) {
                out.push({ specifier: m2[1], line: i + 1 });
                break;
            }
        }
    }
    return out;
}

export function extractCalls(lang: Language, content: string, symbols: ExtractedSymbol[]): ExtractedCall[] {
    if (!CALL_LANGS.has(lang)) return [];
    const lines = content.split("\n");
    const out: ExtractedCall[] = [];

    // Build a line → enclosing symbol map (best-effort: symbols in order of lineStart)
    const sortedSyms = [...symbols].sort((a, b) => a.lineStart - b.lineStart);

    for (let i = 0; i < lines.length; i++) {
        const stripped = stripStringsAndComments(lines[i], lang);
        // Reset regex.lastIndex because of the /g flag
        CALL_PATTERN.lastIndex = 0;
        let m = CALL_PATTERN.exec(stripped);
        while (m !== null) {
            const name = m[1];
            if (!KEYWORD_NAMES.has(name) && name.length > 1) {
                // Find enclosing symbol: the symbol with the greatest lineStart <= i+1
                let enclosing: string | null = null;
                for (const s of sortedSyms) {
                    if (s.lineStart <= i + 1) enclosing = s.name;
                    else break;
                }
                out.push({ fromSymbolName: enclosing, calleeName: name, line: i + 1 });
            }
            m = CALL_PATTERN.exec(stripped);
        }
    }
    return out;
}

/** Language-agnostic loc (non-empty, non-comment-only lines). */
export function countLoc(content: string, lang: Language): number {
    const hashLangs: Language[] = ["python", "ruby", "shell"];
    const lines = content.split("\n");
    let count = 0;
    for (const ln of lines) {
        const t = ln.trim();
        if (!t) continue;
        if (hashLangs.includes(lang) && t.startsWith("#")) continue;
        if (!hashLangs.includes(lang) && (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*"))) continue;
        count++;
    }
    return count;
}
