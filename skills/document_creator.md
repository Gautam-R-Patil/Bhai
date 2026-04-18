---
name: Document Creator
description: Making, editing, and exporting structured documents — resumes, CVs, cover letters, reports, letters, invoices — as polished PDF or DOCX files.
---

You have a dedicated document toolchain for creating and editing structured documents. Use it whenever the user asks about resumes, CVs, cover letters, job applications, reports, letters, invoices, or any similar document artifact.

## Core principle — round-trip through structured data

**Never try to edit a PDF in place.** PDFs are not semantic — there is no reliable way to modify text inside an arbitrary PDF. Instead, always round-trip through the canonical JSON representation stored by the document tools:

1. **Create fresh** → `create_document` → `export_document` → `send_file`
2. **Edit existing** → `ingest_pdf_document` (parse PDF → JSON) → `update_document` or `append_resume_work` → `export_document` → `send_file`

This matches how every production resume product works (Rezi, Teal, Kickresume, ChatGPT Canvas, Claude File Creation).

## When the user uploads a PDF resume

If the user sends a PDF and asks you to change anything about it:
1. Call `ingest_pdf_document` with the uploaded file path.
2. Check the returned `confidence` — if it's below 0.6, load the document with `load_document` and show the user what was extracted so they can correct mistakes before you edit.
3. Apply their requested edits with `update_document` (for arbitrary field changes) or `append_resume_work` (for adding a job to a resume).
4. Export with `export_document` (default format: PDF; pass `format: "docx"` for Word).
5. Call `send_file` with the returned path to deliver.

## When the user wants a brand new resume

1. Collect the information you need — the JSON Resume schema covers `basics`, `work`, `education`, `skills`, `projects`, `awards`, `languages`. If the user is sparse ("make me a resume"), ask 2-3 targeted questions (name, target role, most recent job) before generating — a half-filled resume is worse than a quick conversation.
2. Call `create_document` with `type: "resume"` and the structured data.
3. (Optional) call `list_templates` to show available templates if the user seems interested in style. Default is fine for most cases.
4. Call `export_document` and then `send_file`.

## Cover letters

Use `type: "cover_letter"` with a `GeneralDocument` shape:
```
{
  title: "Cover Letter — Acme Corp",
  author: "User's name",
  date: "2026-04-18",
  recipient: {name, title, company, address},
  blocks: [
    {type: "paragraph", text: "..."},
    ...
  ],
  metadata: {authorEmail, authorPhone, salutation, closing}
}
```
The `cover-letter-standard` template renders this with block-formatted addressing, date, salutation, signed closing.

## Reports / letters / other docs

Use `type: "report"` or `type: "letter"` with `GeneralDocument` blocks: `heading`, `paragraph`, `list`, `table`, `divider`, `spacer`, `markdown`. The `report-basic` template covers these.

## ATS safety (for resumes going to job applications)

The bundled `resume-classic` and `resume-modern` templates are ATS-safe: single column, embedded text layer, web-safe fonts (Calibri / Helvetica Neue), no icons in text. Do not instruct the agent to generate custom HTML with icon fonts, multi-column layouts, or images in the main text area if the resume is for an ATS-screened role.

## Format choice

- **PDF** (default) — final output for job applications, archiving, sharing.
- **DOCX** — when the user wants to edit in Word, or the application portal requires it.

Say "Export as Word" / "make it a Word doc" → pass `format: "docx"` to `export_document`.

## Delivery

After every successful `export_document`, call `send_file` with the returned path. The user is expecting a file, not just a filename in the chat.
