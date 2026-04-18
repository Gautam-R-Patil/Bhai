// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Document store ──────────────────────────────
// One JSON file per document under data/documents/<id>.json.
// Stays local; Convex-side syncing is out of scope for v1.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../config/paths.js";
import { type DocumentType, type StoredDocument, StoredDocumentSchema } from "./schema.js";

function getDocumentsDataDir(): string {
    const dir = path.join(getDataDir(), "documents");
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function documentPath(id: string): string {
    return path.join(getDocumentsDataDir(), `${id}.json`);
}

function slugify(name: string): string {
    return (
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "doc"
    );
}

function uniqueId(name: string): string {
    const base = slugify(name);
    const suffix = crypto.randomBytes(3).toString("hex");
    return `${base}-${suffix}`;
}

export interface SaveOptions {
    id?: string;
}

export function saveDocument(
    doc: Omit<StoredDocument, "id" | "createdAt" | "updatedAt"> & SaveOptions,
): StoredDocument {
    const now = Date.now();
    const id = doc.id ?? uniqueId(doc.name);
    const existing = fs.existsSync(documentPath(id)) ? loadDocument(id) : null;
    const full: StoredDocument = {
        id,
        name: doc.name,
        type: doc.type,
        templateId: doc.templateId,
        data: doc.data,
        tags: doc.tags,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    };
    const validated = StoredDocumentSchema.parse(full);
    fs.writeFileSync(documentPath(id), JSON.stringify(validated, null, 2), "utf-8");
    return validated;
}

export function loadDocument(id: string): StoredDocument {
    const p = documentPath(id);
    if (!fs.existsSync(p)) {
        throw new Error(`Document not found: ${id}`);
    }
    const raw = fs.readFileSync(p, "utf-8");
    return StoredDocumentSchema.parse(JSON.parse(raw));
}

export function tryLoadDocument(id: string): StoredDocument | null {
    try {
        return loadDocument(id);
    } catch {
        return null;
    }
}

export interface ListFilter {
    type?: DocumentType;
    query?: string;
}

export function listDocuments(filter: ListFilter = {}): StoredDocument[] {
    const dir = getDocumentsDataDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const docs: StoredDocument[] = [];
    for (const file of files) {
        try {
            const raw = fs.readFileSync(path.join(dir, file), "utf-8");
            const doc = StoredDocumentSchema.parse(JSON.parse(raw));
            if (filter.type && doc.type !== filter.type) continue;
            if (filter.query) {
                const q = filter.query.toLowerCase();
                if (!doc.name.toLowerCase().includes(q) && doc.id !== filter.query) continue;
            }
            docs.push(doc);
        } catch {
            // skip malformed
        }
    }
    docs.sort((a, b) => b.updatedAt - a.updatedAt);
    return docs;
}

export function findDocumentByName(name: string, type?: DocumentType): StoredDocument | null {
    const docs = listDocuments({ type });
    const lower = name.toLowerCase();
    return docs.find((d) => d.name.toLowerCase() === lower) ?? null;
}

/** Returns documents matching id OR exact name OR fuzzy name substring. */
export function resolveDocument(idOrName: string, type?: DocumentType): StoredDocument | null {
    const byId = tryLoadDocument(idOrName);
    if (byId && (!type || byId.type === type)) return byId;
    const byName = findDocumentByName(idOrName, type);
    if (byName) return byName;
    const fuzzy = listDocuments({ type, query: idOrName });
    return fuzzy[0] ?? null;
}

export function deleteDocument(id: string): boolean {
    const p = documentPath(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
}
