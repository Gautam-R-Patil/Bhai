// Tests the persona-aware pickPrompts.
import { describe, it, expect } from "vitest";

// try-this.js is an IIFE that attaches to window.TryThis. Load it into
// a sham window then grab the API.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, "..", "components", "try-this.js"), "utf8");
const win = {};
new Function("window", src)(win);
const { pickPrompts } = win.TryThis;

describe("pickPrompts — persona prefix", () => {
    it("prepends developer prompts when persona=developer", () => {
        const out = pickPrompts({ profile: { persona: "developer" } }, undefined, 1);
        expect(out.length).toBe(3);
        // At least one of the first two must be a developer-flavored prompt.
        const devSignals = ["codebase", "test suite", "PR", "TODO"];
        const hasDev = out.slice(0, 2).some(p => devSignals.some(s => p.includes(s)));
        expect(hasDev).toBe(true);
    });

    it("prepends founder prompts when persona=founder", () => {
        const out = pickPrompts({ profile: { persona: "founder" } }, undefined, 2);
        expect(out.length).toBe(3);
        const founderSignals = ["meeting", "Slack", "investor", "calendar"];
        const hasFounder = out.slice(0, 2).some(p => founderSignals.some(s => p.includes(s)));
        expect(hasFounder).toBe(true);
    });

    it("explorer adds no persona prompts — falls back to generic", () => {
        const out = pickPrompts({ profile: { persona: "explorer" } }, undefined, 3);
        expect(out.length).toBe(3);
        // All three should be from the overlay pool (no explorer entries exist).
        const devSignals = ["codebase", "test suite", "investor", "moodboard"];
        const hasPersona = out.some(p => devSignals.some(s => p.includes(s)));
        expect(hasPersona).toBe(false);
    });

    it("no persona — pure generic", () => {
        const out = pickPrompts({}, undefined, 4);
        expect(out.length).toBe(3);
        const personaSignals = ["codebase", "investor", "moodboard", "literature map"];
        const hasPersona = out.some(p => personaSignals.some(s => p.includes(s)));
        expect(hasPersona).toBe(false);
    });

    it("dedupes between persona + generic pools", () => {
        const out = pickPrompts({ profile: { persona: "developer" } }, undefined, 5);
        const uniq = new Set(out);
        expect(uniq.size).toBe(out.length);
    });

    it("deterministic given a seed", () => {
        const a = pickPrompts({ profile: { persona: "founder" } }, undefined, 42);
        const b = pickPrompts({ profile: { persona: "founder" } }, undefined, 42);
        expect(a).toEqual(b);
    });
});
