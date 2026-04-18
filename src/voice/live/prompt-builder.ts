// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Prompt Builder — Constructs system prompt for live voice sessions ──

import fs from "node:fs";
import path from "node:path";
import { getFullMemoryContext } from "./memory-bridge.js";

const PROMPTS_DIR = path.resolve("prompts");

// ── Voice Mode Rules ─────────────────────────────

const VOICE_MODE_RULES = `
VOICE MODE — ACTIVE:
You are in LIVE VOICE conversation mode. This is a real-time spoken dialogue.

RESPONSE STYLE:
- Speak naturally and conversationally — short sentences, casual tone
- NEVER use markdown, bullet points, code blocks, or formatted text
- NEVER use emojis in speech
- Keep responses concise — aim for 1-3 sentences unless the user asks for detail
- Use filler words sparingly but naturally: "hmm", "let me think", "oh yeah"
- If you need to convey a list, say "first... second... third..." naturally

ACTION RULES:
- When the user gives a pure action command (play music, open app, set timer, take screenshot), execute it and respond with a BRIEF acknowledgment: "Done", "Playing", "Opening it now"
- For ambiguous actions, ask ONE clarifying question: "Which playlist?" not a paragraph
- When executing tools, your spoken response and the action happen SIMULTANEOUSLY — don't wait for the tool to finish before speaking
- If a tool fails, say so briefly: "That didn't work, let me try again"

INTERRUPTION:
- The user can interrupt you at any time by speaking
- When interrupted, stop immediately and listen to the new input
- Don't say "sorry I was saying..." — just respond to the new input

PERSONALITY:
- Same personality as text mode — you are A.T.L.A.S
- Be warm, genuine, slightly cheeky when appropriate
- React to the user's tone — if they sound excited, match their energy
- If they sound tired or stressed, be calm and supportive
`.trim();

// ── Build System Prompt ──────────────────────────

/**
 * Build the complete system prompt for a live voice session.
 * Combines: identity prompt + voice rules + memory context
 */
export async function buildVoiceSystemPrompt(): Promise<string> {
    const parts: string[] = [];

    // ── Load identity prompt from prompts/ directory ──
    try {
        const identityPath = path.join(PROMPTS_DIR, "identity.md");
        if (fs.existsSync(identityPath)) {
            parts.push(fs.readFileSync(identityPath, "utf-8").trim());
        }
    } catch { /* */ }

    // ── Load platform rules ──
    try {
        const rulesPath = path.join(PROMPTS_DIR, "rules.md");
        if (fs.existsSync(rulesPath)) {
            parts.push(fs.readFileSync(rulesPath, "utf-8").trim());
        }
    } catch { /* */ }

    try {
        const macRulesPath = path.join(PROMPTS_DIR, "rules-mac.md");
        if (process.platform === "darwin" && fs.existsSync(macRulesPath)) {
            parts.push(fs.readFileSync(macRulesPath, "utf-8").trim());
        }
    } catch { /* */ }

    // ── Voice mode specific rules ──
    parts.push(VOICE_MODE_RULES);

    // ── Memory context ──
    try {
        const memoryContext = await getFullMemoryContext();
        if (memoryContext) parts.push(memoryContext);
    } catch (err) {
        console.warn("[LIVE] Memory context retrieval failed:", (err as Error).message);
    }

    return parts.join("\n\n");
}
