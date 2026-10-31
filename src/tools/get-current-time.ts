// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ChatCompletionTool } from "openai/resources/chat/completions.js";

// ── Types ─────────────────────────────────────

export interface ToolDefinition {
    /** OpenAI-compatible tool schema */
    schema: ChatCompletionTool;
    /** Handler function — receives parsed input, returns string result */
    handler: (input: Record<string, unknown>) => Promise<string>;
}

// ── get_current_time ──────────────────────────

export const getCurrentTime: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "get_current_time",
            description:
                "Returns the current date and time in both ISO 8601 and human-readable format, including the local timezone.",
            parameters: {
                type: "object",
                properties: {
                    timezone: {
                        type: "string",
                        description: 'Optional IANA timezone (e.g. "America/New_York"). Defaults to system timezone.',
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        // "local" / "system" mean this Mac's own zone (gpt-4.1-nano's "local" threw).
        const asked = (input.timezone as string) || "";
        const tz = /^(local|system|here|auto|current)$/i.test(asked.trim()) ? undefined : asked || undefined;
        const now = new Date();

        const iso = now.toISOString();
        const human = now.toLocaleString("en-US", {
            timeZone: tz,
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            timeZoneName: "long",
        });

        return JSON.stringify({ iso, human }, null, 2);
    },
};
