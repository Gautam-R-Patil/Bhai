// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Swarm Direct-Execute Gate (pure, no dependencies) ─────
//
// Cheap heuristic: is this task worth swarm decomposition? Returns true
// when the task is so simple that running it through swarm would add 6-10 s
// of orchestration + 3× tokens for zero parallelism benefit.
//
// Kept in its own dependency-free module so tests can import it without
// pulling in the agent/mesh/sub-agent chain.
//
// Research: Hockeystack / Netguru / Anthropic multi-agent all converge on
// "direct-execute for single-verb tasks, decompose only when there are
// ≥3 independent sub-tasks or a clear multi-skill structure."

export function isTriviallyDirectExecutable(task: string): boolean {
    if (!task) return false;
    const taskLower = task.toLowerCase().trim();
    const wordCount = taskLower.split(/\s+/).filter(Boolean).length;
    if (wordCount >= 8) return false;
    const hasMultiClauseMarker =
        /\b(?:and also|then also|also,|additionally|meanwhile|in parallel|simultaneously|after that)\b/i.test(task);
    if (hasMultiClauseMarker) return false;
    const verbMatches = taskLower.match(
        /\b(?:research|search|find|write|create|build|send|check|schedule|open|play|install|download|upload|summarize|analyze|generate|refactor|debug|fix)\b/g,
    );
    if (verbMatches && verbMatches.length > 1) return false;
    return true;
}
