// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Document Schemas ────────────────────────────
// Canonical document shapes for Bhai. JSON Resume schema for CVs
// (https://jsonresume.org) plus a lightweight GeneralDocument schema for
// everything else (cover letters, reports, letters, invoices).

import { z } from "zod";

// ── JSON Resume Schema ──────────────────────────
// Subset of https://github.com/jsonresume/resume-schema
// Permissive: unknown fields pass through so themes that consume extra keys
// (like jsonresume-theme-even) keep working.

export const ResumeBasicsLocationSchema = z
    .object({
        address: z.string().optional(),
        postalCode: z.string().optional(),
        city: z.string().optional(),
        countryCode: z.string().optional(),
        region: z.string().optional(),
    })
    .passthrough();

export const ResumeProfileSchema = z
    .object({
        network: z.string().optional(),
        username: z.string().optional(),
        url: z.string().optional(),
    })
    .passthrough();

export const ResumeBasicsSchema = z
    .object({
        name: z.string().optional(),
        label: z.string().optional(),
        image: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        url: z.string().optional(),
        summary: z.string().optional(),
        location: ResumeBasicsLocationSchema.optional(),
        profiles: z.array(ResumeProfileSchema).optional(),
    })
    .passthrough();

export const ResumeWorkSchema = z
    .object({
        name: z.string().optional(),
        position: z.string().optional(),
        url: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        summary: z.string().optional(),
        highlights: z.array(z.string()).optional(),
        location: z.string().optional(),
    })
    .passthrough();

export const ResumeEducationSchema = z
    .object({
        institution: z.string().optional(),
        url: z.string().optional(),
        area: z.string().optional(),
        studyType: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        score: z.string().optional(),
        courses: z.array(z.string()).optional(),
    })
    .passthrough();

export const ResumeSkillSchema = z
    .object({
        name: z.string().optional(),
        level: z.string().optional(),
        keywords: z.array(z.string()).optional(),
    })
    .passthrough();

export const ResumeProjectSchema = z
    .object({
        name: z.string().optional(),
        description: z.string().optional(),
        highlights: z.array(z.string()).optional(),
        keywords: z.array(z.string()).optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        url: z.string().optional(),
        roles: z.array(z.string()).optional(),
        entity: z.string().optional(),
        type: z.string().optional(),
    })
    .passthrough();

export const ResumeAwardSchema = z
    .object({
        title: z.string().optional(),
        date: z.string().optional(),
        awarder: z.string().optional(),
        summary: z.string().optional(),
    })
    .passthrough();

export const ResumeLanguageSchema = z
    .object({
        language: z.string().optional(),
        fluency: z.string().optional(),
    })
    .passthrough();

export const ResumeInterestSchema = z
    .object({
        name: z.string().optional(),
        keywords: z.array(z.string()).optional(),
    })
    .passthrough();

export const ResumeReferenceSchema = z
    .object({
        name: z.string().optional(),
        reference: z.string().optional(),
    })
    .passthrough();

export const ResumeVolunteerSchema = z
    .object({
        organization: z.string().optional(),
        position: z.string().optional(),
        url: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        summary: z.string().optional(),
        highlights: z.array(z.string()).optional(),
    })
    .passthrough();

export const ResumeSchema = z
    .object({
        basics: ResumeBasicsSchema.optional(),
        work: z.array(ResumeWorkSchema).optional(),
        volunteer: z.array(ResumeVolunteerSchema).optional(),
        education: z.array(ResumeEducationSchema).optional(),
        awards: z.array(ResumeAwardSchema).optional(),
        skills: z.array(ResumeSkillSchema).optional(),
        languages: z.array(ResumeLanguageSchema).optional(),
        interests: z.array(ResumeInterestSchema).optional(),
        references: z.array(ResumeReferenceSchema).optional(),
        projects: z.array(ResumeProjectSchema).optional(),
    })
    .passthrough();

export type Resume = z.infer<typeof ResumeSchema>;

// ── General Document Schema ─────────────────────
// Used for cover letters, reports, letters, invoices, etc.
// Block-based so templates can map blocks to layout primitives.

export const DocumentBlockSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("heading"),
        level: z.number().int().min(1).max(6).default(1),
        text: z.string(),
    }),
    z.object({
        type: z.literal("paragraph"),
        text: z.string(),
    }),
    z.object({
        type: z.literal("list"),
        ordered: z.boolean().default(false),
        items: z.array(z.string()),
    }),
    z.object({
        type: z.literal("table"),
        headers: z.array(z.string()).optional(),
        rows: z.array(z.array(z.string())),
    }),
    z.object({
        type: z.literal("image"),
        src: z.string(),
        alt: z.string().optional(),
        widthPct: z.number().optional(),
    }),
    z.object({
        type: z.literal("divider"),
    }),
    z.object({
        type: z.literal("spacer"),
        heightPt: z.number().default(12),
    }),
    z.object({
        type: z.literal("markdown"),
        text: z.string(),
    }),
]);

export type DocumentBlock = z.infer<typeof DocumentBlockSchema>;

export const GeneralDocumentSchema = z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    author: z.string().optional(),
    date: z.string().optional(),
    recipient: z
        .object({
            name: z.string().optional(),
            title: z.string().optional(),
            company: z.string().optional(),
            address: z.string().optional(),
        })
        .optional(),
    blocks: z.array(DocumentBlockSchema),
    metadata: z.record(z.string(), z.unknown()).optional(),
});

export type GeneralDocument = z.infer<typeof GeneralDocumentSchema>;

// ── Canonical Stored Document ───────────────────

export const DocumentTypeSchema = z.enum(["resume", "cover_letter", "report", "letter", "invoice", "generic"]);

export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const StoredDocumentSchema = z.object({
    id: z.string(),
    name: z.string(),
    type: DocumentTypeSchema,
    templateId: z.string().optional(),
    data: z.union([ResumeSchema, GeneralDocumentSchema]),
    createdAt: z.number(),
    updatedAt: z.number(),
    tags: z.array(z.string()).optional(),
});

export type StoredDocument = z.infer<typeof StoredDocumentSchema>;

/** Deep-merge patch (RFC 7396 JSON Merge Patch-ish). `null` removes a key. */
export function applyMergePatch<T>(target: T, patch: unknown): T {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        return patch as T;
    }
    const out: Record<string, unknown> =
        target && typeof target === "object" && !Array.isArray(target)
            ? { ...(target as Record<string, unknown>) }
            : {};
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
        if (value === null) {
            delete out[key];
        } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            out[key] = applyMergePatch(out[key], value);
        } else {
            out[key] = value;
        }
    }
    return out as T;
}
