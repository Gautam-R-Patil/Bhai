// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Evidence-phrase gate ────────────────────────────────────────
// Destructive git operations (`reset`, `clean`, `push --force`) in
// git_op require an `evidence_phrase` that the agent fills in from
// the user's turn. The original check was a plain substring test —
// which a prompt-injected agent could satisfy by quoting negative
// context ("don't force push", "never reset --hard") back into the
// tool call. The needle survives the includes() test and the gate
// opens even though the user clearly asked NOT to do the operation.
//
// This module strengthens the check with a negation scan: if any
// common negation keyword appears within a 30-character window BEFORE
// the needle, the gate refuses. 30 chars roughly covers a short
// natural-language clause ("I don't want to force push", "please do
// not reset hard"), while letting legitimate positive phrasings
// ("force push to main please", "yes, reset hard") pass.
//
// Extracted from git-op.ts so the rule is testable in isolation.
//
// Design notes:
//   * The needle is case-insensitively matched against the phrase,
//     but we scan for negations in the lowercased phrase too so the
//     rule doesn't care about "Don't" vs "don't" vs "DON'T".
//   * Trailing-space patterns like "not " / "no " prevent partial-
//     word false positives — "note", "notable", "nobody" etc. all
//     contain "not" or "no" but not "not " / "no " with a space.
//   * We scan for negations for EVERY occurrence of the needle —
//     a phrase like "I won't reset hard but also reset hard please"
//     would still reject because the first occurrence is preceded
//     by a negation, and once ANY occurrence is negated we treat
//     the phrase as ambiguous and require rephrasing.

const NEGATION_KEYWORDS = [
    "don't ",
    "do not ",
    "dont ",
    "never ",
    "no ",
    "not ",
    "shouldn't ",
    "should not ",
    "shouldnt ",
    "won't ",
    "will not ",
    "wont ",
    "can't ",
    "cannot ",
    "cant ",
    "avoid ",
    "stop ",
    "skip ",
    "prevent ",
] as const;

/** Size of the look-behind window (in chars) for negation keywords. */
const NEGATION_WINDOW_CHARS = 30;

/**
 * Check whether an evidence phrase authorizes a destructive operation
 * whose needle is the given short token (e.g. "force push",
 * "reset hard"). Returns an error string when the check fails, or
 * `null` when the phrase is acceptable.
 *
 * Callers should treat any non-null return as a hard gate failure.
 */
export function checkEvidencePhrase(phrase: string | undefined | null, needle: string): string | null {
    const trimmed = (phrase ?? "").trim().toLowerCase();
    if (!trimmed) {
        return `evidence_phrase required (must include substring: "${needle}")`;
    }

    const needleLower = needle.toLowerCase();
    if (!trimmed.includes(needleLower)) {
        return `evidence_phrase must contain the substring "${needle}"`;
    }

    // Scan every occurrence of the needle for a negation keyword in
    // the preceding window. Any match anywhere → reject as ambiguous.
    let searchFrom = 0;
    while (searchFrom < trimmed.length) {
        const idx = trimmed.indexOf(needleLower, searchFrom);
        if (idx === -1) break;

        const windowStart = Math.max(0, idx - NEGATION_WINDOW_CHARS);
        const contextBefore = trimmed.slice(windowStart, idx);

        for (const kw of NEGATION_KEYWORDS) {
            if (contextBefore.includes(kw)) {
                return (
                    `evidence_phrase contains a negation ("${kw.trim()}") near "${needle}" — ` +
                    `this is usually a sign the user did NOT authorize the operation. ` +
                    `Re-ask the user for explicit confirmation and pass their exact affirming words.`
                );
            }
        }

        searchFrom = idx + needleLower.length;
    }

    return null;
}
