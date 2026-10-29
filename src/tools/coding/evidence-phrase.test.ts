// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { checkEvidencePhrase } from "./evidence-phrase.js";

describe("checkEvidencePhrase", () => {
    describe("basic gating", () => {
        it("rejects empty phrase", () => {
            const err = checkEvidencePhrase("", "force push");
            expect(err).not.toBeNull();
            expect(err).toMatch(/required/);
        });

        it("rejects undefined phrase", () => {
            const err = checkEvidencePhrase(undefined, "force push");
            expect(err).not.toBeNull();
        });

        it("rejects null phrase", () => {
            const err = checkEvidencePhrase(null, "force push");
            expect(err).not.toBeNull();
        });

        it("rejects whitespace-only phrase", () => {
            const err = checkEvidencePhrase("   \t  \n  ", "force push");
            expect(err).not.toBeNull();
            expect(err).toMatch(/required/);
        });

        it("rejects phrase missing the needle entirely", () => {
            const err = checkEvidencePhrase("yes do the thing", "force push");
            expect(err).not.toBeNull();
            expect(err).toMatch(/must contain the substring/);
        });

        it("accepts the bare needle alone", () => {
            expect(checkEvidencePhrase("force push", "force push")).toBeNull();
        });

        it("accepts the needle with affirmative context", () => {
            expect(checkEvidencePhrase("yes, force push", "force push")).toBeNull();
            expect(checkEvidencePhrase("please force push to main", "force push")).toBeNull();
            expect(checkEvidencePhrase("go ahead and force push", "force push")).toBeNull();
        });

        it("is case-insensitive for the needle match", () => {
            expect(checkEvidencePhrase("FORCE PUSH", "force push")).toBeNull();
            expect(checkEvidencePhrase("Force Push", "force push")).toBeNull();
        });
    });

    describe("negation detection — the regression the audit flagged", () => {
        it("rejects 'don't force push'", () => {
            const err = checkEvidencePhrase("don't force push", "force push");
            expect(err).not.toBeNull();
            expect(err).toMatch(/negation/);
        });

        it("rejects 'do not force push'", () => {
            const err = checkEvidencePhrase("please do not force push", "force push");
            expect(err).not.toBeNull();
            expect(err).toMatch(/negation/);
        });

        it("rejects 'never force push'", () => {
            const err = checkEvidencePhrase("never force push to main", "force push");
            expect(err).not.toBeNull();
        });

        it("rejects 'don't' anywhere in the preceding window", () => {
            // Audit example: prompt-injected agent extracts "force push"
            // from "I don't ever want to force push this code".
            const err = checkEvidencePhrase("I don't ever force push", "force push");
            expect(err).not.toBeNull();
        });

        it("rejects 'not' with trailing space (word boundary)", () => {
            expect(checkEvidencePhrase("I will not force push", "force push")).not.toBeNull();
        });

        it("rejects 'won't', 'can't', 'shouldn't'", () => {
            expect(checkEvidencePhrase("I won't force push", "force push")).not.toBeNull();
            expect(checkEvidencePhrase("can't force push sorry", "force push")).not.toBeNull();
            expect(checkEvidencePhrase("shouldn't force push here", "force push")).not.toBeNull();
        });

        it("rejects 'avoid', 'stop', 'skip', 'prevent'", () => {
            expect(checkEvidencePhrase("avoid force push", "force push")).not.toBeNull();
            expect(checkEvidencePhrase("stop force push", "force push")).not.toBeNull();
            expect(checkEvidencePhrase("skip the force push", "force push")).not.toBeNull();
            expect(checkEvidencePhrase("prevent force push on main", "force push")).not.toBeNull();
        });

        it("rejects negation-then-needle even with padding", () => {
            // 30-char window should catch negations with modest padding.
            expect(checkEvidencePhrase("we must not just force push", "force push")).not.toBeNull();
        });
    });

    describe("no false positives on negation-LOOKING words", () => {
        it("accepts 'note' (contains 'not' but not 'not ')", () => {
            // Tests the trailing-space discipline on "not ".
            expect(checkEvidencePhrase("note to self: force push allowed", "force push")).toBeNull();
        });

        it("accepts 'notable' (contains 'not' but not 'not ')", () => {
            expect(checkEvidencePhrase("notable: yes force push", "force push")).toBeNull();
        });

        it("accepts 'nobody' (contains 'no' but not 'no ')", () => {
            expect(checkEvidencePhrase("nobody else, force push now", "force push")).toBeNull();
        });

        it("accepts 'stopped' (contains 'stop' but not 'stop ')", () => {
            expect(checkEvidencePhrase("stopped waiting, force push", "force push")).toBeNull();
        });
    });

    describe("negation window semantics", () => {
        it("negation AFTER the needle does NOT reject (window is look-behind only)", () => {
            // "force push, don't worry about the downstream" is clearly
            // asking for force push. The don't is after.
            expect(checkEvidencePhrase("force push, don't worry about downstream", "force push")).toBeNull();
        });

        it("far-away negation (>30 chars before) does NOT reject", () => {
            // A "don't" far earlier shouldn't trip the check.
            const prefix = "I don't want to skip the deploy; also run tests; ";
            expect(prefix.length).toBeGreaterThan(30);
            expect(checkEvidencePhrase(`${prefix}force push when ready`, "force push")).toBeNull();
        });

        it("negation exactly inside the window is rejected", () => {
            // 30-char window. "don't do this: " is 15 chars, so needle
            // is 15 chars from the "don't" — inside the window.
            expect(checkEvidencePhrase("don't do this: force push", "force push")).not.toBeNull();
        });
    });

    describe("multiple needle occurrences", () => {
        it("rejects if ANY occurrence is negated", () => {
            // First occurrence is negated; second is affirmative.
            // We reject on ambiguity — force the user to re-confirm
            // with clearer language.
            const phrase = "don't force push to main, but force push to feature-branch";
            expect(checkEvidencePhrase(phrase, "force push")).not.toBeNull();
        });

        it("accepts when all occurrences are clean", () => {
            expect(checkEvidencePhrase("force push to main, then force push to release", "force push")).toBeNull();
        });
    });

    describe("other needles", () => {
        it("same rules apply to 'reset hard'", () => {
            expect(checkEvidencePhrase("reset hard please", "reset hard")).toBeNull();
            expect(checkEvidencePhrase("don't reset hard", "reset hard")).not.toBeNull();
            expect(checkEvidencePhrase("never reset hard", "reset hard")).not.toBeNull();
        });

        it("same rules apply to 'clean force'", () => {
            expect(checkEvidencePhrase("clean force now", "clean force")).toBeNull();
            expect(checkEvidencePhrase("don't clean force", "clean force")).not.toBeNull();
        });
    });

    describe("error message format", () => {
        it("names the specific negation keyword in the error", () => {
            const err = checkEvidencePhrase("I don't force push", "force push");
            expect(err).toMatch(/don't/);
        });

        it("includes the needle in every failure message", () => {
            expect(checkEvidencePhrase("", "force push")).toMatch(/force push/);
            expect(checkEvidencePhrase("unrelated text", "force push")).toMatch(/force push/);
            expect(checkEvidencePhrase("don't force push", "force push")).toMatch(/force push/);
        });
    });
});
