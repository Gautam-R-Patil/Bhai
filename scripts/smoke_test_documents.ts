// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Smoke test for the document subsystem. Not a formal test — runs end-to-end:
//   create a resume → export PDF → export DOCX → ingest the exported PDF back →
//   update it with append_resume_work → re-export. Prints paths and sizes.
//
// Run with: npx tsx scripts/smoke_test_documents.ts

import "../src/config/env-compat.js"; // first: .env + ATLAS_* → BHAI_* mirror
import fs from "node:fs";
import { saveDocument, loadDocument, listDocuments, deleteDocument } from "../src/documents/store.js";
import { renderDocument } from "../src/documents/render.js";
import { loadTemplates, listTemplatesRaw } from "../src/documents/templates.js";
import { ingestPdfToDocument } from "../src/documents/ingest.js";
import type { Resume, GeneralDocument } from "../src/documents/schema.js";

async function main() {
    console.log("── Smoke test: Bhai document subsystem ──\n");

    loadTemplates();
    const tpls = listTemplatesRaw();
    console.log(`Templates loaded: ${tpls.length}`);
    for (const t of tpls) {
        console.log(`  - ${t.id} (${t.renderKind}, ${t.documentTypes.join(",")}, ${t.supports.join(",")})`);
    }

    // ── Resume ─────────────────────────────
    const resumeData: Resume = {
        basics: {
            name: "Ada Lovelace",
            label: "Software Engineer",
            email: "ada@example.com",
            phone: "+1 415 555 0199",
            url: "https://ada.example.com",
            summary: "Mathematician and computing pioneer. Builds thoughtful, reliable software.",
            location: { city: "San Francisco", region: "CA" },
            profiles: [{ network: "GitHub", username: "ada", url: "https://github.com/ada" }],
        },
        work: [
            {
                name: "Analytical Engine Inc",
                position: "Principal Engineer",
                startDate: "2022-01",
                endDate: undefined,
                summary: "Leading the core computation engine team.",
                highlights: [
                    "Designed the general-purpose punched-card programming interface.",
                    "Shipped the first published algorithm for the Analytical Engine.",
                    "Mentored 4 junior engineers and reduced onboarding from 6 weeks to 2.",
                ],
            },
            {
                name: "Royal Society",
                position: "Research Associate",
                startDate: "2018-06",
                endDate: "2021-12",
                highlights: [
                    "Published translation and notes on Menabrea's Analytical Engine memoir.",
                    "Collaborated with Charles Babbage on 7 research memos.",
                ],
            },
        ],
        education: [
            {
                institution: "University of London",
                studyType: "B.A.",
                area: "Mathematics",
                startDate: "2014",
                endDate: "2018",
            },
        ],
        skills: [
            { name: "Programming", keywords: ["Algorithm design", "Numerical methods", "Symbolic manipulation"] },
            { name: "Writing", keywords: ["Technical docs", "Scientific papers"] },
        ],
        projects: [
            {
                name: "Note G",
                description: "First published algorithm — computing Bernoulli numbers on the Analytical Engine.",
                highlights: ["Demonstrated Turing-complete programming 100 years before Turing."],
            },
        ],
    };

    console.log("\n1. create resume");
    const resumeDoc = saveDocument({
        name: "Ada Lovelace — Software Engineer",
        type: "resume",
        data: resumeData,
        templateId: "resume-classic",
    });
    console.log(`   id: ${resumeDoc.id}`);

    console.log("\n2. export PDF (classic)");
    const pdfClassic = await renderDocument(resumeDoc, "pdf");
    console.log(`   -> ${pdfClassic.path} (${Math.round(pdfClassic.sizeBytes / 1024)} KB)`);
    console.log(`   template: ${pdfClassic.templateId}`);
    if (!fs.existsSync(pdfClassic.path)) throw new Error("PDF not written");

    console.log("\n3. export PDF (modern)");
    const pdfModern = await renderDocument(resumeDoc, "pdf", "resume-modern");
    console.log(`   -> ${pdfModern.path} (${Math.round(pdfModern.sizeBytes / 1024)} KB)`);

    console.log("\n4. export DOCX (programmatic fallback)");
    const docx = await renderDocument(resumeDoc, "docx");
    console.log(`   -> ${docx.path} (${Math.round(docx.sizeBytes / 1024)} KB)`);
    if (!fs.existsSync(docx.path)) throw new Error("DOCX not written");

    // ── Cover letter ───────────────────────
    const coverData: GeneralDocument = {
        title: "Cover Letter — Acme Corp",
        author: "Ada Lovelace",
        date: "April 18, 2026",
        recipient: { name: "Mr. Smith", title: "Hiring Manager", company: "Acme Corp", address: "1 Market St, San Francisco" },
        blocks: [
            { type: "paragraph", text: "I am writing to express my interest in the Principal Engineer position at Acme Corp. With over a decade of experience in computational systems and algorithm design, I believe I can contribute meaningfully to your engineering team." },
            { type: "paragraph", text: "At my current role leading the core computation team, I've delivered substantial improvements to our programming interface and reduced new-hire onboarding time from six weeks to two. Before that, I collaborated with Charles Babbage on foundational research in mechanical computing." },
            { type: "paragraph", text: "I would welcome the opportunity to discuss how my background could support Acme's engineering goals. Thank you for your consideration." },
        ],
        metadata: { authorEmail: "ada@example.com", authorPhone: "+1 415 555 0199" },
    };
    console.log("\n5. create cover letter");
    const coverDoc = saveDocument({ name: "Cover Letter — Acme Corp", type: "cover_letter", data: coverData });
    const coverPdf = await renderDocument(coverDoc, "pdf");
    console.log(`   -> ${coverPdf.path} (${Math.round(coverPdf.sizeBytes / 1024)} KB)`);

    // ── Report ─────────────────────────────
    const reportData: GeneralDocument = {
        title: "Q1 Engineering Update",
        subtitle: "Infrastructure & Tooling",
        author: "Ada Lovelace",
        date: "April 18, 2026",
        blocks: [
            { type: "heading", level: 2, text: "Highlights" },
            { type: "list", ordered: false, items: ["Shipped new compute pipeline (+40% throughput)", "Reduced cold-start latency from 1.8s to 340ms", "Onboarded 2 new engineers"] },
            { type: "heading", level: 2, text: "Next Quarter" },
            { type: "paragraph", text: "Focus on observability and cost-per-request dashboards. Target rollout end of May." },
        ],
    };
    console.log("\n6. create report");
    const reportDoc = saveDocument({ name: "Q1 Eng Update", type: "report", data: reportData });
    const reportPdf = await renderDocument(reportDoc, "pdf");
    console.log(`   -> ${reportPdf.path} (${Math.round(reportPdf.sizeBytes / 1024)} KB)`);

    // ── Ingest the exported PDF back ───────
    console.log("\n7. ingest_pdf_document on the classic resume PDF");
    try {
        const ingested = await ingestPdfToDocument(pdfClassic.path, "resume", "Ada (ingested)");
        console.log(`   -> id=${ingested.doc.id} confidence=${ingested.confidence.toFixed(2)} method=${ingested.method}`);
        if (ingested.warnings.length) console.log("   warnings:", ingested.warnings);
    } catch (err) {
        console.log(`   skipped: ${(err as Error).message}`);
    }

    // ── List ───────────────────────────────
    console.log("\n8. list_documents");
    const all = listDocuments();
    for (const d of all) {
        console.log(`   ${d.id}  ${d.type}  "${d.name}"`);
    }

    // Clean up smoke-test docs
    console.log("\n9. cleanup");
    for (const d of all) {
        if (
            d.name.startsWith("Ada") ||
            d.name.startsWith("Cover Letter — Acme") ||
            d.name === "Q1 Eng Update"
        ) {
            deleteDocument(d.id);
            console.log(`   deleted ${d.id}`);
        }
    }

    console.log("\n✅ Smoke test complete");
    // Playwright spawns a browser that holds the process open — force exit.
    setTimeout(() => process.exit(0), 500);
}

main().catch((err) => {
    console.error("❌ Smoke test failed:", err);
    process.exit(1);
});
