// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Template Registry ───────────────────────────
// Loads bundled templates from skills/templates/ and store-installed templates
// from ~/.atlas/store/templates/. Each template is a directory with a meta.yml
// (or meta.yaml/meta.json) plus its source files (template.html + styles.css
// for HTML, template.md for Markdown, template.docx for DOCX).
//
// Templates are plain data — rendering logic lives in src/documents/renderers/.
// That separation lets the Convex store marketplace ship new templates without
// shipping new code.

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import type { DocumentType } from "./schema.js";

export type TemplateFormat = "pdf" | "docx";
export type TemplateRenderKind = "html" | "markdown" | "docx" | "resumed-theme";

export interface TemplateMeta {
    id: string;
    name: string;
    description: string;
    documentTypes: DocumentType[];
    supports: TemplateFormat[];
    renderKind: TemplateRenderKind;
    /** For resumed-theme: npm package name. For docx/html/markdown: main source file relative to dir. */
    source: string;
    /** Optional: CSS file (HTML kind). */
    styles?: string;
    /** Optional: override page size / orientation / margin. */
    page?: {
        format?: "Letter" | "A4";
        margin?: { top?: string; bottom?: string; left?: string; right?: string };
        landscape?: boolean;
    };
    /** Filesystem dir — absolute. Populated by loader. */
    dir: string;
    /** Source of this template — "bundled" (repo) or "store" (user-installed). */
    origin: "bundled" | "store";
}

const registry: Map<string, TemplateMeta> = new Map();
let loaded = false;

function repoRoot(): string {
    // This file lives at src/documents/templates.ts (dev) or dist/documents/templates.js (prod).
    // Walk up to the directory containing package.json.
    const here = path.dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, "package.json"))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return process.cwd();
}

function bundledDir(): string {
    return path.join(repoRoot(), "skills", "templates");
}

function storeDir(): string {
    return path.join(homedir(), ".atlas", "store", "templates");
}

function readMetaFile(dir: string): Record<string, unknown> | null {
    for (const name of ["meta.yml", "meta.yaml", "meta.json"]) {
        const p = path.join(dir, name);
        if (!fs.existsSync(p)) continue;
        try {
            const raw = fs.readFileSync(p, "utf-8");
            if (name.endsWith(".json")) {
                return JSON.parse(raw);
            }
            // gray-matter parses frontmatter; wrap the YAML as frontmatter so it works
            const parsed = matter(`---\n${raw}\n---\n`);
            return parsed.data;
        } catch (err) {
            console.warn(`[templates] Failed to parse ${p}: ${(err as Error).message}`);
            return null;
        }
    }
    return null;
}

function parseTemplate(dir: string, origin: "bundled" | "store"): TemplateMeta | null {
    const meta = readMetaFile(dir);
    if (!meta) return null;

    const id = typeof meta.id === "string" ? meta.id : path.basename(dir);
    const name = typeof meta.name === "string" ? meta.name : id;
    const description = typeof meta.description === "string" ? meta.description : "";

    const documentTypes = Array.isArray(meta.documentTypes)
        ? (meta.documentTypes.filter((t) => typeof t === "string") as DocumentType[])
        : ["generic" as DocumentType];

    const supports = Array.isArray(meta.supports)
        ? (meta.supports.filter((s) => s === "pdf" || s === "docx") as TemplateFormat[])
        : ["pdf" as TemplateFormat];

    const renderKind =
        typeof meta.renderKind === "string" && ["html", "markdown", "docx", "resumed-theme"].includes(meta.renderKind)
            ? (meta.renderKind as TemplateRenderKind)
            : "html";

    const source = typeof meta.source === "string" ? meta.source : "template.html";
    const styles = typeof meta.styles === "string" ? meta.styles : undefined;
    const page = meta.page && typeof meta.page === "object" ? (meta.page as TemplateMeta["page"]) : undefined;

    return {
        id,
        name,
        description,
        documentTypes,
        supports,
        renderKind,
        source,
        styles,
        page,
        dir,
        origin,
    };
}

function scanDir(root: string, origin: "bundled" | "store"): void {
    if (!fs.existsSync(root)) return;
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(root, entry.name);
        try {
            const tpl = parseTemplate(full, origin);
            if (tpl) {
                if (registry.has(tpl.id)) {
                    console.warn(
                        `[templates] Duplicate template id "${tpl.id}" — keeping first (${registry.get(tpl.id)?.origin})`,
                    );
                    continue;
                }
                registry.set(tpl.id, tpl);
            }
        } catch (err) {
            console.warn(`[templates] Skipped ${full}: ${(err as Error).message}`);
        }
    }
}

export function loadTemplates(force = false): void {
    if (loaded && !force) return;
    registry.clear();
    scanDir(bundledDir(), "bundled");
    scanDir(storeDir(), "store");
    loaded = true;
    console.log(`📄 Templates: ${registry.size} loaded (bundled + store)`);
}

export function reloadTemplates(): void {
    loaded = false;
    loadTemplates(true);
}

export function getTemplate(id: string): TemplateMeta | null {
    if (!loaded) loadTemplates();
    return registry.get(id) ?? null;
}

export interface TemplateFilter {
    type?: DocumentType;
    format?: TemplateFormat;
    origin?: "bundled" | "store";
}

export function listTemplatesRaw(filter: TemplateFilter = {}): TemplateMeta[] {
    if (!loaded) loadTemplates();
    return Array.from(registry.values()).filter((t) => {
        if (filter.type && !t.documentTypes.includes(filter.type)) return false;
        if (filter.format && !t.supports.includes(filter.format)) return false;
        if (filter.origin && t.origin !== filter.origin) return false;
        return true;
    });
}

/** Pick a sensible default template for a given type+format. */
export function pickDefaultTemplate(type: DocumentType, format: TemplateFormat): TemplateMeta | null {
    const matches = listTemplatesRaw({ type, format });
    if (matches.length === 0) {
        // Fall back to generic template for the format
        const generic = listTemplatesRaw({ type: "generic", format });
        return generic[0] ?? null;
    }
    // Prefer bundled over store for defaults (stability).
    const bundled = matches.find((t) => t.origin === "bundled");
    return bundled ?? matches[0];
}

export function readTemplateSource(tpl: TemplateMeta): string {
    const p = path.join(tpl.dir, tpl.source);
    return fs.readFileSync(p, "utf-8");
}

export function readTemplateStyles(tpl: TemplateMeta): string | null {
    if (!tpl.styles) return null;
    const p = path.join(tpl.dir, tpl.styles);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf-8");
}

export function readTemplateBinary(tpl: TemplateMeta): Buffer {
    const p = path.join(tpl.dir, tpl.source);
    return fs.readFileSync(p);
}
