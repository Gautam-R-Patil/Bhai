// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Server-side system prompts and skills management.
// Prompts and skill instructions NEVER leave the server — they are injected
// into the LLM request server-side before forwarding to OpenRouter.

import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

// ══════════════════════════════════════════════════════════════════════════
// QUERIES
// ══════════════════════════════════════════════════════════════════════════

// ── Get all system prompts ───────────────────────
export const getAllPrompts = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("system_prompts").collect();
  },
});

// ── Get a single prompt by slug ──────────────────
export const getPromptBySlug = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    return await ctx.db
      .query("system_prompts")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
  },
});

// ── Get all active system skills ─────────────────
export const getAllActiveSkills = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("system_skills")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect();
  },
});

// ── Get skills by slugs ─────────────────────────
export const getSkillsBySlugs = internalQuery({
  args: { slugs: v.array(v.string()) },
  handler: async (ctx, { slugs }) => {
    if (slugs.length === 0) return [];

    const skills = [];
    for (const slug of slugs) {
      const skill = await ctx.db
        .query("system_skills")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique();
      if (skill && skill.isActive) {
        skills.push(skill);
      }
    }
    return skills;
  },
});

// ── Get skill metadata (slug + categories only, no instructions) ─────
export const getSkillMetadata = internalQuery({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, { userId }) => {
    // 1. Get all active built-in skills (metadata only)
    const builtInSkills = await ctx.db
      .query("system_skills")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect();

    const metadata: Array<{
      slug: string;
      name: string;
      description: string;
      categories: string[];
      source: "system" | "store";
    }> = builtInSkills.map((s) => ({
      slug: s.slug,
      name: s.name,
      description: s.description,
      categories: s.categories,
      source: "system" as const,
    }));

    // 2. If userId provided, also include user's installed store skills
    if (userId) {
      const installs = await ctx.db
        .query("store_installs")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();

      for (const install of installs) {
        if (install.itemType !== "skill") continue;
        const item = await ctx.db.get(install.itemId);
        if (item && item.status === "active") {
          metadata.push({
            slug: item.slug,
            name: item.name,
            description: item.description,
            categories: (item.tags || []) as string[],
            source: "store" as const,
          });
        }
      }
    }

    return metadata;
  },
});

// ── Assemble the full system prompt ──────────────
// Called by the LLM proxy on every request. Returns the complete system prompt string.
export const assembleSystemPrompt = internalQuery({
  args: {
    platform: v.string(),                // "mac" | "win" | "linux"
    skillSlugs: v.array(v.string()),     // Skill slugs selected by client tool-router
    userId: v.optional(v.string()),      // For fetching user's installed store skills
  },
  handler: async (ctx, { platform, skillSlugs, userId }) => {
    // 1. Fetch all system prompts
    const allPrompts = await ctx.db.query("system_prompts").collect();
    const promptMap: Record<string, string> = {};
    for (const p of allPrompts) {
      promptMap[p.slug] = p.content;
    }

    // 2. Assemble base prompt (same order as the original local assembly)
    const parts: string[] = [];
    if (promptMap["identity"]) parts.push(promptMap["identity"]);
    if (promptMap["rules"]) parts.push(promptMap["rules"]);

    // Platform-specific rules
    if (platform === "mac" && promptMap["rules-mac"]) {
      parts.push(promptMap["rules-mac"]);
    } else if (platform === "win" && promptMap["rules-windows"]) {
      parts.push(promptMap["rules-windows"]);
    }

    if (promptMap["browsing"]) parts.push(promptMap["browsing"]);

    // 3. Fetch requested skills (built-in system skills)
    const skillParts: string[] = [];

    if (skillSlugs.length > 0) {
      for (const slug of skillSlugs) {
        const skill = await ctx.db
          .query("system_skills")
          .withIndex("by_slug", (q) => q.eq("slug", slug))
          .unique();
        if (skill && skill.isActive) {
          const desc = skill.description ? `> ${skill.description}\n` : "";
          skillParts.push(`### Skill: ${skill.name}\n${desc}${skill.instructions}`);
        }
      }
    }

    // 4. Fetch user's installed store skills
    if (userId) {
      const installs = await ctx.db
        .query("store_installs")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();

      for (const install of installs) {
        if (install.itemType !== "skill") continue;
        // Check if already included via skillSlugs
        if (skillSlugs.includes(install.itemSlug)) continue;

        const item = await ctx.db.get(install.itemId);
        if (item && item.status === "active" && item.contentFileId) {
          // Fetch skill content from Convex storage
          const contentUrl = await ctx.storage.getUrl(item.contentFileId);
          if (contentUrl) {
            try {
              const response = await fetch(contentUrl);
              const content = await response.text();
              // Parse frontmatter if present
              const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
              const instructions = fmMatch ? fmMatch[2].trim() : content.trim();
              const desc = item.description ? `> ${item.description}\n` : "";
              skillParts.push(`### Skill: ${item.name}\n${desc}${instructions}`);
            } catch {
              // Skip failed skill fetch — non-fatal
            }
          }
        }
      }
    }

    // 5. Append skills section if any
    if (skillParts.length > 0) {
      parts.push(`## Available Skills\n\n${skillParts.join("\n\n")}`);
    }

    return parts.filter(Boolean).join("\n\n");
  },
});

// ══════════════════════════════════════════════════════════════════════════
// MUTATIONS (admin-only, called from HTTP actions)
// ══════════════════════════════════════════════════════════════════════════

// ── Upsert a system prompt ───────────────────────
export const upsertPrompt = internalMutation({
  args: {
    slug: v.string(),
    content: v.string(),
    updatedBy: v.optional(v.string()),
  },
  handler: async (ctx, { slug, content, updatedBy }) => {
    const existing = await ctx.db
      .query("system_prompts")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        content,
        version: existing.version + 1,
        updatedAt: now,
        updatedBy,
      });
      return { id: existing._id, version: existing.version + 1 };
    }

    const id = await ctx.db.insert("system_prompts", {
      slug,
      content,
      version: 1,
      updatedAt: now,
      updatedBy,
    });
    return { id, version: 1 };
  },
});

// ── Upsert a system skill ────────────────────────
export const upsertSkill = internalMutation({
  args: {
    slug: v.string(),
    name: v.string(),
    description: v.string(),
    instructions: v.string(),
    categories: v.array(v.string()),
    updatedBy: v.optional(v.string()),
  },
  handler: async (ctx, { slug, name, description, instructions, categories, updatedBy }) => {
    const existing = await ctx.db
      .query("system_skills")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name,
        description,
        instructions,
        categories,
        version: existing.version + 1,
        updatedAt: now,
        updatedBy,
      });
      return { id: existing._id, version: existing.version + 1 };
    }

    const id = await ctx.db.insert("system_skills", {
      slug,
      name,
      description,
      instructions,
      categories,
      isActive: true,
      version: 1,
      updatedAt: now,
      updatedBy,
    });
    return { id, version: 1 };
  },
});

// ── Toggle a skill's active status ───────────────
export const toggleSkill = internalMutation({
  args: {
    slug: v.string(),
    isActive: v.boolean(),
    updatedBy: v.optional(v.string()),
  },
  handler: async (ctx, { slug, isActive, updatedBy }) => {
    const existing = await ctx.db
      .query("system_skills")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();

    if (!existing) {
      throw new Error(`Skill not found: ${slug}`);
    }

    await ctx.db.patch(existing._id, {
      isActive,
      version: existing.version + 1,
      updatedAt: Date.now(),
      updatedBy,
    });
    return { id: existing._id, isActive };
  },
});

// ── Delete a system skill ────────────────────────
export const deleteSkill = internalMutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const existing = await ctx.db
      .query("system_skills")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();

    if (!existing) {
      throw new Error(`Skill not found: ${slug}`);
    }

    await ctx.db.delete(existing._id);
    return { deleted: slug };
  },
});
