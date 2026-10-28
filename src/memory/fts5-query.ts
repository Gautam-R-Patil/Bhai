// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Auto-quotes hyphenated/dotted tokens so FTS5's unicode61 and trigram
// tokenizers don't split them into un-searchable parts.

const PHRASE_PLACEHOLDER = "\x00Q";

/** Extract balanced "…" phrases; replace with `\x00Q{i}\x00` placeholders. */
function protectQuotedPhrases(input: string): {
    masked: string;
    phrases: string[];
} {
    const phrases: string[] = [];
    let masked = "";
    let i = 0;
    while (i < input.length) {
        const ch = input[i];
        if (ch === '"') {
            // Look for a matching close quote on the same line.
            const close = input.indexOf('"', i + 1);
            if (close > i) {
                const phrase = input.slice(i, close + 1);
                masked += `${PHRASE_PLACEHOLDER}${phrases.length}\x00`;
                phrases.push(phrase);
                i = close + 1;
                continue;
            }
            // Unbalanced — drop this quote character so the FTS5 parser is safe.
            i += 1;
            continue;
        }
        masked += ch;
        i += 1;
    }
    return { masked, phrases };
}

/** Restore placeholders to their original phrase content. */
function restorePhrases(text: string, phrases: string[]): string {
    return text.replace(
        new RegExp(`${PHRASE_PLACEHOLDER.replace(/\x00/g, "\\x00")}(\\d+)\\x00`, "g"),
        (_m, idxStr: string) => phrases[Number.parseInt(idxStr, 10)] ?? "",
    );
}

// ── Main sanitizer ─────────────────────────────

/**
 * Characters the raw FTS5 parser treats as operators or would reject mid-token.
 * After phrase protection, any of these appearing outside a placeholder is
 * stripped. We keep `-` and `.` so they can flow through the hyphen/dot
 * auto-quote pass below.
 */
const FTS5_OPERATOR_CHARS = /[*^~+(){}\[\]:]/g;

/** Tokens that look like `foo-bar`, `foo.bar.baz`, `src/foo.ts` — quote them. */
const HYPHENDOT_TOKEN_RE = /(^|\s)([^\s"\x00]*[-./][^\s"\x00]*)/g; // \x00 = quoted-phrase placeholder

/**
 * Sanitize a user-supplied query for safe use against SQLite FTS5.
 *
 * Returns a valid FTS5 MATCH expression (possibly empty). Callers should
 * short-circuit on an empty-string return.
 */
export function sanitizeFts5Query(input: string): string {
    if (typeof input !== "string" || !input.trim()) return "";

    // 1. Protect balanced quoted phrases first — these pass through untouched.
    const { masked, phrases } = protectQuotedPhrases(input);

    // 2. Strip operator characters — and any other punctuation: a bare FTS5
    //    term may only hold letters and digits, so "what's" or "word?" was a
    //    syntax error and the memory search silently found nothing. A user's
    //    "NOT"/"AND" is a word, not an operator.
    let body = masked
        .replace(FTS5_OPERATOR_CHARS, " ")
        .replace(/[^\p{L}\p{M}\p{N}\s"._\-/\x00]/gu, " ") // \p{M}: matras, virama, harakat are part of words
        .replace(/\b(AND|OR|NOT|NEAR)\b/g, (w) => w.toLowerCase());

    // 3. A quoted phrase glued to a word ("config"/settings) is two terms:
    //    split them, or the leftover "/settings" is an FTS5 syntax error.
    //    Then collapse runs of whitespace.
    body = body.replace(/\x00[^\x00]*\x00/g, " $& ").replace(/\s+/g, " ").trim();

    // 4. Auto-quote hyphenated / dotted tokens so the FTS5 tokenizer doesn't
    //    split them. Skip tokens that are purely separator noise (`.`/`-`).
    body = body.replace(HYPHENDOT_TOKEN_RE, (_m, lead: string, token: string) => {
        // If the token is entirely made of separators, drop it.
        if (!/[^\-./]/.test(token)) return lead;
        // Already-protected placeholders won't match this regex (they contain
        // \x00), so this only fires on real tokens.
        return `${lead}"${token}"`;
    });

    // 5. Restore balanced quoted phrases.
    const restored = restorePhrases(body, phrases);

    // 6. Final whitespace trim.
    return restored.trim();
}

// ── CJK detection ──────────────────────────────

/**
 * True when the input contains any Han / Hiragana / Katakana / Hangul
 * character. Used to route a query to the trigram FTS5 table — the default
 * unicode61 tokenizer splits CJK into single-character tokens, which makes
 * multi-character phrase matches degenerate into "c1 AND c2 AND c3".
 */
export function containsCjk(input: string | null | undefined): boolean {
    if (!input) return false;
    return /[぀-ヿ㐀-鿿가-힯]/u.test(input);
}

// ── Trigram tokenizer helper ──────────────────

/**
 * Split a CJK query into tokens ≥ 2 characters long. Tokens of length 1 are
 * dropped because the SQLite FTS5 trigram tokenizer produces overlapping
 * 3-byte sequences — a single-char token resolves to a zero-length
 * comparison and matches nothing useful.
 */
export function tokensForTrigram(input: string): string[] {
    if (!input) return [];
    return input
        .split(/\s+/)
        .map((t) => t.replace(FTS5_OPERATOR_CHARS, "").trim())
        .filter((t) => t.length >= 2);
}

/**
 * Build an FTS5 MATCH expression joining trigram tokens with AND. Each token
 * is double-quoted so FTS5 treats it as a phrase (required for trigram
 * substring matching). Returns "" when no tokens survive.
 */
export function buildTrigramQuery(input: string): string {
    const tokens = tokensForTrigram(input);
    if (tokens.length === 0) return "";
    return tokens.map((t) => `"${t}"`).join(" AND ");
}
