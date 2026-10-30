// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { detectEmotion } from "../social/emotion-detector.js";
import {
    assembleDynamicPrompt,
    detectTaskType,
    type PromptContext,
} from "./dynamic-assembler.js";
import type { Persona } from "./persona-bias.js";

export interface DynamicContextOpts {
    hour?: number;
    isProactive?: boolean;
    activeSkills?: string[];
    persona?: Persona;          // W2: piped through to PromptContext.persona
}

const ASKS =
    /\?|\b(can you|could you|would you|please|pls|help|fix|check|look into|how (do|can|to)|what (should|do|can)|why|should i|tell me|find|make|open|send|show|remind|draft|write|book|order)\b/i;

/** Unhappy, and not asking for anything: heard, not helped. */
export function isVenting(message: string, valence: number): boolean {
    return valence <= -0.3 && !ASKS.test(message);
}

export function buildDynamicContextReminder(
    userMessage: string,
    opts: DynamicContextOpts = {},
): string {
    const hour = opts.hour ?? new Date().getHours();
    const emotion = userMessage ? detectEmotion(userMessage) : null;
    const ctx: PromptContext = {
        taskType: detectTaskType(userMessage ?? ""),
        userEmotionalState: emotion?.primary ?? "neutral",
        venting: !!emotion && isVenting(userMessage, emotion.valence),
        hour,
        isProactive: opts.isProactive,
        activeSkills: opts.activeSkills,
        persona: opts.persona,    // W2
    };

    return assembleDynamicPrompt(ctx);
}
