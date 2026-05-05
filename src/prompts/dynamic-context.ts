// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { detectEmotion } from "../social/emotion-detector.js";
import {
    assembleDynamicPrompt,
    detectTaskType,
    type PromptContext,
} from "./dynamic-assembler.js";

export interface DynamicContextOpts {
    hour?: number;
    isProactive?: boolean;
    relationshipDepth?: number;
    activeSkills?: string[];
    preferredLength?: "terse" | "normal" | "detailed";
}

// Map the emotion-detector's primary label into the slots dynamic-assembler's
// tone_empathetic module expects. Everything unmapped falls through as-is so
// downstream modules can still read it without breaking.
const EMOTION_TO_PROMPT_STATE: Record<string, string> = {
    frustrated: "frustrated",
    angry: "frustrated",
    stressed: "stressed",
    confused: "stressed",
};

export function buildDynamicContextReminder(
    userMessage: string,
    opts: DynamicContextOpts = {},
): string {
    const hour = opts.hour ?? new Date().getHours();
    const emotion = userMessage ? detectEmotion(userMessage) : null;
    const primary = emotion?.primary ?? "neutral";

    const ctx: PromptContext = {
        taskType: detectTaskType(userMessage ?? ""),
        userEmotionalState: EMOTION_TO_PROMPT_STATE[primary] ?? primary,
        hour,
        isProactive: opts.isProactive,
        relationshipDepth: opts.relationshipDepth,
        activeSkills: opts.activeSkills,
        preferredLength: opts.preferredLength,
    };

    return assembleDynamicPrompt(ctx);
}
