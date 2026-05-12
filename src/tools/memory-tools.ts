// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import {
    addGoal,
    addProject,
    exportIdentitySnapshot,
    getIdentityProfile,
    updateIdentityProfile,
} from "../memory/identity.js";
import { forgetMemory, getMemoryStats, listMemories, recall, remember } from "../memory/sqlite.js";
import { exportTraitsSnapshot, getAllTraits, reinforceTrait } from "../memory/traits.js";
import type { ToolDefinition } from "./get-current-time.js";

// ── Memory Tools for LLM ──────────────────────

export const memoryStore: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "memory_store",
            description:
                "Store a fact, preference, or important information in persistent memory. Use this when the user shares something worth remembering.",
            parameters: {
                type: "object",
                properties: {
                    content: { type: "string", description: "The information to remember" },
                    category: {
                        type: "string",
                        description: "Category: general, preference, fact, person, task, note",
                    },
                    tags: { type: "string", description: "Comma-separated tags for easier retrieval" },
                    importance: { type: "number", description: "1-10 importance level (default 5)" },
                },
                required: ["content"],
            },
        },
    },
    async handler(input) {
        const imp = (input.importance as number) || 5;
        // Use smart write (LLM deduplication) for important memories (>= 7)
        const useSmartWrite = imp >= 7;
        const id = remember(
            input.content as string,
            (input.category as string) || "general",
            (input.tags as string) || "",
            imp,
            "user",
            useSmartWrite,
        );
        return JSON.stringify({ success: true, id, message: "Memory stored." });
    },
};

export const memorySearch: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "memory_search",
            description:
                "Search persistent memory for stored facts, preferences, or context. Use this to recall previously stored information.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query" },
                    limit: { type: "number", description: "Max results (default 10)" },
                },
                required: ["query"],
            },
        },
    },
    async handler(input) {
        const results = await recall(input.query as string, (input.limit as number) || 10);
        return JSON.stringify({ results, count: results.length });
    },
};

export const memoryList: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "memory_list",
            description: "List stored memories, optionally filtered by category.",
            parameters: {
                type: "object",
                properties: {
                    category: { type: "string", description: "Filter by category" },
                    limit: { type: "number", description: "Max results (default 20)" },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        const results = listMemories(input.category as string | undefined, (input.limit as number) || 20);
        const stats = getMemoryStats();
        return JSON.stringify({ memories: results, stats });
    },
};

export const memoryDelete: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "memory_delete",
            description: "Delete a specific memory by ID.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "number", description: "Memory ID to delete" },
                },
                required: ["id"],
            },
        },
    },
    async handler(input) {
        const success = forgetMemory(input.id as number);
        return JSON.stringify({ success, message: success ? "Memory deleted." : "Memory not found." });
    },
};

// ── Identity Tools ────────────────────────────

export const identityView: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "identity_view",
            description:
                "View the user's stored identity profile (name, email, location, role, projects, preferences). Use this to check what you already know about the user.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    async handler() {
        const profile = getIdentityProfile();
        return JSON.stringify({ profile });
    },
};

export const identityUpdate: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "identity_update",
            description:
                "Update the user's identity profile when they share personal information (email, name, location, role, company, projects, preferences). Call this PROACTIVELY when the user mentions these details.",
            parameters: {
                type: "object",
                properties: {
                    email: { type: "string", description: "User's email address" },
                    name: { type: "string", description: "User's name" },
                    location: { type: "string", description: "User's location / city / country" },
                    role: { type: "string", description: "User's job role or title" },
                    company: { type: "string", description: "User's company or organization" },
                    project: { type: "string", description: "A project name to ADD to the user's project list" },
                    goal: { type: "string", description: "An important goal to ADD to the user's goals" },
                    communication_style: { type: "string", description: "direct, detailed, casual, formal, etc." },
                    detail_level: {
                        type: "string",
                        description: "high, medium, low — how much detail the user prefers",
                    },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        // Handle project and goal as additive operations
        if (input.project) {
            addProject(input.project as string);
        }
        if (input.goal) {
            addGoal(input.goal as string);
        }

        // Build profile update from remaining fields
        const fields: Record<string, unknown> = {};
        if (input.email) fields.email = input.email;
        if (input.name) fields.name = input.name;
        if (input.location) fields.location = input.location;
        if (input.role) fields.role = input.role;
        if (input.company) fields.company = input.company;

        const preferences: Record<string, string> = {};
        if (input.communication_style) preferences.communication_style = input.communication_style as string;
        if (input.detail_level) preferences.detail_level = input.detail_level as string;
        if (Object.keys(preferences).length > 0) fields.preferences = preferences;

        if (Object.keys(fields).length > 0) {
            updateIdentityProfile(fields);
        }

        const updated = getIdentityProfile();
        return JSON.stringify({ success: true, message: "Identity profile updated.", profile: updated });
    },
};

// ── Trait Tools ───────────────────────────────

export const traitUpdate: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "trait_update",
            description:
                "Record a behavioral trait you've observed about the user (e.g., 'likes_detailed_answers: true', 'risk_tolerance: high'). Call this when you notice consistent patterns. Per-session caps apply (max 5 updates per session).",
            parameters: {
                type: "object",
                properties: {
                    trait_key: {
                        type: "string",
                        description:
                            "Snake_case trait name, e.g. likes_detailed_answers, prefers_execution_over_theory, risk_tolerance",
                    },
                    value: { type: "string", description: "Trait value, e.g. 'true', 'high', 'direct'" },
                    explicit: {
                        type: "boolean",
                        description:
                            "true if user directly stated this (e.g., 'I prefer detailed answers'), false if inferred from behavior",
                    },
                    topics: {
                        type: "string",
                        description: "Comma-separated related topics, e.g. 'coding,design,architecture'",
                    },
                },
                required: ["trait_key", "value"],
            },
        },
    },
    async handler(input) {
        const topics = input.topics ? (input.topics as string).split(",").map((t) => t.trim()) : [];
        const trait = reinforceTrait(input.trait_key as string, input.value as string, {
            explicit: (input.explicit as boolean) ?? false,
            topics,
        });
        if (!trait) {
            return JSON.stringify({ success: false, message: "Per-session cap reached — trait update skipped." });
        }
        return JSON.stringify({
            success: true,
            trait,
            message: `Trait reinforced: ${trait.trait_key} = ${trait.value} (confidence: ${Math.round(trait.confidence * 100)}%)`,
        });
    },
};

export const traitList: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "trait_list",
            description: "List all observed behavioral traits and their confidence scores.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    async handler() {
        const traits = getAllTraits();
        return JSON.stringify({ traits, count: traits.length });
    },
};

// ── Snapshot Tool ─────────────────────────────

export const memorySnapshot: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "memory_snapshot",
            description:
                "Export the full user memory state: identity profile, all behavioral traits with confidence scores and reinforcement counts. Useful for diagnostics and debugging.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    async handler() {
        const identity = exportIdentitySnapshot();
        const traits = exportTraitsSnapshot();
        return JSON.stringify({ identity, traits });
    },
};
