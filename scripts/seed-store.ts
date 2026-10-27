#!/usr/bin/env npx tsx
/**
 * Seed script for Bhai Store — DISABLED.
 *
 * The store backend (convex/store/*.ts) was converted from public
 * `mutation`/`query` to `internalMutation`/`internalQuery` to close a
 * critical auth bypass: anyone on the internet could otherwise call
 * `store/admins:create`, `store/developers:approve`, etc. The change
 * means `ConvexHttpClient.query/mutation(api.store.X, ...)` no longer
 * resolves — `api.store.X` is no longer in the public surface.
 *
 * If you need to (re)seed the store, do one of:
 *   1. `npx convex run convex/store/items:create '{...}'` (requires the
 *      Convex deploy key — internal functions are callable via the
 *      Convex CLI when authenticated as a deploy admin).
 *   2. Build a one-shot admin HTTP action under /api/admin/seed-store-*
 *      (gated by ADMIN_API_KEY) that wraps the upserts in a single
 *      call, then update this script to POST to it with the bearer.
 *
 * Until one of those paths lands, running this script is a no-op + an
 * explanation. Don't silently call the dead public API — fail fast so
 * the next maintainer notices.
 */
// biome-ignore lint/correctness/noUnusedImports: kept for reference once seed is rewired.
// @ts-expect-error: api.store.* deliberately gone after the internal-only conversion.
import { ConvexHttpClient } from "convex/browser";
// biome-ignore lint/correctness/noUnusedImports: kept for reference once seed is rewired.
import * as fs from "fs";
// biome-ignore lint/correctness/noUnusedImports: kept for reference once seed is rewired.
import * as path from "path";
// biome-ignore lint/correctness/noUnusedImports: kept for reference once seed is rewired.
import { createHash } from "crypto";
// biome-ignore lint/correctness/noUnusedImports: kept for reference once seed is rewired.
import archiver from "archiver";

console.error(
  "scripts/seed-store.ts is disabled — the store backend is internal-only after the security audit. " +
  "See the file header for the migration path. Exiting.",
);
process.exit(1);

// ─────────────────────────────────────────────────────────────────────────
// Original implementation kept below for reference. Do not run as-is — the
// `api.store.*` path no longer resolves because store functions are internal.
// ─────────────────────────────────────────────────────────────────────────
// @ts-nocheck
import { api } from "../convex/_generated/api";

// Convex client
const CONVEX_URL = process.env.CONVEX_URL || "https://avid-finch-726.convex.cloud";
const client = new ConvexHttpClient(CONVEX_URL);

// Sample tools to upload
const SAMPLE_TOOLS = [
  {
    slug: "json-utils",
    name: "JSON Utils",
    description: "Format, validate, minify, and transform JSON data with powerful utility functions.",
    longDescription: `# JSON Utils

A comprehensive JSON utility tool for Bhai.

## Features

- **Format**: Pretty-print JSON with customizable indentation
- **Minify**: Compress JSON by removing whitespace
- **Validate**: Check if a string is valid JSON
- **Sort Keys**: Alphabetically sort object keys recursively
- **Extract Keys**: List all keys in a nested JSON structure
- **Count**: Get statistics about JSON structure (objects, arrays, values)

## Usage Examples

\`\`\`
Format JSON:
json_utils({"json_input": "{\\"a\\":1}", "operation": "format"})

Validate JSON:
json_utils({"json_input": "invalid json", "operation": "validate"})
\`\`\`
`,
    type: "tool" as const,
    category: "utilities",
    tags: ["json", "formatter", "validator", "utilities"],
    permissions: [],
    version: "1.0.0",
    localPath: path.join(process.env.HOME!, ".atlas", "store", "tools", "json-utils"),
  },
  {
    slug: "uuid-generator",
    name: "UUID Generator",
    description: "Generate UUIDs, short IDs, numeric IDs, and custom-format unique identifiers.",
    longDescription: `# UUID Generator

Generate various types of unique identifiers.

## ID Types

- **UUID**: Standard UUID v4 (e.g., "550e8400-e29b-41d4-a716-446655440000")
- **Short**: Alphanumeric IDs (e.g., "xK9mP2nQ")
- **Numeric**: Digit-only IDs (e.g., "1847293650")
- **Timestamp**: Sortable time-based IDs (e.g., "lx1z9k4f-Ab3Kp2")
- **Hex**: Hexadecimal IDs (e.g., "a1b2c3d4")
- **Base64**: URL-safe base64 IDs
- **Custom**: Pattern-based IDs (e.g., "ABC-1234")

## Usage Examples

\`\`\`
Generate UUID:
generate_id({"type": "uuid"})

Generate 5 short IDs with prefix:
generate_id({"type": "short", "count": 5, "prefix": "user_"})

Custom pattern (A=uppercase, 9=digit):
generate_id({"type": "custom", "pattern": "AAA-9999"})
\`\`\`
`,
    type: "tool" as const,
    category: "utilities",
    tags: ["uuid", "generator", "id", "utilities"],
    permissions: [],
    version: "1.0.0",
    localPath: path.join(process.env.HOME!, ".atlas", "store", "tools", "uuid-generator"),
  },
];

async function createZipArchive(sourceDir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);

    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function uploadFile(buffer: Buffer): Promise<string> {
  // Get upload URL from Convex
  const uploadUrl = await client.mutation(api.store.storage.generateUploadUrl, {});

  // Upload the file
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: buffer,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.statusText}`);
  }

  const { storageId } = await response.json();
  return storageId;
}

async function main() {
  console.log("🏪 Bhai Store Seed Script\n");

  // Step 1: Create or get test developer
  console.log("1. Creating test developer account...");

  let developerId: string;
  const testEmail = "test-developer@atlas.local";

  try {
    const existingDev = await client.query(api.store.developers.getByEmail, {
      email: testEmail,
    });

    if (existingDev) {
      developerId = existingDev._id;
      console.log(`   Using existing developer: ${developerId}`);
    } else {
      // Create new test developer (pre-approved)
      developerId = await client.mutation(api.store.developers.register, {
        email: testEmail,
        passwordHash: "$2a$12$test.hash.not.real", // Not a real login
        displayName: "Bhai Team",
        companyName: "XAGI Labs Private Limited",
        website: "https://atlas.app",
        bio: "Official Bhai development team",
      });

      // Auto-approve the test developer
      await client.mutation(api.store.developers.approve, {
        developerId: developerId as any,
        adminEmail: "system@atlas.local",
      });

      console.log(`   Created new developer: ${developerId}`);
    }
  } catch (err) {
    console.error("   Failed to create developer:", err);
    throw err;
  }

  // Step 2: Upload each sample tool
  console.log("\n2. Uploading sample tools...\n");

  for (const tool of SAMPLE_TOOLS) {
    console.log(`   📦 ${tool.name}`);

    // Check if tool already exists
    try {
      const existing = await client.query(api.store.items.getBySlug, {
        slug: tool.slug,
      });

      if (existing) {
        console.log(`      ⏭️  Already exists, skipping`);
        continue;
      }
    } catch {
      // Not found, continue
    }

    // Check if local files exist
    if (!fs.existsSync(tool.localPath)) {
      console.log(`      ⚠️  Local files not found at ${tool.localPath}`);
      continue;
    }

    try {
      // Create zip archive
      console.log(`      Creating zip archive...`);
      const zipBuffer = await createZipArchive(tool.localPath);
      console.log(`      Archive size: ${(zipBuffer.length / 1024).toFixed(1)} KB`);

      // Upload to Convex storage
      console.log(`      Uploading to Convex...`);
      const storageId = await uploadFile(zipBuffer);
      console.log(`      Storage ID: ${storageId}`);

      // Create store item
      console.log(`      Creating store item...`);
      const itemId = await client.mutation(api.store.items.create, {
        slug: tool.slug,
        type: tool.type,
        name: tool.name,
        description: tool.description,
        longDescription: tool.longDescription,
        developerId: developerId as any,
        version: tool.version,
        contentFileId: storageId as any,
        category: tool.category,
        tags: tool.tags,
        permissions: tool.permissions,
        pricing: "free",
      });

      console.log(`      ✅ Created: ${itemId}\n`);
    } catch (err) {
      console.error(`      ❌ Failed:`, err);
    }
  }

  console.log("\n✅ Seed complete!");
  console.log("\nYou can now:");
  console.log("  - View items in the admin panel");
  console.log("  - Install items from the desktop app store");
  console.log("  - Test the download/install flow");
}

main().catch(console.error);
