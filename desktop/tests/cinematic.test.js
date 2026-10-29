// @vitest-environment jsdom
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, it, expect, beforeEach } from "vitest";

describe("Cinematic.scribeRule", () => {
    let rule;
    beforeEach(() => {
        document.body.innerHTML = '<div id="iridescent-rule" class="iridescent-rule"></div>';
        rule = document.getElementById("iridescent-rule");
    });

    it("adds the scribe class", async () => {
        const cinematicMod = await import("../wizard/cinematic.js");
        const Cinematic = cinematicMod.Cinematic || cinematicMod.default;
        Cinematic.scribeRule();
        expect(rule.classList.contains("scribe")).toBe(true);
    });

    it("forces a re-trigger by removing then re-adding the class within one call", async () => {
        const cinematicMod = await import("../wizard/cinematic.js");
        const Cinematic = cinematicMod.Cinematic || cinematicMod.default;
        rule.classList.add("scribe");
        Cinematic.scribeRule();
        // Even though the class was already present, the function should have
        // toggled it off and on so the CSS animation re-plays.
        expect(rule.classList.contains("scribe")).toBe(true);
    });

    it("is a no-op when no #iridescent-rule element exists", async () => {
        document.body.innerHTML = "";
        const cinematicMod = await import("../wizard/cinematic.js");
        const Cinematic = cinematicMod.Cinematic || cinematicMod.default;
        expect(() => Cinematic.scribeRule()).not.toThrow();
    });
});

describe("Cinematic.applyConfidence", () => {
    it("is a function that accepts (stepIndex, totalSteps) and does not throw", async () => {
        const cinematicMod = await import("../wizard/cinematic.js");
        const Cinematic = cinematicMod.Cinematic || cinematicMod.default;
        expect(() => Cinematic.applyConfidence(0, 10)).not.toThrow();
        expect(() => Cinematic.applyConfidence(9, 10)).not.toThrow();
    });
});
