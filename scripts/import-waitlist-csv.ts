// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// One-shot CSV → waitlist importer. Reads a Web3Forms-style CSV from STDIN
// or a file path, normalizes the rows, and POSTs to /api/admin/waitlist/import.
// Idempotent server-side (skips emails that already exist), safe to re-run.
//
// Usage:
//   ATLAS_ADMIN_KEY=... ATLAS_ADMIN_BASE=https://<convex-site> \
//     npx tsx scripts/import-waitlist-csv.ts <path-to.csv>
//
// CSV columns expected (header row required):
//   Submitted At, First Name, Last Name, Email, Company, Role, Subject, Use Case

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { extname } from "node:path";
import { argv, exit } from "node:process";

const adminBase = process.env.ATLAS_ADMIN_BASE;
const adminKey = process.env.ATLAS_ADMIN_KEY;
if (!adminBase || !adminKey) {
    console.error(
        "Both ATLAS_ADMIN_BASE (Convex site URL, e.g. https://avid-oyster-465.convex.site)\n" +
            "and ATLAS_ADMIN_KEY (matches the ADMIN_API_KEY env in Convex) must be set.",
    );
    exit(2);
}

// Refuse anything that isn't an HTTPS Convex URL — a malicious .env line like
// ATLAS_ADMIN_BASE=https://attacker.example/ would quietly exfiltrate the
// entire waitlist + the bearer token. The convex.site / convex.cloud
// hostnames are the only places the admin endpoints actually live.
let parsedBase: URL;
try {
    parsedBase = new URL(adminBase);
} catch {
    console.error(`ATLAS_ADMIN_BASE is not a valid URL: ${adminBase}`);
    exit(2);
}
if (parsedBase.protocol !== "https:" || !/\.convex\.(site|cloud)$/i.test(parsedBase.hostname)) {
    console.error(
        `ATLAS_ADMIN_BASE must be https://*.convex.site (or .convex.cloud). Got: ${adminBase}`,
    );
    exit(2);
}

const csvPath = argv[2];
if (!csvPath) {
    console.error("Usage: tsx scripts/import-waitlist-csv.ts <path-to.csv>");
    exit(2);
}

// Refuse symlinks and non-.csv extensions. Operator typically runs this
// against their own CSV, but a tampered Makefile/CI variable could swap the
// path for a symlink to /etc/passwd; we'd dutifully parse it as CSV and
// POST the contents upstream.
const stat = lstatSync(csvPath);
if (stat.isSymbolicLink()) {
    console.error(`Refusing to follow symlink: ${csvPath} → ${realpathSync(csvPath)}`);
    exit(2);
}
if (!stat.isFile()) {
    console.error(`Not a regular file: ${csvPath}`);
    exit(2);
}
if (extname(csvPath).toLowerCase() !== ".csv") {
    console.error(`Expected .csv extension, got: ${extname(csvPath)}`);
    exit(2);
}

// Minimal CSV parser that handles quoted fields with embedded commas / quotes.
// Web3Forms exports are well-formed CRLF or LF; no need to pull in a full lib.
function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let field = "";
    let row: string[] = [];
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ",") {
            row.push(field);
            field = "";
        } else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            row.push(field);
            if (row.some((f) => f.length > 0)) rows.push(row);
            row = [];
            field = "";
        } else {
            field += c;
        }
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        if (row.some((f) => f.length > 0)) rows.push(row);
    }
    return rows;
}

function isMissing(value: string): boolean {
    const v = value.trim().toLowerCase();
    return v === "" || v === "not avilable" || v === "not available" || v === "n/a";
}

const raw = readFileSync(csvPath, "utf8");
const rows = parseCsv(raw);
if (rows.length < 2) {
    console.error("CSV is empty or missing a data row.");
    exit(2);
}

const header = rows[0].map((h) => h.trim().toLowerCase());
const idx = (name: string) => header.indexOf(name);
const iSubmitted = idx("submitted at");
const iFirst = idx("first name");
const iLast = idx("last name");
const iEmail = idx("email");
const iCompany = idx("company");
const iRole = idx("role");
const iUseCase = idx("use case");

const required = { "submitted at": iSubmitted, email: iEmail, "use case": iUseCase };
for (const [name, i] of Object.entries(required)) {
    if (i < 0) {
        console.error(`CSV is missing required column: "${name}"`);
        exit(2);
    }
}

const entries: Array<{
    firstName: string;
    lastName: string;
    email: string;
    role: string;
    company?: string;
    useCase: string;
    status?: string;
    adminNotes?: string;
    submittedAt?: number;
}> = [];

for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const email = (row[iEmail] || "").trim().toLowerCase();
    if (!email) {
        console.warn(`Row ${r + 1}: missing email — skipping`);
        continue;
    }

    // The CSV uses "not avilable" [sic] for missing submission timestamps —
    // fall back to "now" when we can't parse a date.
    let submittedAt: number | undefined;
    const rawTs = row[iSubmitted];
    if (!isMissing(rawTs)) {
        const ts = Date.parse(rawTs);
        if (!Number.isNaN(ts)) submittedAt = ts;
    }

    const firstRaw = iFirst >= 0 ? row[iFirst] : "";
    const lastRaw = iLast >= 0 ? row[iLast] : "";
    const firstName = isMissing(firstRaw) ? "Unknown" : firstRaw.trim();
    const lastName = isMissing(lastRaw) ? "" : lastRaw.trim();
    const role = iRole >= 0 && !isMissing(row[iRole]) ? row[iRole].trim() : "Unknown";
    const company = iCompany >= 0 && !isMissing(row[iCompany]) ? row[iCompany].trim() : undefined;
    const useCase = iUseCase >= 0 && !isMissing(row[iUseCase]) ? row[iUseCase].trim() : "Other";

    entries.push({
        firstName,
        lastName,
        email,
        role,
        company,
        useCase,
        status: "new",
        adminNotes: "Imported from Web3Forms CSV on 2026-05-15",
        submittedAt,
    });
}

// Chunk to <=500 entries per request. The Convex side rejects larger batches
// to keep a single mutation transaction within its read/write/time limits.
const CHUNK_SIZE = 500;
console.log(
    `Parsed ${entries.length} entries. Importing to ${adminBase}/api/admin/waitlist/import in ` +
        `${Math.ceil(entries.length / CHUNK_SIZE)} chunk(s) …`,
);

const url = `${adminBase.replace(/\/+$/, "")}/api/admin/waitlist/import`;
let totalInserted = 0;
let totalSkipped = 0;
const allSkippedEmails: string[] = [];

for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    const resp = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${adminKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ entries: chunk }),
    });
    const text = await resp.text();
    if (!resp.ok) {
        console.error(
            `Chunk ${i / CHUNK_SIZE + 1} failed (${resp.status}): ${text.slice(0, 500)}`,
        );
        exit(1);
    }
    try {
        const data = JSON.parse(text);
        totalInserted += data.inserted ?? 0;
        totalSkipped += data.skipped ?? 0;
        if (Array.isArray(data.skippedEmails)) allSkippedEmails.push(...data.skippedEmails);
    } catch {
        console.warn(`Chunk ${i / CHUNK_SIZE + 1} returned non-JSON:`, text.slice(0, 200));
    }
}

console.log("Import result:", {
    inserted: totalInserted,
    skipped: totalSkipped,
    skippedEmails: allSkippedEmails.slice(0, 20),
});
