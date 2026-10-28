// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { rateDecision } from "./userAddenda";

describe("addendum write budget", () => {
    const agent = Array(10).fill("learned-skill");
    const settings = Array(10).fill("user-personality");

    it("a Settings change still lands after the agent used its 10 writes", () => {
        expect(rateDecision("user-personality", [...agent, ...settings]).allowed).toBe(true);
    });

    it("Settings changes don't use up the agent's budget", () => {
        expect(rateDecision("learned-skill", [...settings, ...Array(9).fill("x")]).allowed).toBe(true);
        expect(rateDecision("learned-skill", [...settings, ...agent])).toMatchObject({ allowed: false, recent: 10, max: 10 });
    });

    it("Settings changes have their own cap", () => {
        expect(rateDecision("user-personality", Array(50).fill("user-personality"))).toMatchObject({ allowed: false, max: 50 });
    });
});
