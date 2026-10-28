// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── PDF → structured-document ingestion ──────────
// Two-tier approach:
//   1. Text extraction via `unpdf` (50MB cap, 60s parse deadline).
//      Heuristic parse: regex-driven section split for resumes.
//   2. Low confidence? Send raw text (+ first 1-2 page screenshots in a
//      future iteration) to an LLM and ask it to emit JSON Resume. Requires
//      an injected LLMClient (set by boot).

import { fork } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveScript } from "../config/paths.js";
import type { LLMClient } from "../llm.js";
import { MODELS } from "../llm.js";
import { extractJSON } from "../utils/json-extract.js";
import {
    type DocumentType,
    type GeneralDocument,
    GeneralDocumentSchema,
    type Resume,
    ResumeSchema,
    type StoredDocument,
} from "./schema.js";
import { saveDocument } from "./store.js";

// ── LLM injection ───────────────────────────────
let llm: LLMClient | null = null;

export function setIngestLLM(client: LLMClient): void {
    llm = client;
}

// ── Cache for identical inputs (keyed by SHA-256) ─
const extractionCache = new Map<string, { resume?: Resume; general?: GeneralDocument; confidence: number }>();

// ── Tier 1: text extraction ─────────────────────

// Attachments arrive from any channel: cap the input size, read only regular
// files, and parse in a child process (scripts/pdf-text.cjs) that is killed at
// the deadline and kills itself past 1GB, so a decompression bomb or a parse
// that never ends costs that child, never the bot.
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const PARSE_DEADLINE_MS = 60_000;

// A FIFO or device (named directly or through a symlink) would block the read
// or never end. fstat checks the file actually opened, in case the path changed.
function readPdf(filePath: string): Buffer {
    const notRegular = () => new Error(`Not a regular file: ${path.basename(filePath)}`);
    if (!fs.statSync(filePath).isFile()) throw notRegular();
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) throw notRegular();
        if (st.size > MAX_PDF_BYTES) {
            throw new Error(
                `PDF is too large (${(st.size / 1024 / 1024).toFixed(1)}MB). The limit is ${MAX_PDF_BYTES / 1024 / 1024}MB.`,
            );
        }
        return fs.readFileSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

function extractText(data: Buffer): Promise<string> {
    // unpdf ships a current pdf.js; the old pdf-parse fallback (pdf.js 2018) never
    // rescued a PDF the modern parser rejected, so it was dropped.
    const script = resolveScript("pdf-text.cjs");
    if (!script) return Promise.reject(new Error("The PDF reader (scripts/pdf-text.cjs) is missing."));
    const envMs = Number(process.env.ATLAS_PDF_PARSE_DEADLINE_MS); // tests only; "" or "60s" must not mean 0
    const ms = Number.isFinite(envMs) && envMs > 0 ? envMs : PARSE_DEADLINE_MS;
    const child = fork(script, [], {
        execPath: process.execPath,
        execArgv: ["--max-old-space-size=512"],
        env: { ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH ?? "" },
        serialization: "advanced", // the PDF bytes go over as a Uint8Array, not JSON
        stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err: Error | null, text = "") => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.kill("SIGKILL");
            if (err) reject(err);
            else resolve(text);
        };
        const timer = setTimeout(
            () => finish(new Error(`PDF parsing took longer than ${ms / 1000}s and was stopped.`)),
            ms,
        );
        child.on("message", (m: { ok?: boolean; text?: unknown; error?: unknown }) =>
            m?.ok && typeof m.text === "string"
                ? finish(null, m.text)
                : finish(new Error(`Could not read the PDF: ${String(m?.error ?? "no text")}`)),
        );
        child.on("exit", () => finish(new Error("PDF parsing stopped: the parser ran out of memory or crashed.")));
        child.on("error", (e) => finish(new Error(`PDF parsing failed: ${e.message}`)));
        child.send({ data });
    });
}

// ── Heuristic resume parser ─────────────────────

const SECTION_HEADERS: Record<string, string> = {
    experience: "work",
    "work experience": "work",
    "professional experience": "work",
    employment: "work",
    education: "education",
    skills: "skills",
    "technical skills": "skills",
    projects: "projects",
    awards: "awards",
    honors: "awards",
    languages: "languages",
    interests: "interests",
    summary: "summary",
    profile: "summary",
    objective: "summary",
};

function findSections(text: string): Map<string, string> {
    const lines = text.split(/\r?\n/);
    const sections = new Map<string, string>();
    let current = "header";
    let buffer: string[] = [];
    for (const line of lines) {
        const norm = line
            .trim()
            .toLowerCase()
            .replace(/[:·•\-—]+$/, "")
            .trim();
        if (norm && norm.length < 50 && SECTION_HEADERS[norm]) {
            sections.set(current, buffer.join("\n"));
            current = SECTION_HEADERS[norm];
            buffer = [];
            continue;
        }
        buffer.push(line);
    }
    sections.set(current, buffer.join("\n"));
    return sections;
}

function parseHeader(headerText: string, full: string): NonNullable<Resume["basics"]> {
    const emailMatch = full.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    const phoneMatch = full.match(/(\+?\d[\d\s\-().]{7,}\d)/);
    const urlMatch = full.match(/(https?:\/\/[^\s]+|[\w.-]+\.(?:com|io|dev|net|org|ai|co|me)[\w/.-]*)/i);
    // First non-empty line is usually the name.
    const firstLine =
        headerText
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find((l) => l.length > 0 && l.length < 80 && !/[@:]/.test(l)) ?? undefined;
    return {
        name: firstLine,
        email: emailMatch?.[0],
        phone: phoneMatch?.[0]?.trim(),
        url: urlMatch?.[0],
    };
}

function parseBullets(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((l) => l.replace(/^[\s•\-*·]+/, "").trim())
        .filter((l) => l.length > 0 && l.length < 400);
}

function splitWorkEntries(workText: string): NonNullable<Resume["work"]> {
    // Split by blank lines as the simplest heuristic.
    const blocks = workText.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
    const entries: NonNullable<Resume["work"]> = [];
    for (const block of blocks) {
        const lines = block
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
        if (lines.length === 0) continue;
        const first = lines[0];
        const dateMatch = first.match(
            /(\d{4}[-/]\d{1,2}[-/]?\d{0,2}|[A-Z][a-z]+ \d{4})\s*(?:–|-|to)\s*(\w+ \d{4}|\d{4}|Present|Current)/i,
        );
        let startDate: string | undefined;
        let endDate: string | undefined;
        if (dateMatch) {
            startDate = dateMatch[1];
            endDate = /present|current/i.test(dateMatch[2] ?? "") ? undefined : dateMatch[2];
        }
        const position = first.split(/ at | @ | - | — /)[0]?.trim();
        const name = first.split(/ at | @ | - | — /)[1]?.trim();
        const highlights = parseBullets(lines.slice(1).join("\n")).slice(0, 8);
        entries.push({
            position: position,
            name: name,
            startDate,
            endDate,
            highlights,
        });
    }
    return entries;
}

function parseResumeHeuristic(text: string): { resume: Resume; confidence: number; warnings: string[] } {
    const warnings: string[] = [];
    const sections = findSections(text);

    const basics = parseHeader(sections.get("header") ?? "", text);
    const summaryText = (sections.get("summary") ?? "").trim();
    if (summaryText) basics.summary = summaryText;

    const work = sections.has("work") ? splitWorkEntries(sections.get("work") ?? "") : [];
    const education = sections.has("education")
        ? splitWorkEntries(sections.get("education") ?? "").map((e) => ({
              institution: e.name ?? e.position,
              startDate: e.startDate,
              endDate: e.endDate,
          }))
        : [];
    const skillsText = (sections.get("skills") ?? "").trim();
    const skills = skillsText
        ? skillsText
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(0, 20)
              .map((line) => {
                  const colon = line.indexOf(":");
                  if (colon > 0) {
                      return {
                          name: line.slice(0, colon).trim(),
                          keywords: line
                              .slice(colon + 1)
                              .split(/[,;]/)
                              .map((k) => k.trim())
                              .filter(Boolean),
                      };
                  }
                  return { name: line, keywords: [] };
              })
        : [];

    // Confidence score: text length, presence of email/phone, sections found.
    let confidence = 0.2;
    if (basics.name) confidence += 0.15;
    if (basics.email) confidence += 0.1;
    if (basics.phone) confidence += 0.05;
    if (work.length > 0) confidence += 0.25;
    if (education.length > 0) confidence += 0.1;
    if (skills.length > 0) confidence += 0.1;
    if (text.length < 400) {
        confidence -= 0.2;
        warnings.push("Short text — PDF may be image-based or highly structured.");
    }
    confidence = Math.max(0, Math.min(1, confidence));

    const resume: Resume = {
        basics,
        work,
        education,
        skills,
    };

    return { resume, confidence, warnings };
}

// ── Tier 2: LLM extraction ──────────────────────

const LLM_SYSTEM_PROMPT = `You are a precise resume parser. Convert the given raw resume text into a JSON Resume document (https://jsonresume.org).

Rules:
- Return ONLY valid JSON, wrapped in a single fenced code block: \`\`\`json ... \`\`\`.
- Use these top-level keys: basics, work, volunteer, education, awards, skills, languages, interests, references, projects.
- basics = {name, label, email, phone, url, summary, location: {city, region, countryCode}, profiles: [{network, username, url}]}.
- work[i] = {name (company), position, url, startDate (YYYY-MM or YYYY-MM-DD), endDate (omit if current), summary, highlights: [...]}.
- education[i] = {institution, area, studyType, startDate, endDate, score}.
- skills[i] = {name, keywords: [...]}. Group by skill domain.
- Do NOT fabricate information. If a field is not present in the text, omit it.
- Prefer bullet-style highlights over a prose summary for work entries.`;

async function llmExtractResume(text: string): Promise<{ resume: Resume; confidence: number } | null> {
    if (!llm) return null;
    try {
        const res = await llm.chat({
            messages: [
                { role: "user", content: `Parse this resume text into JSON Resume format:\n\n${text.slice(0, 12000)}` },
            ],
            systemPrompt: LLM_SYSTEM_PROMPT,
            modelOverride: MODELS.SONNET,
        });
        const content = res.choices?.[0]?.message?.content ?? "";
        const json = extractJSON(typeof content === "string" ? content : String(content));
        if (!json) return null;
        const parsed = ResumeSchema.safeParse(json);
        if (!parsed.success) return null;
        return { resume: parsed.data, confidence: 0.85 };
    } catch (err) {
        console.warn(`[ingest] LLM extraction failed: ${(err as Error).message}`);
        return null;
    }
}

async function llmExtractGeneralDocument(
    text: string,
    title: string,
): Promise<{ doc: GeneralDocument; confidence: number } | null> {
    if (!llm) return null;
    try {
        const res = await llm.chat({
            messages: [
                {
                    role: "user",
                    content: `Convert this document text into structured block JSON:\n\n${text.slice(0, 12000)}`,
                },
            ],
            systemPrompt: `You structure documents as JSON. Return ONLY a JSON object in a fenced code block with:
{title, subtitle?, author?, date?, blocks: [{type: "heading"|"paragraph"|"list"|"divider", ...}]}
Heading blocks: {type:"heading", level:1-6, text}. Paragraph blocks: {type:"paragraph", text}. List blocks: {type:"list", ordered:boolean, items:[...]}.`,
            modelOverride: MODELS.SONNET,
        });
        const content = res.choices?.[0]?.message?.content ?? "";
        const json = extractJSON(typeof content === "string" ? content : String(content));
        if (!json || typeof json !== "object") return null;
        const doc = { title, ...(json as Record<string, unknown>) };
        const parsed = GeneralDocumentSchema.safeParse(doc);
        if (!parsed.success) return null;
        return { doc: parsed.data, confidence: 0.8 };
    } catch (err) {
        console.warn(`[ingest] LLM general extraction failed: ${(err as Error).message}`);
        return null;
    }
}

// ── Entry point ─────────────────────────────────

export interface IngestResult {
    doc: StoredDocument;
    confidence: number;
    method: "heuristic" | "llm" | "heuristic+llm";
    warnings: string[];
}

export async function ingestPdfToDocument(
    filePath: string,
    type: DocumentType,
    displayName?: string,
): Promise<IngestResult> {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }
    if (!/\.pdf$/i.test(filePath)) {
        throw new Error(`Only .pdf files are supported by ingest: ${path.basename(filePath)}`);
    }
    const bytes = readPdf(filePath);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const cacheKey = `${hash}:${type}`;
    const cached = extractionCache.get(cacheKey);

    const text = await extractText(bytes);
    if (!text || text.trim().length === 0) {
        throw new Error("PDF yielded no extractable text. Image-only PDFs are not supported in this build.");
    }

    const name = displayName ?? path.basename(filePath, path.extname(filePath));
    const warnings: string[] = [];
    let resume: Resume | null = null;
    let general: GeneralDocument | null = null;
    let confidence = 0;
    let method: IngestResult["method"] = "heuristic";

    if (type === "resume") {
        const heuristic = parseResumeHeuristic(text);
        warnings.push(...heuristic.warnings);
        resume = heuristic.resume;
        confidence = heuristic.confidence;

        if (confidence < 0.6) {
            const llmResult = cached?.resume
                ? { resume: cached.resume, confidence: cached.confidence }
                : await llmExtractResume(text);
            if (llmResult) {
                resume = llmResult.resume;
                confidence = llmResult.confidence;
                method = "heuristic+llm";
            } else {
                warnings.push("LLM extraction unavailable or failed — returning heuristic result.");
            }
        }
    } else {
        // General document — always delegate to LLM if available; heuristic
        // output is low-value for arbitrary documents.
        const llmResult = cached?.general
            ? { doc: cached.general, confidence: cached.confidence }
            : await llmExtractGeneralDocument(text, name);
        if (llmResult) {
            general = llmResult.doc;
            confidence = llmResult.confidence;
            method = "llm";
        } else {
            // Fall back to a single markdown block containing the raw text.
            general = {
                title: name,
                blocks: [{ type: "markdown", text: text.slice(0, 20000) }],
            };
            confidence = 0.3;
            warnings.push("LLM unavailable — stored raw text as a single markdown block.");
        }
    }

    extractionCache.set(cacheKey, {
        resume: resume ?? undefined,
        general: general ?? undefined,
        confidence,
    });

    const data = type === "resume" ? resume! : general!;
    const stored = saveDocument({
        name,
        type,
        data,
    });

    return { doc: stored, confidence, method, warnings };
}
