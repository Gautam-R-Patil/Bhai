// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Repo Map Tool ──────────────────────────────────────────
// Lightweight AST-free repo map using regex-based symbol extraction.
// Inspired by Aider's tree-sitter repo map but without native dependencies.
// Generates a concise map of functions, classes, interfaces, types, and
// exports for each source file — token-budgeted for LLM context injection.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "./get-current-time.js";

// ── Types ─────────────────────────────────────

export interface CodeSymbol {
    name: string;
    type:
        | "function"
        | "class"
        | "method"
        | "interface"
        | "type"
        | "export"
        | "import"
        | "variable"
        | "enum"
        | "struct"
        | "trait"
        | "module"
        | "constant";
    line: number;
    file: string;
}

export interface RepoMapOptions {
    /** Max files to scan (default 500) */
    maxFiles?: number;
    /** Max output tokens — rough estimate at ~4 chars/token (default 4000) */
    maxTokens?: number;
    /** Glob-like include patterns — simple suffix matching (e.g., ["*.ts", "*.py"]) */
    includePatterns?: string[];
    /** Glob-like exclude patterns — simple substring matching */
    excludePatterns?: string[];
    /** Files mentioned in conversation — prioritized in output */
    priorityFiles?: string[];
    /** Show only the first N symbols per file (default: unlimited) */
    maxSymbolsPerFile?: number;
}

// ── Language Detection ─────────────────────────

type Language =
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
    | "lua";

const EXTENSION_MAP: Record<string, Language> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".pyw": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".hxx": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".swift": "swift",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".php": "php",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".lua": "lua",
};

function detectLanguage(filePath: string): Language | null {
    const ext = path.extname(filePath).toLowerCase();
    return EXTENSION_MAP[ext] ?? null;
}

// ── Regex Patterns per Language ────────────────
// Each entry: [regex, symbolType]
// Regexes are applied line-by-line for simplicity and performance.

interface PatternDef {
    regex: RegExp;
    type: CodeSymbol["type"];
}

const PATTERNS: Record<Language, PatternDef[]> = {
    typescript: [
        { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/, type: "function" },
        { regex: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, type: "class" },
        { regex: /^(?:export\s+)?interface\s+(\w+)/, type: "interface" },
        { regex: /^(?:export\s+)?type\s+(\w+)\s*[=<]/, type: "type" },
        { regex: /^(?:export\s+)?enum\s+(\w+)/, type: "enum" },
        { regex: /^(?:export\s+)?const\s+(\w+)\s*[=:]/, type: "variable" },
        { regex: /^(?:export\s+)?(?:let|var)\s+(\w+)\s*[=:]/, type: "variable" },
        { regex: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/, type: "method" },
        { regex: /^\s+(?:public|private|protected)\s+(?:static\s+)?(?:async\s+)?(\w+)\s*[(<]/, type: "method" },
    ],
    javascript: [
        { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/, type: "function" },
        { regex: /^(?:export\s+)?class\s+(\w+)/, type: "class" },
        { regex: /^(?:export\s+)?const\s+(\w+)\s*=/, type: "variable" },
        { regex: /^(?:export\s+)?(?:let|var)\s+(\w+)\s*=/, type: "variable" },
        { regex: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/, type: "method" },
        { regex: /^module\.exports\s*=\s*\{/, type: "export" },
    ],
    python: [
        { regex: /^(?:async\s+)?def\s+(\w+)/, type: "function" },
        { regex: /^class\s+(\w+)/, type: "class" },
        { regex: /^\s{4}(?:async\s+)?def\s+(\w+)/, type: "method" },
        { regex: /^([A-Z][A-Z_0-9]+)\s*=/, type: "constant" },
    ],
    rust: [
        { regex: /^(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)/, type: "function" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?struct\s+(\w+)/, type: "struct" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?enum\s+(\w+)/, type: "enum" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?trait\s+(\w+)/, type: "trait" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?type\s+(\w+)/, type: "type" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?mod\s+(\w+)/, type: "module" },
        { regex: /^\s+(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)/, type: "method" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?const\s+(\w+)/, type: "constant" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?static\s+(\w+)/, type: "variable" },
    ],
    go: [
        { regex: /^func\s+(\w+)/, type: "function" },
        { regex: /^func\s+\(\w+\s+\*?\w+\)\s+(\w+)/, type: "method" },
        { regex: /^type\s+(\w+)\s+struct/, type: "struct" },
        { regex: /^type\s+(\w+)\s+interface/, type: "interface" },
        { regex: /^type\s+(\w+)\s+/, type: "type" },
        { regex: /^var\s+(\w+)\s+/, type: "variable" },
        { regex: /^const\s+(\w+)\s+/, type: "constant" },
    ],
    java: [
        { regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?class\s+(\w+)/, type: "class" },
        { regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?interface\s+(\w+)/, type: "interface" },
        { regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?enum\s+(\w+)/, type: "enum" },
        {
            regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:synchronized\s+)?(?:final\s+)?(?:[\w<>[\],\s]+)\s+(\w+)\s*\(/,
            type: "method",
        },
    ],
    c: [
        {
            regex: /^(?:static\s+)?(?:inline\s+)?(?:const\s+)?(?:unsigned\s+)?(?:void|int|char|float|double|long|short|size_t|bool|\w+_t|\w+\s*\*)\s+(\w+)\s*\(/,
            type: "function",
        },
        { regex: /^typedef\s+struct\s+(?:\w+\s+)?{/, type: "struct" },
        { regex: /^struct\s+(\w+)\s*\{/, type: "struct" },
        { regex: /^typedef\s+enum\s+(?:\w+\s+)?{/, type: "enum" },
        { regex: /^#define\s+(\w+)/, type: "constant" },
    ],
    cpp: [
        {
            regex: /^(?:virtual\s+)?(?:static\s+)?(?:inline\s+)?(?:const\s+)?(?:[\w:]+(?:<[^>]*>)?[\s*&]+)(\w+)\s*\(/,
            type: "function",
        },
        { regex: /^(?:template\s*<[^>]*>\s*)?class\s+(\w+)/, type: "class" },
        { regex: /^(?:template\s*<[^>]*>\s*)?struct\s+(\w+)/, type: "struct" },
        { regex: /^namespace\s+(\w+)/, type: "module" },
        { regex: /^enum\s+(?:class\s+)?(\w+)/, type: "enum" },
    ],
    csharp: [
        {
            regex: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:partial\s+)?class\s+(\w+)/,
            type: "class",
        },
        { regex: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?interface\s+(\w+)/, type: "interface" },
        { regex: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?enum\s+(\w+)/, type: "enum" },
        {
            regex: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?(?:[\w<>[\]]+)\s+(\w+)\s*\(/,
            type: "method",
        },
        { regex: /^namespace\s+(\w+)/, type: "module" },
    ],
    ruby: [
        { regex: /^\s*def\s+(?:self\.)?(\w+)/, type: "function" },
        { regex: /^\s*class\s+(\w+)/, type: "class" },
        { regex: /^\s*module\s+(\w+)/, type: "module" },
        { regex: /^\s*([A-Z][A-Z_0-9]+)\s*=/, type: "constant" },
    ],
    swift: [
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?func\s+(\w+)/, type: "function" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?class\s+(\w+)/, type: "class" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?struct\s+(\w+)/, type: "struct" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?enum\s+(\w+)/, type: "enum" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?protocol\s+(\w+)/, type: "interface" },
    ],
    kotlin: [
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+)?(?:suspend\s+)?fun\s+(\w+)/, type: "function" },
        {
            regex: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+)?(?:data\s+|sealed\s+|abstract\s+)?class\s+(\w+)/,
            type: "class",
        },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+)?interface\s+(\w+)/, type: "interface" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+)?enum\s+class\s+(\w+)/, type: "enum" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+)?object\s+(\w+)/, type: "class" },
    ],
    php: [
        { regex: /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+(\w+)/, type: "function" },
        { regex: /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, type: "class" },
        { regex: /^\s*interface\s+(\w+)/, type: "interface" },
        { regex: /^\s*trait\s+(\w+)/, type: "trait" },
        { regex: /^\s*enum\s+(\w+)/, type: "enum" },
    ],
    shell: [
        { regex: /^(\w+)\s*\(\)\s*\{/, type: "function" },
        { regex: /^function\s+(\w+)/, type: "function" },
        { regex: /^readonly\s+(\w+)=/, type: "constant" },
        { regex: /^export\s+(\w+)=/, type: "variable" },
    ],
    lua: [
        { regex: /^(?:local\s+)?function\s+(\w[\w.]*)/, type: "function" },
        { regex: /^(\w+)\s*=\s*function/, type: "function" },
        { regex: /^local\s+(\w+)\s*=\s*\{/, type: "variable" },
    ],
};

// ── Gitignore Parser (lightweight) ────────────

interface IgnoreRules {
    patterns: { regex: RegExp; negated: boolean }[];
}

function parseGitignore(gitignorePath: string): IgnoreRules {
    const rules: IgnoreRules = { patterns: [] };
    if (!fs.existsSync(gitignorePath)) return rules;

    try {
        const content = fs.readFileSync(gitignorePath, "utf-8");
        for (let line of content.split("\n")) {
            line = line.trim();
            if (!line || line.startsWith("#")) continue;

            let negated = false;
            if (line.startsWith("!")) {
                negated = true;
                line = line.slice(1);
            }

            // Remove trailing slashes (directory markers)
            line = line.replace(/\/+$/, "");

            // Convert gitignore glob to regex
            let regexStr = line
                .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials (except * and ?)
                .replace(/\*\*/g, "{{GLOBSTAR}}") // temp placeholder
                .replace(/\*/g, "[^/]*") // single * = anything except /
                .replace(/\?/g, "[^/]") // ? = single char except /
                .replace(/\{\{GLOBSTAR\}\}/g, ".*"); // ** = anything including /

            // If the pattern doesn't start with /, match in any subdirectory
            if (!line.startsWith("/")) {
                regexStr = `(?:^|/)${regexStr}`;
            } else {
                regexStr = `^${regexStr.slice(2)}`; // remove leading \/
            }

            regexStr += "(?:/|$)";

            try {
                rules.patterns.push({ regex: new RegExp(regexStr), negated });
            } catch {
                // Skip invalid patterns
            }
        }
    } catch {
        // Skip unreadable .gitignore
    }

    return rules;
}

function isIgnored(relativePath: string, rules: IgnoreRules): boolean {
    let ignored = false;
    for (const { regex, negated } of rules.patterns) {
        if (regex.test(relativePath)) {
            ignored = !negated;
        }
    }
    return ignored;
}

// ── Always-Ignored Directories ────────────────

const ALWAYS_SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "__pycache__",
    ".tox",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "venv",
    ".venv",
    "env",
    ".env",
    "dist",
    "build",
    "out",
    "target",
    ".next",
    ".nuxt",
    ".output",
    "coverage",
    ".cache",
    ".parcel-cache",
    ".turbo",
    ".angular",
    "vendor",
    "Pods",
    ".idea",
    ".vscode",
    ".vs",
]);

const ALWAYS_SKIP_FILES = new Set([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "Cargo.lock",
    "Gemfile.lock",
    "poetry.lock",
    "composer.lock",
    "go.sum",
]);

// ── Symbol Extraction ─────────────────────────

function extractSymbols(filePath: string, content: string, language: Language): CodeSymbol[] {
    const patterns = PATTERNS[language];
    if (!patterns) return [];

    const symbols: CodeSymbol[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { regex, type } of patterns) {
            const match = regex.exec(line);
            if (match && match[1]) {
                // Skip common false positives
                const name = match[1];
                if (
                    name === "if" ||
                    name === "else" ||
                    name === "for" ||
                    name === "while" ||
                    name === "switch" ||
                    name === "case" ||
                    name === "try" ||
                    name === "catch" ||
                    name === "return" ||
                    name === "throw" ||
                    name === "new" ||
                    name === "delete" ||
                    name === "typeof" ||
                    name === "instanceof" ||
                    (name === "constructor" && type === "method")
                ) {
                    continue;
                }
                symbols.push({ name, type, line: i + 1, file: filePath });
            }
        }
    }

    return symbols;
}

// ── Directory Walker ──────────────────────────

function walkDirectory(rootDir: string, ignoreRules: IgnoreRules, options: RepoMapOptions): string[] {
    const files: string[] = [];
    const maxFiles = options.maxFiles ?? 500;
    const includePatterns = options.includePatterns;
    const excludePatterns = options.excludePatterns;

    function walk(dir: string): void {
        if (files.length >= maxFiles) return;

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return; // Permission denied or missing directory
        }

        // Sort: directories first (for breadth), then alphabetical
        entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
            if (files.length >= maxFiles) return;

            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(rootDir, fullPath);

            if (entry.isDirectory()) {
                // Skip always-ignored directories
                if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
                // Skip hidden directories (except .github, .config, etc.)
                if (entry.name.startsWith(".") && !entry.name.startsWith(".github")) continue;
                // Check gitignore
                if (isIgnored(relativePath, ignoreRules)) continue;
                walk(fullPath);
            } else if (entry.isFile()) {
                // Skip always-ignored files
                if (ALWAYS_SKIP_FILES.has(entry.name)) continue;
                // Skip hidden files
                if (entry.name.startsWith(".")) continue;
                // Check gitignore
                if (isIgnored(relativePath, ignoreRules)) continue;

                // Check language support
                const lang = detectLanguage(entry.name);
                if (!lang) continue;

                // Include pattern check (suffix match)
                if (includePatterns && includePatterns.length > 0) {
                    const matches = includePatterns.some((p) => {
                        const pattern = p.startsWith("*") ? p.slice(1) : p;
                        return entry.name.endsWith(pattern) || relativePath.includes(pattern);
                    });
                    if (!matches) continue;
                }

                // Exclude pattern check (substring match)
                if (excludePatterns && excludePatterns.length > 0) {
                    const excluded = excludePatterns.some((p) => {
                        const pattern = p.startsWith("*") ? p.slice(1) : p;
                        return entry.name.includes(pattern) || relativePath.includes(pattern);
                    });
                    if (excluded) continue;
                }

                files.push(fullPath);
            }
        }
    }

    walk(rootDir);
    return files;
}

// ── Token Estimation ──────────────────────────

function estimateTokens(text: string): number {
    // Rough estimate: ~4 characters per token for code
    return Math.ceil(text.length / 4);
}

// ── Repo Map Generation ───────────────────────

export async function generateRepoMap(rootDir: string, options: RepoMapOptions = {}): Promise<string> {
    const maxTokens = options.maxTokens ?? 4000;
    const maxSymbolsPerFile = options.maxSymbolsPerFile;
    const priorityFiles = new Set((options.priorityFiles ?? []).map((f) => path.resolve(rootDir, f)));

    // Parse .gitignore
    const gitignorePath = path.join(rootDir, ".gitignore");
    const ignoreRules = parseGitignore(gitignorePath);

    // Collect files
    const allFiles = walkDirectory(rootDir, ignoreRules, options);

    if (allFiles.length === 0) {
        return `[No source files found in ${rootDir}]`;
    }

    // Extract symbols per file
    const fileSymbols: { file: string; relative: string; symbols: CodeSymbol[] }[] = [];

    for (const filePath of allFiles) {
        const lang = detectLanguage(filePath);
        if (!lang) continue;

        let content: string;
        try {
            // Only read up to 100KB per file to avoid memory issues
            const stat = fs.statSync(filePath);
            if (stat.size > 100_000) continue;
            content = fs.readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }

        const symbols = extractSymbols(filePath, content, lang);
        if (symbols.length === 0) continue;

        fileSymbols.push({
            file: filePath,
            relative: path.relative(rootDir, filePath),
            symbols: maxSymbolsPerFile ? symbols.slice(0, maxSymbolsPerFile) : symbols,
        });
    }

    // Sort: priority files first, then by relative path
    fileSymbols.sort((a, b) => {
        const aPriority = priorityFiles.has(a.file) ? 0 : 1;
        const bPriority = priorityFiles.has(b.file) ? 0 : 1;
        if (aPriority !== bPriority) return aPriority - bPriority;
        return a.relative.localeCompare(b.relative);
    });

    // Build output with token budget
    const lines: string[] = [];
    let totalTokens = 0;
    let filesIncluded = 0;
    const totalFiles = fileSymbols.length;

    for (const { relative, symbols } of fileSymbols) {
        // Build file section
        const sectionLines: string[] = [`${relative}:`];
        for (const sym of symbols) {
            const label =
                sym.type === "method"
                    ? `  ${sym.type} ${sym.name} (line ${sym.line})`
                    : `  ${sym.type} ${sym.name} (line ${sym.line})`;
            sectionLines.push(label);
        }
        sectionLines.push(""); // blank line between files

        const sectionText = sectionLines.join("\n");
        const sectionTokens = estimateTokens(sectionText);

        if (totalTokens + sectionTokens > maxTokens && filesIncluded > 0) {
            // Add truncation notice
            const remaining = totalFiles - filesIncluded;
            lines.push(`\n[... ${remaining} more file(s) omitted — token budget reached]`);
            break;
        }

        lines.push(sectionText);
        totalTokens += sectionTokens;
        filesIncluded++;
    }

    // Header
    const header = `Repository map: ${rootDir}\n${totalFiles} files with symbols, ${filesIncluded} shown\n${"─".repeat(50)}\n`;
    return header + lines.join("\n");
}

// ── Tool Definition ───────────────────────────

export const repoMapTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "repo_map",
            description: `Generate a concise map of a code repository showing key symbols (functions, classes, interfaces, types, etc.) per file.
Use this to quickly understand the structure of a codebase without reading every file.
Supports: TypeScript, JavaScript, Python, Rust, Go, Java, C/C++, C#, Ruby, Swift, Kotlin, PHP, Shell, Lua.
Respects .gitignore and skips common non-source directories (node_modules, dist, .git, etc.).
Output is token-budgeted to fit in LLM context — prioritizes files mentioned in conversation.`,
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description:
                            "Root directory of the repository to map. Defaults to the current working directory.",
                    },
                    max_tokens: {
                        type: "number",
                        description:
                            "Maximum output tokens (default 4000). Increase for larger codebases, decrease for tighter budgets.",
                    },
                    max_files: {
                        type: "number",
                        description: "Maximum number of files to scan (default 500). Increase for larger repos.",
                    },
                    include_patterns: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Only include files matching these patterns (e.g., ['*.ts', '*.py']). If empty, includes all supported languages.",
                    },
                    exclude_patterns: {
                        type: "array",
                        items: { type: "string" },
                        description: "Exclude files matching these patterns (e.g., ['test', 'spec', '__mocks__']).",
                    },
                    priority_files: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Files to prioritize in the output (shown first, never truncated). Use relative paths from the repo root.",
                    },
                    max_symbols_per_file: {
                        type: "number",
                        description: "Limit symbols shown per file. Useful for large files. Default: no limit.",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input: Record<string, unknown>): Promise<string> {
        const rootDir = (input.path as string) || process.cwd();
        const maxTokens = (input.max_tokens as number) || 4000;
        const maxFiles = (input.max_files as number) || 500;
        const includePatterns = input.include_patterns as string[] | undefined;
        const excludePatterns = input.exclude_patterns as string[] | undefined;
        const priorityFiles = input.priority_files as string[] | undefined;
        const maxSymbolsPerFile = input.max_symbols_per_file as number | undefined;

        // Validate path
        if (!fs.existsSync(rootDir)) {
            return JSON.stringify({ error: `Directory not found: ${rootDir}` });
        }

        try {
            const stat = fs.statSync(rootDir);
            if (!stat.isDirectory()) {
                return JSON.stringify({ error: `Not a directory: ${rootDir}` });
            }
        } catch {
            return JSON.stringify({ error: `Cannot access: ${rootDir}` });
        }

        try {
            const map = await generateRepoMap(rootDir, {
                maxTokens,
                maxFiles,
                includePatterns,
                excludePatterns,
                priorityFiles,
                maxSymbolsPerFile,
            });
            return map;
        } catch (err) {
            return JSON.stringify({ error: `Repo map generation failed: ${(err as Error).message}` });
        }
    },
};
