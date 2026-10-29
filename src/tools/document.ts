// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Document tools ──────────────────────────────
// High-level tool surface for creating, editing, ingesting, and exporting
// structured documents — resumes (JSON Resume schema), cover letters, reports.
// All PDFs are round-tripped through structured JSON; raw in-place PDF edits
// are intentionally not supported (layout-fragile, not industry-standard).

import { ingestPdfToDocument } from "../documents/ingest.js";
import { renderDocument } from "../documents/render.js";
import {
    applyMergePatch,
    type DocumentType,
    DocumentTypeSchema,
    type GeneralDocument,
    GeneralDocumentSchema,
    type Resume,
    ResumeSchema,
    type StoredDocument,
} from "../documents/schema.js";
import { deleteDocument, listDocuments, loadDocument, resolveDocument, saveDocument } from "../documents/store.js";
import {
    getTemplate,
    listTemplatesRaw,
    loadTemplates,
    pickDefaultTemplate,
    reloadTemplates,
    type TemplateFormat,
} from "../documents/templates.js";
import { registerTemplatesReloader } from "../store/hot-reload.js";
import type { ToolDefinition } from "./get-current-time.js";

function parseDocTypeLoose(v: unknown): DocumentType {
    const s = typeof v === "string" ? v : "generic";
    const parsed = DocumentTypeSchema.safeParse(s);
    return parsed.success ? parsed.data : "generic";
}

function validateDataForType(type: DocumentType, data: unknown): Resume | GeneralDocument {
    if (type === "resume") {
        return ResumeSchema.parse(data);
    }
    return GeneralDocumentSchema.parse(data);
}

function docSummary(doc: StoredDocument) {
    return {
        id: doc.id,
        name: doc.name,
        type: doc.type,
        templateId: doc.templateId,
        createdAt: new Date(doc.createdAt).toISOString(),
        updatedAt: new Date(doc.updatedAt).toISOString(),
    };
}

// ── create_document ────────────────────────────

export const createDocumentTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "create_document",
            description:
                "Create a structured document (resume, cover letter, report, letter, invoice, or generic). For resumes, pass data following the JSON Resume schema (basics, work, education, skills, projects, etc). For other types, pass data with {title, subtitle?, author?, date?, recipient?, blocks: [{type, ...}]}. Supported block types: heading, paragraph, list, table, image, divider, spacer, markdown. Returns the document id for later updates or exports. After creating, the agent typically calls export_document next.",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description:
                            "Human-friendly name for the document (e.g. 'Dheeraj — Software Engineer', 'Cover Letter — Acme Corp').",
                    },
                    type: {
                        type: "string",
                        enum: ["resume", "cover_letter", "report", "letter", "invoice", "generic"],
                        description:
                            "Document type. Determines which templates are available and what schema `data` follows.",
                    },
                    data: {
                        type: "object",
                        description:
                            "The document content. For 'resume': JSON Resume schema. For others: {title, subtitle?, author?, date?, recipient?, blocks: [...]}.",
                    },
                    templateId: {
                        type: "string",
                        description:
                            "Optional: template id to associate with the document. Call list_templates to see available options. If omitted, a sensible default is chosen at export time.",
                    },
                    tags: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional tags for organization.",
                    },
                },
                required: ["name", "type", "data"],
            },
        },
    },
    async handler(input) {
        try {
            const name = String(input.name ?? "").trim();
            const type = parseDocTypeLoose(input.type);
            const data = validateDataForType(type, input.data);
            const templateId = typeof input.templateId === "string" ? input.templateId : undefined;
            const tags = Array.isArray(input.tags)
                ? input.tags.filter((t): t is string => typeof t === "string")
                : undefined;

            if (!name) {
                return JSON.stringify({ error: "`name` is required." });
            }

            const doc = saveDocument({ name, type, data, templateId, tags });
            return JSON.stringify({
                success: true,
                document: docSummary(doc),
                hint: "Call export_document to render it as PDF or DOCX and send_file to deliver.",
            });
        } catch (err) {
            return JSON.stringify({ error: `create_document failed: ${(err as Error).message}` });
        }
    },
};

// ── update_document ────────────────────────────

export const updateDocumentTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "update_document",
            description:
                "Update fields of an existing document via JSON-merge-patch. `null` values in the patch delete keys. For resumes, to add a new work entry, use append_work. To add a new block to a general document, use append_block. Returns the updated document summary.",
            parameters: {
                type: "object",
                properties: {
                    documentId: { type: "string", description: "Document id or name." },
                    patch: {
                        type: "object",
                        description:
                            "Partial data to merge into the document's `data` field (RFC 7396 style). Unspecified fields are preserved; null removes fields.",
                    },
                    rename: { type: "string", description: "Optional new display name." },
                    templateId: { type: "string", description: "Optional: change the associated template." },
                },
                required: ["documentId", "patch"],
            },
        },
    },
    async handler(input) {
        try {
            const id = String(input.documentId ?? "").trim();
            const patch = input.patch;
            if (!id) return JSON.stringify({ error: "`documentId` is required." });

            const existing = resolveDocument(id);
            if (!existing) return JSON.stringify({ error: `Document not found: ${id}` });

            const merged = applyMergePatch(existing.data, patch);
            const validated = validateDataForType(existing.type, merged);

            const saved = saveDocument({
                id: existing.id,
                name: typeof input.rename === "string" ? input.rename : existing.name,
                type: existing.type,
                templateId: typeof input.templateId === "string" ? input.templateId : existing.templateId,
                data: validated,
                tags: existing.tags,
            });
            return JSON.stringify({ success: true, document: docSummary(saved) });
        } catch (err) {
            return JSON.stringify({ error: `update_document failed: ${(err as Error).message}` });
        }
    },
};

// ── append_work (resume convenience) ───────────

export const appendResumeWorkTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "append_resume_work",
            description:
                "Append a work experience entry to a resume. Convenience tool — equivalent to update_document with a patch that pushes onto `work[]`. Use for 'add this job' requests.",
            parameters: {
                type: "object",
                properties: {
                    documentId: { type: "string" },
                    entry: {
                        type: "object",
                        description:
                            "JSON Resume work entry. Fields: name (company), position, url, startDate (YYYY-MM-DD), endDate (YYYY-MM-DD or omit for current), summary, highlights[], location.",
                    },
                    position: {
                        type: "string",
                        enum: ["start", "end"],
                        description:
                            "Insert at start (most recent) or end. Defaults to 'start' since resumes are reverse-chronological.",
                    },
                },
                required: ["documentId", "entry"],
            },
        },
    },
    async handler(input) {
        try {
            const id = String(input.documentId ?? "").trim();
            const entry = input.entry;
            const pos = input.position === "end" ? "end" : "start";
            if (!id) return JSON.stringify({ error: "`documentId` is required." });
            if (!entry || typeof entry !== "object") {
                return JSON.stringify({ error: "`entry` must be an object." });
            }
            const doc = resolveDocument(id, "resume");
            if (!doc) return JSON.stringify({ error: `Resume not found: ${id}` });

            const resume = doc.data as Resume;
            const work = Array.isArray(resume.work) ? [...resume.work] : [];
            if (pos === "start") work.unshift(entry as Resume["work"] extends (infer U)[] | undefined ? U : never);
            else work.push(entry as Resume["work"] extends (infer U)[] | undefined ? U : never);

            const updated = ResumeSchema.parse({ ...resume, work });
            const saved = saveDocument({
                id: doc.id,
                name: doc.name,
                type: doc.type,
                templateId: doc.templateId,
                data: updated,
                tags: doc.tags,
            });
            return JSON.stringify({
                success: true,
                document: docSummary(saved),
                workCount: updated.work?.length ?? 0,
            });
        } catch (err) {
            return JSON.stringify({ error: `append_resume_work failed: ${(err as Error).message}` });
        }
    },
};

// ── list_documents ─────────────────────────────

export const listDocumentsTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "list_documents",
            description: "List stored documents, optionally filtered by type or name substring.",
            parameters: {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        enum: ["resume", "cover_letter", "report", "letter", "invoice", "generic"],
                    },
                    query: { type: "string" },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const type =
                typeof input.type === "string"
                    ? (DocumentTypeSchema.safeParse(input.type).data ?? undefined)
                    : undefined;
            const query = typeof input.query === "string" ? input.query : undefined;
            const docs = listDocuments({ type, query });
            return JSON.stringify({
                count: docs.length,
                documents: docs.map(docSummary),
            });
        } catch (err) {
            return JSON.stringify({ error: `list_documents failed: ${(err as Error).message}` });
        }
    },
};

// ── load_document ──────────────────────────────

export const loadDocumentTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "load_document",
            description: "Load the full content (data + metadata) of a stored document by id or name.",
            parameters: {
                type: "object",
                properties: {
                    documentId: { type: "string" },
                },
                required: ["documentId"],
            },
        },
    },
    async handler(input) {
        try {
            const id = String(input.documentId ?? "").trim();
            if (!id) return JSON.stringify({ error: "`documentId` is required." });
            const doc =
                resolveDocument(id) ??
                (() => {
                    try {
                        return loadDocument(id);
                    } catch {
                        return null;
                    }
                })();
            if (!doc) return JSON.stringify({ error: `Document not found: ${id}` });
            return JSON.stringify({
                ...docSummary(doc),
                data: doc.data,
                tags: doc.tags,
            });
        } catch (err) {
            return JSON.stringify({ error: `load_document failed: ${(err as Error).message}` });
        }
    },
};

// ── delete_document ────────────────────────────

export const deleteDocumentTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "delete_document",
            description: "Delete a stored document permanently.",
            parameters: {
                type: "object",
                properties: {
                    documentId: { type: "string" },
                },
                required: ["documentId"],
            },
        },
    },
    async handler(input) {
        try {
            const id = String(input.documentId ?? "").trim();
            if (!id) return JSON.stringify({ error: "`documentId` is required." });
            const doc = resolveDocument(id);
            if (!doc) return JSON.stringify({ error: `Document not found: ${id}` });
            const ok = deleteDocument(doc.id);
            return JSON.stringify({ success: ok, deleted: doc.id });
        } catch (err) {
            return JSON.stringify({ error: `delete_document failed: ${(err as Error).message}` });
        }
    },
};

// ── export_document ────────────────────────────

export const exportDocumentTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "export_document",
            description:
                "Render a stored document to a PDF or DOCX file on disk. Returns the absolute path — call send_file afterwards to deliver it to the user. If no templateId is specified, a sensible default is chosen based on the document type.",
            parameters: {
                type: "object",
                properties: {
                    documentId: { type: "string" },
                    format: {
                        type: "string",
                        enum: ["pdf", "docx"],
                        description: "Output format. Defaults to 'pdf'.",
                    },
                    templateId: {
                        type: "string",
                        description:
                            "Optional: template id override for this export only (does not change the stored default).",
                    },
                },
                required: ["documentId"],
            },
        },
    },
    async handler(input) {
        try {
            const id = String(input.documentId ?? "").trim();
            if (!id) return JSON.stringify({ error: "`documentId` is required." });
            const format = (input.format === "docx" ? "docx" : "pdf") as TemplateFormat;
            const templateId = typeof input.templateId === "string" ? input.templateId : undefined;

            const doc = resolveDocument(id);
            if (!doc) return JSON.stringify({ error: `Document not found: ${id}` });

            const result = await renderDocument(doc, format, templateId);
            return JSON.stringify({
                success: true,
                path: result.path,
                format: result.format,
                templateId: result.templateId,
                size_kb: Math.round(result.sizeBytes / 1024),
                hint: "Call send_file with this path to deliver it to the user.",
            });
        } catch (err) {
            return JSON.stringify({ error: `export_document failed: ${(err as Error).message}` });
        }
    },
};

// ── list_templates ─────────────────────────────

export const listTemplatesTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "list_templates",
            description:
                "List available document templates, optionally filtered by type and/or output format. Returns both bundled (built-in) and store-installed templates.",
            parameters: {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        enum: ["resume", "cover_letter", "report", "letter", "invoice", "generic"],
                    },
                    format: { type: "string", enum: ["pdf", "docx"] },
                    origin: { type: "string", enum: ["bundled", "store"] },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            loadTemplates();
            const type =
                typeof input.type === "string"
                    ? (DocumentTypeSchema.safeParse(input.type).data ?? undefined)
                    : undefined;
            const format =
                input.format === "pdf" || input.format === "docx" ? (input.format as TemplateFormat) : undefined;
            const origin =
                input.origin === "bundled" || input.origin === "store"
                    ? (input.origin as "bundled" | "store")
                    : undefined;

            const tpls = listTemplatesRaw({ type, format, origin });
            return JSON.stringify({
                count: tpls.length,
                templates: tpls.map((t) => ({
                    id: t.id,
                    name: t.name,
                    description: t.description,
                    documentTypes: t.documentTypes,
                    supports: t.supports,
                    origin: t.origin,
                })),
            });
        } catch (err) {
            return JSON.stringify({ error: `list_templates failed: ${(err as Error).message}` });
        }
    },
};

// ── set_document_template ──────────────────────

export const setDocumentTemplateTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "set_document_template",
            description:
                "Change the default template associated with a document. Does not re-render — call export_document after to get a new PDF.",
            parameters: {
                type: "object",
                properties: {
                    documentId: { type: "string" },
                    templateId: { type: "string" },
                },
                required: ["documentId", "templateId"],
            },
        },
    },
    async handler(input) {
        try {
            const id = String(input.documentId ?? "").trim();
            const templateId = String(input.templateId ?? "").trim();
            if (!id || !templateId) {
                return JSON.stringify({ error: "`documentId` and `templateId` are required." });
            }
            const doc = resolveDocument(id);
            if (!doc) return JSON.stringify({ error: `Document not found: ${id}` });
            const tpl = getTemplate(templateId);
            if (!tpl) return JSON.stringify({ error: `Template not found: ${templateId}` });
            if (!tpl.documentTypes.includes(doc.type)) {
                return JSON.stringify({
                    error: `Template "${templateId}" does not support document type "${doc.type}" (supports: ${tpl.documentTypes.join(",")}).`,
                });
            }
            const saved = saveDocument({
                id: doc.id,
                name: doc.name,
                type: doc.type,
                templateId,
                data: doc.data,
                tags: doc.tags,
            });
            return JSON.stringify({ success: true, document: docSummary(saved) });
        } catch (err) {
            return JSON.stringify({ error: `set_document_template failed: ${(err as Error).message}` });
        }
    },
};

// ── ingest_pdf_document ────────────────────────

export const ingestPdfDocumentTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "ingest_pdf_document",
            description:
                "Parse an existing PDF (e.g. a resume the user uploaded) into structured JSON and store it as an editable document. Returns the new document id. Uses text extraction first; falls back to vision-LLM extraction for multi-column or image-heavy PDFs. Always call this before trying to 'edit' a user-supplied PDF — there is no way to edit PDF text in-place reliably.",
            parameters: {
                type: "object",
                properties: {
                    filePath: { type: "string", description: "Absolute path to the PDF file on disk." },
                    type: {
                        type: "string",
                        enum: ["resume", "cover_letter", "report", "generic"],
                        description: "What kind of document this PDF is. Defaults to 'resume'.",
                    },
                    name: { type: "string", description: "Optional display name for the stored document." },
                },
                required: ["filePath"],
            },
        },
    },
    async handler(input) {
        try {
            const filePath = String(input.filePath ?? "").trim();
            if (!filePath) return JSON.stringify({ error: "`filePath` is required." });
            const type = parseDocTypeLoose(input.type ?? "resume");
            const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : undefined;

            const result = await ingestPdfToDocument(filePath, type, name);
            return JSON.stringify({
                success: true,
                document: docSummary(result.doc),
                confidence: result.confidence,
                method: result.method,
                warnings: result.warnings,
                hint:
                    result.confidence < 0.6
                        ? "Low extraction confidence — ask the user to verify the parsed data (call load_document) before making edits."
                        : undefined,
            });
        } catch (err) {
            return JSON.stringify({ error: `ingest_pdf_document failed: ${(err as Error).message}` });
        }
    },
};

// ── Exports ────────────────────────────────────

export const documentTools: ToolDefinition[] = [
    createDocumentTool,
    updateDocumentTool,
    appendResumeWorkTool,
    listDocumentsTool,
    loadDocumentTool,
    deleteDocumentTool,
    exportDocumentTool,
    listTemplatesTool,
    setDocumentTemplateTool,
    ingestPdfDocumentTool,
];

/** Pre-load the template registry at boot so embeddings / list_templates are instant. */
export function initDocumentTools(): void {
    try {
        loadTemplates();
        // Pre-compute default templates for each type (warm path selection).
        for (const t of ["resume", "cover_letter", "report", "letter", "generic"] as DocumentType[]) {
            pickDefaultTemplate(t, "pdf");
        }
        // Register with hot-reload so store-installed templates get picked up.
        registerTemplatesReloader(() => reloadTemplates());
    } catch (err) {
        console.warn(`[documents] Init warning: ${(err as Error).message}`);
    }
}
