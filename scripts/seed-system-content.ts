#!/usr/bin/env npx tsx
/**
 * Seed script for Bhai System Content (Prompts + Skills)
 *
 * Reads local prompt files from /prompts and skill files from /skills,
 * then uploads them to Convex via the admin API endpoints.
 *
 * Usage:
 *   ADMIN_API_KEY=your-key npx tsx scripts/seed-system-content.ts
 *
 * Prerequisites:
 *   - Convex backend must be deployed with system_prompts + system_skills tables
 *   - ADMIN_API_KEY environment variable set (must match Convex env var)
 */

import * as fs from "fs";
import * as path from "path";

const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL
  || (process.env.CONVEX_URL || "https://flexible-panther-179.convex.cloud").replace(".cloud", ".site");
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

if (!ADMIN_API_KEY) {
  console.error("❌ ADMIN_API_KEY environment variable is required");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${ADMIN_API_KEY}`,
};

// ── Skill category mapping (mirrors the old SKILL_CATEGORIES in tool-router.ts) ──
const SKILL_CATEGORIES: Record<string, string[]> = {
  "coding_best_practices": ["shell", "file_system", "long_tasks"],
  "data_scientist": ["shell", "file_system", "research"],
  "devops_engineer": ["shell", "system_controls", "file_system"],
  "full_stack_developer": ["shell", "file_system", "browser", "long_tasks"],
  "os_automation": ["os_control", "system_controls", "app_management"],
  "research_analyst": ["web_search", "research", "browser"],
  "security_auditor": ["shell", "file_system", "browser"],
  "technical_writer": ["file_system", "research"],
  "ui_ux_designer": ["browser", "media", "file_system"],
  "video_editing": ["os_control", "app_management", "media", "file_system"],
  "app_navigation": ["os_control", "app_management", "system_controls"],
  "gaming": ["os_control", "app_management"],
  "web_browsing": ["browser", "web_search", "media", "integrations"],
  "marketing": ["browser", "web_search", "integrations", "research"],
};

// ── Seed Prompts ─────────────────────────────────

async function seedPrompts() {
  const promptsDir = path.resolve("prompts");
  if (!fs.existsSync(promptsDir)) {
    console.error("❌ prompts/ directory not found");
    return;
  }

  const promptFiles = [
    { slug: "identity", file: "identity.md" },
    { slug: "rules", file: "rules.md" },
    { slug: "rules-mac", file: "rules-mac.md" },
    { slug: "rules-windows", file: "rules-windows.md" },
    { slug: "browsing", file: "browsing.md" },
    { slug: "thinking", file: "thinking.md" },
    { slug: "coding", file: "coding.md" },
    { slug: "spec", file: "spec.md" },
    { slug: "proactive-composer", file: "proactive-composer.md" },
    { slug: "monitor-rule-parser", file: "monitor-rule-parser.md" },
    { slug: "orchestrator-base", file: "orchestrator-base.md" },
  ];

  console.log("\n📝 Seeding system prompts...\n");

  for (const { slug, file } of promptFiles) {
    const filePath = path.join(promptsDir, file);
    if (!fs.existsSync(filePath)) {
      console.warn(`  ⚠️  Skipping ${file} (not found)`);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8").trim();

    const response = await fetch(`${CONVEX_SITE_URL}/api/admin/prompts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ slug, content, updatedBy: "seed-script" }),
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`  ✅ ${slug} (v${result.version}) — ${content.length} chars`);
    } else {
      const err = await response.json().catch(() => ({ error: "Unknown" }));
      console.error(`  ❌ ${slug}: ${(err as any).error}`);
    }
  }
}

// ── Seed Skills ──────────────────────────────────

async function seedSkills() {
  const skillsDir = path.resolve("skills");
  if (!fs.existsSync(skillsDir)) {
    console.error("❌ skills/ directory not found");
    return;
  }

  console.log("\n📚 Seeding system skills...\n");

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const filePath = path.join(skillsDir, entry.name);
    const content = fs.readFileSync(filePath, "utf-8").trim();
    const slugFromFile = path.basename(entry.name, ".md");

    // Parse frontmatter
    let name = slugFromFile;
    let description = "";
    let instructions = content;

    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (fmMatch) {
      const frontmatter = fmMatch[1];
      instructions = fmMatch[2].trim();

      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

      if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
      if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, "");
    }

    const categories = SKILL_CATEGORIES[slugFromFile] || [];

    const response = await fetch(`${CONVEX_SITE_URL}/api/admin/skills`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: slugFromFile,
        name,
        description,
        instructions,
        categories,
        updatedBy: "seed-script",
      }),
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`  ✅ ${slugFromFile} (v${result.version}) — ${instructions.length} chars, categories: [${categories.join(", ")}]`);
    } else {
      const err = await response.json().catch(() => ({ error: "Unknown" }));
      console.error(`  ❌ ${slugFromFile}: ${(err as any).error}`);
    }
  }
}

// ── Main ─────────────────────────────────────────

async function main() {
  console.log(`🌐 Convex Site URL: ${CONVEX_SITE_URL}`);
  console.log(`🔑 Admin API Key: ${ADMIN_API_KEY.slice(0, 4)}...${ADMIN_API_KEY.slice(-4)}`);

  await seedPrompts();
  await seedSkills();

  console.log("\n✅ System content seeding complete!\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
