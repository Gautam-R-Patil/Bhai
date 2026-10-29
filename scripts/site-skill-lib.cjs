// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// Helpers every Site Skill gets as step()'s third argument (the host shim
// passes it in): step(phase, ctx, lib). Pure functions, no I/O, so a skill
// stays a pure function of (phase, snapshot).
//
//   lib.path(url)              → "/results" ("" for a bad URL)
//   lib.el(snapshot, pred)     → first element matching pred (a function, or
//                                {field: value | RegExp}), else undefined
//   lib.price(text)            → rupees as a number (₹1,249.50 → 1249.5), else undefined
//   lib.fold(text)             → comparable text: case, accents, punctuation and
//                                spacing folded away; Indic scripts kept intact
//   lib.sameText(shown, want)  → shown and want read the same after fold()
//   lib.rank(choices, want)    → { best, ambiguous, ranked } for picking the one
//                                choice the owner meant, or knowing it isn't clear

function path(url) {
    try {
        return new URL(url).pathname;
    } catch {
        return "";
    }
}

function el(snapshot, pred) {
    const els = snapshot?.elements || [];
    if (typeof pred === "function") return els.find(pred);
    const want = Object.entries(pred || {});
    return els.find((e) => want.every(([k, v]) => (v instanceof RegExp ? v.test(String(e[k] ?? "")) : e[k] === v)));
}

const MONEY = /(?:₹|\brs\.?|\binr)\s*([\d,]+(?:\.\d+)?)/i;
function price(text) {
    const m = MONEY.exec(String(text ?? ""));
    if (!m) return undefined;
    const n = Number(m[1].replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
}

// Only Latin combining accents (U+0300–U+036F) are dropped: Devanagari vowel
// signs are marks too, and dropping them would turn पनीर into पनर.
function fold(text) {
    return String(text ?? "")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
        .trim();
}

function sameText(shown, wanted) {
    const a = fold(shown);
    return a !== "" && a === fold(wanted);
}

// A choice's label without its price ("Paneer Tikka — ₹249" reads "paneer tikka").
const PRICES = /(?:₹|\brs\.?|\binr)\s*[\d,]+(?:\.\d+)?/gi;
const labelOf = (c) =>
    fold(String(typeof c === "string" ? c : ((c && (c.label ?? c.text)) ?? "")).replace(PRICES, " "));

// How well a shown label fits what the owner asked for:
//   3 the same text; 2 the same words in another order; 1 every asked word is
//   a whole word of the label; 0 no fit. Within a tier nothing breaks ties: two
//   labels that fit equally well are ambiguous, never a guess ("paneer" against
//   "Paneer Tikka" and "Paneer Butter Masala" is a question for the owner).
function score(label, want, wantWords) {
    if (!label || !want) return 0;
    if (label === want) return 3;
    const words = label.split(" ");
    const set = new Set(words);
    if (!wantWords.every((w) => set.has(w))) return 0;
    if (words.length === wantWords.length && [...words].sort().join(" ") === [...wantWords].sort().join(" ")) return 2;
    return 1;
}

function rank(choices, wanted) {
    const want = fold(wanted);
    const wantWords = want ? want.split(" ") : [];
    const ranked = (choices || [])
        .map((choice) => ({ choice, score: score(labelOf(choice), want, wantWords) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score); // stable: page order within a tier
    const top = ranked.filter((r) => r.score === ranked[0]?.score).map((r) => r.choice);
    return { best: top.length === 1 ? top[0] : null, ambiguous: top.length > 1 ? top : [], ranked };
}

module.exports = { path, el, price, fold, sameText, rank };
