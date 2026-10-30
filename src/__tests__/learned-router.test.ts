// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

process.env.ATLAS_DATA_DIR = mkdtempSync(join(tmpdir(), "bhai-router-"));
const r = await import("../routing/learned-router.js");

const DAY = 24 * 60 * 60 * 1000;
const noExplore = () => 0.99; // rand() ≥ 5%: never explores
const pick = (cls: Parameters<typeof r.chooseArm>[0], now?: number) =>
    r.chooseArm(cls, { lowRisk: true, rand: noExplore, now }).arm.id;

describe("learned router", () => {
    beforeEach(() => r.resetRouterForTests());

    it("starts from the eval: the cheapest model that is about as good as the best", () => {
        expect(pick("quick")).toBe("gpt-4.1-nano"); // 12/12, fewest calls, fastest
        expect(pick("desktop")).toBe("haiku"); // 7/7 on multi-step; nano 3/7 is out
        // Unmeasured kinds start where the old rules stood.
        expect(pick("chat")).toBe("haiku");
        expect(pick("general")).toBe("haiku");
        expect(pick("coding")).toBe("sonnet");
        // Web lookups: both passed every one, Haiku at a fifteenth of the cost.
        expect(pick("browser")).toBe("haiku");
    });

    it("two failures don't write a model off, and it recovers as the evidence fades", () => {
        const t0 = Date.now();
        for (let i = 0; i < 2; i++) r.recordOutcome("quick", "gpt-4.1-nano", { success: 0, failure: 1, calls: 3, seconds: 6 }, t0);
        const nano = () => r.estimates("quick", t0).find((e) => e.arm.id === "gpt-4.1-nano")!;
        expect(nano().p).toBeGreaterThan(0.6); // still a good model, just not the first pick now
        expect(pick("quick", t0)).toBe("haiku");
        expect(pick("quick", t0 + 90 * DAY)).toBe("gpt-4.1-nano"); // 90 days on, those two failures barely count
    });

    it("learns from real turns: a model that keeps succeeding wins over its prior", () => {
        const t0 = Date.now();
        for (let i = 0; i < 15; i++) r.recordOutcome("desktop", "gpt-4o-mini", { success: 1, failure: 0, calls: 3, seconds: 7 }, t0);
        expect(pick("desktop", t0)).toBe("gpt-4o-mini");
    });

    it("doesn't hold a provider error, a fallback or a cancel against the model", () => {
        expect(r.turnOutcome({ verified: false, stuck: true, infra: true, calls: 1, seconds: 30 })).toBeNull();
        expect(r.turnOutcome({ verified: true, stuck: false, infra: false, calls: 2, seconds: 5 })?.success).toBe(1);
        expect(r.turnOutcome({ verified: false, stuck: false, infra: false, calls: 2, seconds: 5 })?.success).toBe(0.5);
        expect(r.turnOutcome({ verified: false, stuck: true, infra: false, calls: 9, seconds: 60 })?.failure).toBe(0.5);
    });

    it("the owner's 'no, that's wrong' right after a turn counts against that turn's model", () => {
        const t0 = Date.now();
        const before = r.estimates("quick", t0).find((e) => e.arm.id === "haiku")!.p;
        r.recordOutcome("quick", "haiku", { success: 1, failure: 0, calls: 2, seconds: 4 }, t0);
        r.noteTurn("quick", "haiku", 1, t0);
        r.noteNextMessage("no, that's the wrong song", t0 + 30_000);
        expect(r.estimates("quick", t0 + 30_000).find((e) => e.arm.id === "haiku")!.p).toBeLessThan(before);
        // An answer or a new request changes nothing.
        for (const m of ["no thanks", "no, that's all", "thanks! now open notes"]) {
            const p = r.estimates("quick", t0 + 30_000).find((e) => e.arm.id === "haiku")!.p;
            r.noteTurn("quick", "haiku", 1, t0);
            r.noteNextMessage(m, t0 + 30_000);
            expect(r.estimates("quick", t0 + 30_000).find((e) => e.arm.id === "haiku")!.p).toBe(p);
        }
    });

    it("explores only on low-risk turns, and then by sampling every model's belief", () => {
        let i = 0;
        const always = () => [0.01, 0.3, 0.7, 0.2, 0.9, 0.5][i++ % 6]; // first draw < 5%: explore
        expect(r.chooseArm("browser", { lowRisk: false, rand: always }).explored).toBe(false);
        expect(r.chooseArm("quick", { lowRisk: true, rand: always }).explored).toBe(true);
    });

    // scripts/eval-grounding.ts: nano and 4o-mini found 1 of 32 UI targets in a screenshot.
    it("a turn with an image never goes to a model that can't work from one", () => {
        for (let i = 0; i < 40; i++) {
            const arm = r.chooseArm("quick", { lowRisk: true, vision: true, rand: () => (i % 7) / 7 }).arm;
            expect(["gpt-4.1-nano", "gpt-4o-mini", "gpt-5-mini"]).not.toContain(arm.id);
        }
    });

    it("classifies a turn from the tool router's classification", () => {
        expect(r.classifyTurn({ tier: "chat", categories: [] }, false)).toBe("chat");
        expect(r.classifyTurn({ tier: "simple", categories: ["system_controls", "core"] }, false)).toBe("quick");
        expect(r.classifyTurn({ tier: "standard", categories: ["os_control", "app_management"], multi_step: true }, false)).toBe("desktop");
        expect(r.classifyTurn({ tier: "standard", categories: ["coding", "file_system"] }, false)).toBe("coding");
        expect(r.classifyTurn({ tier: "simple", categories: ["browser"] }, false)).toBe("browser");
        expect(r.classifyTurn(null, true)).toBe("vision");
        expect(r.lowRiskTurn("quick", ["system_controls"])).toBe(true);
        expect(r.lowRiskTurn("desktop", ["os_control", "communication"])).toBe(false);
    });
});
