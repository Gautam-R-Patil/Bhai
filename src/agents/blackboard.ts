// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Shared Blackboard ────────────────────────
// Per-swarm shared mutable context that allows sub-agents in different
// waves to share discoveries with non-dependent peers.
// Entries are namespaced by step ID to prevent collisions.

// ── Types ────────────────────────────────────

export interface BlackboardEntry {
    key: string;
    value: string;
    writtenBy: string;          // step ID
    writtenAt: number;          // timestamp
}

// ── Blackboard Class ─────────────────────────

export class Blackboard {
    private entries = new Map<string, BlackboardEntry>();

    /** Write a key-value pair to the blackboard. */
    write(key: string, value: string, stepId: string): void {
        const namespacedKey = `${stepId}/${key}`;
        this.entries.set(namespacedKey, {
            key: namespacedKey,
            value,
            writtenBy: stepId,
            writtenAt: Date.now(),
        });
        // Also store with the bare key for cross-step reading
        this.entries.set(key, {
            key,
            value,
            writtenBy: stepId,
            writtenAt: Date.now(),
        });
    }

    /** Read a value by key. Returns undefined if not found. */
    read(key: string): string | undefined {
        return this.entries.get(key)?.value;
    }

    /** List all entries, optionally filtered by writing step. */
    list(filterByStep?: string): BlackboardEntry[] {
        const all = [...this.entries.values()];
        if (filterByStep) {
            return all.filter(e => e.writtenBy === filterByStep);
        }
        // Deduplicate: prefer bare keys over namespaced ones
        const seen = new Set<string>();
        return all.filter(e => {
            if (e.key.includes("/")) return false; // skip namespaced duplicates
            if (seen.has(e.key)) return false;
            seen.add(e.key);
            return true;
        });
    }

    /** Get a formatted summary of all entries for injection into agent context. */
    getSummary(): string {
        const entries = this.list();
        if (entries.length === 0) return "";

        return "[SHARED CONTEXT from other agents]\n" +
            entries.map(e => `- ${e.key} (from ${e.writtenBy}): ${e.value.substring(0, 200)}`).join("\n") +
            "\n[END SHARED CONTEXT]";
    }

    /** Total number of unique entries. */
    get size(): number {
        return this.list().length;
    }

    /** Clear all entries (called when swarm completes). */
    clear(): void {
        this.entries.clear();
    }
}

// ── Tool Schemas for Sub-Agent Integration ───

import type { ChatCompletionTool } from "../llm.js";

export const BLACKBOARD_WRITE_SCHEMA: ChatCompletionTool = {
    type: "function",
    function: {
        name: "blackboard_write",
        description: "Share a discovery or finding with other agents working on related tasks. Use this when you find something that might be useful for other parts of the task.",
        parameters: {
            type: "object",
            properties: {
                key: {
                    type: "string",
                    description: "A short descriptive key for the finding (e.g., 'api_endpoint', 'user_email')",
                },
                value: {
                    type: "string",
                    description: "The finding or information to share",
                },
            },
            required: ["key", "value"],
        },
    },
};

export const BLACKBOARD_READ_SCHEMA: ChatCompletionTool = {
    type: "function",
    function: {
        name: "blackboard_read",
        description: "Read shared context from other agents. Call without a key to see all available shared information.",
        parameters: {
            type: "object",
            properties: {
                key: {
                    type: "string",
                    description: "Optional: specific key to read. Omit to list all entries.",
                },
            },
        },
    },
};
