// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
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

export function buildDynamicContextReminder(
    userMessage: string,
    opts: DynamicContextOpts = {},
): string {
    const hour = opts.hour ?? new Date().getHours();
    const emotion = userMessage ? detectEmotion(userMessage) : null;
    const ctx: PromptContext = {
        taskType: detectTaskType(userMessage ?? ""),
        userEmotionalState: emotion?.primary ?? "neutral",
        hour,
        isProactive: opts.isProactive,
        activeSkills: opts.activeSkills,
        persona: opts.persona,    // W2
    };

    return assembleDynamicPrompt(ctx);
}
