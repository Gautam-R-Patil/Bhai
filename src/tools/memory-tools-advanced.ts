// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { getIdentityProfile, updateIdentityProfile } from "../memory/identity.js";
import {
    addEntity,
    addRelationship,
    findEntities,
    getKnowledgeGraphDB,
    getRelationships,
} from "../memory/knowledge-graph.js";
import { forgetMemory, getRawDb, listMemories, remember } from "../memory/sqlite.js";
import { deleteTrait, getAllTraits, getTrait, reinforceTrait, upsertTrait } from "../memory/traits.js";
import { isOwnerCaller } from "./cron-tool.js";
import type { ToolDefinition } from "./get-current-time.js";

// ── Section Types ────────────────────────────────

type CoreMemorySection = "identity" | "traits" | "preferences" | string;

// ── Helpers ──────────────────────────────────────

const OWNER_ONLY = JSON.stringify({ success: false, error: "Only the owner can change Bhai's memory." });
// Pinned memories and commitments carry flags a forget + remember would drop.
const KEPT = JSON.stringify({
    success: false,
    error: "That memory is pinned or a tracked commitment: use memory_store (supersedes, pin_id or done_id) or memory_forget.",
});
const isKept = (id: number) =>
    !!getRawDb()?.prepare("SELECT 1 FROM memories WHERE id = ? AND (pinned = 1 OR due_at IS NOT NULL)").get(id);

/**
 * Read the content of a core memory section.
 */
function readSection(section: CoreMemorySection): string {
    switch (section) {
        case "identity": {
            const profile = getIdentityProfile();
            return JSON.stringify(profile, null, 2);
        }
        case "traits": {
            const traits = getAllTraits();
            if (traits.length === 0) return "(no traits recorded)";
            return traits
                .map(
                    (t) =>
                        `${t.trait_key}: ${t.value} (confidence: ${Math.round(t.confidence * 100)}%, reinforced: ${t.reinforcement_count}x)`,
                )
                .join("\n");
        }
        case "preferences": {
            const kgDb = getKnowledgeGraphDB();
            if (!kgDb) return "(knowledge graph not available)";
            const entities = findEntities(kgDb, "%", "preference");
            if (entities.length === 0) return "(no preferences stored)";
            return entities
                .map((e) => {
                    const props = e.properties;
                    const rels = getRelationships(kgDb, e.id);
                    const relStr =
                        rels.length > 0
                            ? rels.map((r) => `  -> ${r.relationship.type}: ${r.entity.name}`).join("\n")
                            : "";
                    return `${e.name}: ${JSON.stringify(props)}${relStr ? "\n" + relStr : ""}`;
                })
                .join("\n");
        }
        default: {
            // Custom sections: stored as core memories with category = section name
            const memories = listMemories(section, 50);
            if (memories.length === 0) return `(no content in section "${section}")`;
            return memories.map((m) => m.content).join("\n");
        }
    }
}

// ── core_memory_read ─────────────────────────────

export const coreMemoryRead: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "core_memory_read",
            description:
                "Read the content of a specific core memory section. Available sections: 'identity' (user profile), 'traits' (behavioral patterns), 'preferences' (knowledge graph preferences), or any custom section name (stored in sqlite memory). Use this to inspect what you currently know before making edits.",
            parameters: {
                type: "object",
                properties: {
                    section: {
                        type: "string",
                        description:
                            "The memory section to read: 'identity', 'traits', 'preferences', or a custom section name",
                    },
                },
                required: ["section"],
            },
        },
    },
    async handler(input) {
        const section = (input.section as string).toLowerCase().trim();
        try {
            const content = readSection(section);
            return JSON.stringify({ success: true, section, content });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ── core_memory_replace ──────────────────────────

export const coreMemoryReplace: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "core_memory_replace",
            description:
                "Replace specific text in a core memory section. Requires an exact string match of the old content — like a find-and-replace. For 'identity', updates profile fields. For 'traits', updates trait values. For 'preferences', updates knowledge graph entity properties. For custom sections, replaces text within stored memories.",
            parameters: {
                type: "object",
                properties: {
                    section: {
                        type: "string",
                        description: "The memory section: 'identity', 'traits', 'preferences', or custom section name",
                    },
                    old_content: {
                        type: "string",
                        description: "The exact text/value to find and replace",
                    },
                    new_content: {
                        type: "string",
                        description: "The replacement text/value",
                    },
                },
                required: ["section", "old_content", "new_content"],
            },
        },
    },
    async handler(input) {
        if (!isOwnerCaller()) return OWNER_ONLY;
        const section = (input.section as string).toLowerCase().trim();
        const oldContent = input.old_content as string;
        const newContent = input.new_content as string;

        try {
            switch (section) {
                case "identity": {
                    // Find which field contains oldContent and replace it
                    const profile = getIdentityProfile();
                    const fields: Record<string, unknown> = {};
                    let found = false;

                    for (const [key, val] of Object.entries(profile)) {
                        if (typeof val === "string" && val === oldContent) {
                            fields[key] = newContent;
                            found = true;
                        } else if (Array.isArray(val)) {
                            const idx = val.indexOf(oldContent);
                            if (idx >= 0) {
                                const updated = [...val];
                                updated[idx] = newContent;
                                fields[key] = updated;
                                found = true;
                            }
                        }
                    }

                    // Also check nested preferences
                    if (!found && profile.preferences) {
                        const prefs = { ...profile.preferences };
                        for (const [key, val] of Object.entries(prefs)) {
                            if (val === oldContent) {
                                prefs[key] = newContent;
                                found = true;
                            }
                        }
                        if (found) fields.preferences = prefs;
                    }

                    if (!found) {
                        return JSON.stringify({
                            success: false,
                            error: `Exact match not found in identity profile for: "${oldContent}"`,
                        });
                    }

                    updateIdentityProfile(fields);
                    return JSON.stringify({
                        success: true,
                        message: `Replaced "${oldContent}" with "${newContent}" in identity profile`,
                    });
                }
                case "traits": {
                    // Parse old_content as "trait_key: value" or just use it as trait_key lookup
                    const allTraits = getAllTraits();
                    const match = allTraits.find((t) => t.value === oldContent || t.trait_key === oldContent);

                    if (!match) {
                        return JSON.stringify({
                            success: false,
                            error: `No trait found matching: "${oldContent}"`,
                        });
                    }

                    upsertTrait(match.trait_key, newContent, match.confidence, {
                        explicit: true,
                        topics: match.topics,
                    });

                    return JSON.stringify({
                        success: true,
                        message: `Replaced trait ${match.trait_key}: "${oldContent}" -> "${newContent}"`,
                    });
                }
                case "preferences": {
                    const kgDb = getKnowledgeGraphDB();
                    if (!kgDb) return JSON.stringify({ success: false, error: "Knowledge graph not available" });

                    // Find preference entity whose name or property matches oldContent
                    const entities = findEntities(kgDb, "%", "preference");
                    let found = false;

                    for (const entity of entities) {
                        if (entity.name === oldContent) {
                            // Replace entity name by creating new and invalidating related relationships
                            const newId = addEntity(kgDb, newContent, "preference", entity.properties);
                            // Copy relationships
                            const rels = getRelationships(kgDb, entity.id);
                            for (const rel of rels) {
                                const fromId =
                                    rel.relationship.from_id === entity.id ? newId : rel.relationship.from_id;
                                const toId = rel.relationship.to_id === entity.id ? newId : rel.relationship.to_id;
                                addRelationship(kgDb, fromId, toId, rel.relationship.type, rel.relationship.properties);
                            }
                            found = true;
                            break;
                        }

                        // Check properties for the old content
                        const props = entity.properties;
                        for (const [key, val] of Object.entries(props)) {
                            if (val === oldContent) {
                                props[key] = newContent;
                                kgDb.run(
                                    "UPDATE entities SET properties = ?, updated_at = datetime('now') WHERE id = ?",
                                    [JSON.stringify(props), entity.id],
                                );
                                found = true;
                                break;
                            }
                        }
                        if (found) break;
                    }

                    if (!found) {
                        return JSON.stringify({
                            success: false,
                            error: `No preference found matching: "${oldContent}"`,
                        });
                    }

                    return JSON.stringify({
                        success: true,
                        message: `Replaced "${oldContent}" with "${newContent}" in preferences`,
                    });
                }
                default: {
                    // Custom section: find memory containing oldContent and replace
                    const memories = listMemories(section, 100);
                    let replaced = false;

                    for (const mem of memories) {
                        if (mem.content.includes(oldContent)) {
                            if (isKept(mem.id)) return KEPT;
                            const updatedContent = mem.content.replace(oldContent, newContent);
                            forgetMemory(mem.id);
                            void remember(updatedContent, section, "", mem.importance);
                            replaced = true;
                            break;
                        }
                    }

                    if (!replaced) {
                        return JSON.stringify({
                            success: false,
                            error: `Exact match for "${oldContent}" not found in section "${section}"`,
                        });
                    }

                    return JSON.stringify({
                        success: true,
                        message: `Replaced content in section "${section}"`,
                    });
                }
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ── core_memory_append ───────────────────────────

export const coreMemoryAppend: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "core_memory_append",
            description:
                "Append new content to a core memory section. For 'identity', adds projects/goals or extra fields. For 'traits', reinforces or creates a new trait. For 'preferences', creates a preference entity in the knowledge graph. For custom sections, stores a new memory entry.",
            parameters: {
                type: "object",
                properties: {
                    section: {
                        type: "string",
                        description: "The memory section: 'identity', 'traits', 'preferences', or custom section name",
                    },
                    content: {
                        type: "string",
                        description:
                            "The content to append. For traits, use 'key: value' format (e.g., 'prefers_dark_mode: true'). For identity, use 'field: value' format. For preferences and custom sections, free-form text.",
                    },
                    importance: {
                        type: "number",
                        description: "Importance level 1-10 for custom sections (default 7 for core memory appends)",
                    },
                },
                required: ["section", "content"],
            },
        },
    },
    async handler(input) {
        const section = (input.section as string).toLowerCase().trim();
        const content = input.content as string;
        const importance = (input.importance as number) || 7;

        try {
            switch (section) {
                case "identity": {
                    // Parse "field: value" format
                    const colonIdx = content.indexOf(":");
                    if (colonIdx === -1) {
                        // Treat as extra field
                        updateIdentityProfile({ extra: { [content]: true } });
                        return JSON.stringify({
                            success: true,
                            message: `Added "${content}" to identity extra fields`,
                        });
                    }

                    const field = content.substring(0, colonIdx).trim().toLowerCase();
                    const value = content.substring(colonIdx + 1).trim();

                    const fieldMap: Record<string, string> = {
                        name: "name",
                        email: "email",
                        location: "location",
                        role: "role",
                        company: "company",
                    };

                    if (fieldMap[field]) {
                        updateIdentityProfile({ [fieldMap[field]]: value });
                    } else if (field === "project") {
                        const { addProject } = await import("../memory/identity.js");
                        addProject(value);
                    } else if (field === "goal") {
                        const { addGoal } = await import("../memory/identity.js");
                        addGoal(value);
                    } else {
                        // Store as extra
                        updateIdentityProfile({ extra: { [field]: value } });
                    }

                    return JSON.stringify({
                        success: true,
                        message: `Appended to identity: ${field} = ${value}`,
                    });
                }
                case "traits": {
                    // Parse "trait_key: value" format
                    const colonIdx = content.indexOf(":");
                    if (colonIdx === -1) {
                        return JSON.stringify({
                            success: false,
                            error: "Traits must use 'key: value' format (e.g., 'prefers_dark_mode: true')",
                        });
                    }

                    const traitKey = content.substring(0, colonIdx).trim().replace(/\s+/g, "_").toLowerCase();
                    const traitValue = content.substring(colonIdx + 1).trim();

                    const trait = reinforceTrait(traitKey, traitValue, { explicit: true });
                    if (!trait) {
                        return JSON.stringify({
                            success: false,
                            message: "Per-session cap reached -- trait update skipped.",
                        });
                    }

                    return JSON.stringify({
                        success: true,
                        message: `Trait appended/reinforced: ${trait.trait_key} = ${trait.value} (confidence: ${Math.round(trait.confidence * 100)}%)`,
                    });
                }
                case "preferences": {
                    const kgDb = getKnowledgeGraphDB();
                    if (!kgDb) return JSON.stringify({ success: false, error: "Knowledge graph not available" });

                    // Create a preference entity
                    const entityId = addEntity(kgDb, content, "preference", { value: content, created: Date.now() });

                    return JSON.stringify({
                        success: true,
                        message: `Preference stored: "${content}" (entity ID: ${entityId})`,
                        entityId,
                    });
                }
                default: {
                    // Custom section: store as a memory with category = section
                    const id = await remember(content, section, "", importance);
                    if (id === null) {
                        return JSON.stringify({ success: false, reason: "rejected_by_value_gate" });
                    }
                    return JSON.stringify({
                        success: true,
                        message: `Content appended to section "${section}" (memory ID: ${id})`,
                        id,
                    });
                }
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ── core_memory_delete ───────────────────────────

export const coreMemoryDelete: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "core_memory_delete",
            description:
                "Remove specific content from a core memory section. For 'identity', clears a profile field. For 'traits', deletes a behavioral trait. For 'preferences', removes a preference entity. For custom sections, deletes matching memory entries.",
            parameters: {
                type: "object",
                properties: {
                    section: {
                        type: "string",
                        description: "The memory section: 'identity', 'traits', 'preferences', or custom section name",
                    },
                    content: {
                        type: "string",
                        description:
                            "The content to delete. For identity: field name (e.g., 'location'). For traits: trait_key. For preferences: preference name. For custom sections: exact text match.",
                    },
                },
                required: ["section", "content"],
            },
        },
    },
    async handler(input) {
        if (!isOwnerCaller()) return OWNER_ONLY;
        const section = (input.section as string).toLowerCase().trim();
        const content = input.content as string;

        try {
            switch (section) {
                case "identity": {
                    const profile = getIdentityProfile();
                    const field = content.trim().toLowerCase();

                    // Check known fields
                    const clearableFields = ["email", "name", "location", "role", "company"];
                    if (clearableFields.includes(field)) {
                        updateIdentityProfile({ [field]: undefined } as Record<string, unknown>);
                        return JSON.stringify({
                            success: true,
                            message: `Cleared "${field}" from identity profile`,
                        });
                    }

                    // Check if it's a project or goal to remove
                    if (profile.projects?.includes(content)) {
                        const { removeProject } = await import("../memory/identity.js");
                        removeProject(content);
                        return JSON.stringify({
                            success: true,
                            message: `Removed project "${content}" from identity profile`,
                        });
                    }

                    if (profile.important_goals?.includes(content)) {
                        const { removeGoal } = await import("../memory/identity.js");
                        removeGoal(content);
                        return JSON.stringify({
                            success: true,
                            message: `Removed goal "${content}" from identity profile`,
                        });
                    }

                    // Check extra fields
                    if (profile.extra && content in profile.extra) {
                        const extra = { ...profile.extra };
                        delete extra[content];
                        updateIdentityProfile({ extra });
                        return JSON.stringify({
                            success: true,
                            message: `Removed extra field "${content}" from identity profile`,
                        });
                    }

                    return JSON.stringify({
                        success: false,
                        error: `Field or content "${content}" not found in identity profile`,
                    });
                }
                case "traits": {
                    const traitKey = content.trim().replace(/\s+/g, "_").toLowerCase();
                    const trait = getTrait(traitKey);

                    if (!trait) {
                        return JSON.stringify({
                            success: false,
                            error: `Trait "${traitKey}" not found`,
                        });
                    }

                    deleteTrait(traitKey);
                    return JSON.stringify({
                        success: true,
                        message: `Deleted trait "${traitKey}" (was: ${trait.value}, confidence: ${Math.round(trait.confidence * 100)}%)`,
                    });
                }
                case "preferences": {
                    const kgDb = getKnowledgeGraphDB();
                    if (!kgDb) return JSON.stringify({ success: false, error: "Knowledge graph not available" });

                    const entities = findEntities(kgDb, content, "preference");
                    if (entities.length === 0) {
                        return JSON.stringify({
                            success: false,
                            error: `Preference "${content}" not found`,
                        });
                    }

                    // Invalidate relationships instead of deleting the entity
                    for (const entity of entities) {
                        if (entity.name === content || entity.name.includes(content)) {
                            const rels = getRelationships(kgDb, entity.id, { includeHistory: false });
                            for (const rel of rels) {
                                const { invalidateRelationship } = await import("../memory/knowledge-graph.js");
                                invalidateRelationship(kgDb, rel.relationship.id);
                            }
                            // Mark entity as deleted via properties
                            kgDb.run("UPDATE entities SET properties = ?, updated_at = datetime('now') WHERE id = ?", [
                                JSON.stringify({ ...entity.properties, _deleted: true, _deleted_at: Date.now() }),
                                entity.id,
                            ]);
                            return JSON.stringify({
                                success: true,
                                message: `Preference "${entity.name}" marked as deleted (relationships invalidated)`,
                            });
                        }
                    }

                    return JSON.stringify({
                        success: false,
                        error: `No exact match for preference "${content}"`,
                    });
                }
                default: {
                    // Custom section: find and delete matching memories
                    const memories = listMemories(section, 100);
                    let deleted = false;

                    for (const mem of memories) {
                        if (mem.content === content || mem.content.includes(content)) {
                            if (isKept(mem.id)) return KEPT;
                            forgetMemory(mem.id);
                            deleted = true;
                            break;
                        }
                    }

                    if (!deleted) {
                        return JSON.stringify({
                            success: false,
                            error: `Content "${content}" not found in section "${section}"`,
                        });
                    }

                    return JSON.stringify({
                        success: true,
                        message: `Deleted content from section "${section}"`,
                    });
                }
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};
