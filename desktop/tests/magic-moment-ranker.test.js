// Tests the pure rankSignals function.
import { describe, it, expect } from "vitest";
import { rankSignals } from "../components/magic-moment-ranker.js";

describe("rankSignals — clusters", () => {
    it("dev-cluster fires when vscode + browser are open", () => {
        const out = rankSignals({ snapshot: { names: ["visual studio code", "chrome"] } });
        expect(out[0].id).toBe("dev-cluster");
        expect(out[0].observation).toContain("building");
    });

    it("dev-cluster fires for cursor + safari", () => {
        const out = rankSignals({ snapshot: { names: ["cursor", "safari"] } });
        expect(out[0].id).toBe("dev-cluster");
    });

    it("creator-cluster fires for figma alone", () => {
        const out = rankSignals({ snapshot: { names: ["figma"] } });
        expect(out[0].id).toBe("creator-cluster");
    });

    it("coord-cluster fires for slack + calendar", () => {
        const out = rankSignals({ snapshot: { names: ["slack", "calendar"] } });
        expect(out[0].id).toBe("coord-cluster");
    });

    it("research-cluster fires for obsidian + chrome", () => {
        const out = rankSignals({ snapshot: { names: ["obsidian", "chrome"] } });
        expect(out[0].id).toBe("research-cluster");
    });

    it("comm-cluster fires for discord alone", () => {
        const out = rankSignals({ snapshot: { names: ["discord"] } });
        expect(out[0].id).toBe("comm-cluster");
    });

    it("falls back to ambient when no cluster matches", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] } });
        expect(out[0].id).toBe("ambient");
    });

    it("falls back to ambient on empty snapshot", () => {
        const out = rankSignals({ snapshot: { names: [] } });
        expect(out[0].id).toBe("ambient");
    });
});

describe("rankSignals — persona filler", () => {
    it("appends developer line when persona=developer", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] }, persona: "developer" });
        const personaSig = out.find((s) => s.id === "persona-developer");
        expect(personaSig).toBeTruthy();
        expect(personaSig.observation).toContain("codebase");
    });

    it("explorer adds no persona filler", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] }, persona: "explorer" });
        const personaSig = out.find((s) => s.id && s.id.startsWith("persona-"));
        expect(personaSig).toBeUndefined();
    });

    it("null persona adds no filler", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] }, persona: null });
        const personaSig = out.find((s) => s.id && s.id.startsWith("persona-"));
        expect(personaSig).toBeUndefined();
    });
});

describe("rankSignals — time-of-day", () => {
    it("late-night adds a minimal-mode signal", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] }, hourOfDay: "late-night" });
        expect(out.find((s) => s.id === "tod-late-night")).toBeTruthy();
    });

    it("morning adds a brief-the-day signal", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] }, hourOfDay: "morning" });
        expect(out.find((s) => s.id === "tod-morning")).toBeTruthy();
    });

    it("afternoon/evening add no TOD signal", () => {
        const out1 = rankSignals({ snapshot: { names: ["finder"] }, hourOfDay: "afternoon" });
        const out2 = rankSignals({ snapshot: { names: ["finder"] }, hourOfDay: "evening" });
        expect(out1.find((s) => s.id && s.id.startsWith("tod-"))).toBeUndefined();
        expect(out2.find((s) => s.id && s.id.startsWith("tod-"))).toBeUndefined();
    });
});

describe("rankSignals — monitor count", () => {
    it("includes a monitors signal when monitorCount >= 2", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] }, monitorCount: 3 });
        const m = out.find((s) => s.id === "monitors");
        expect(m).toBeTruthy();
        expect(m.observation).toContain("3 monitors");
    });

    it("omits monitors signal when monitorCount < 2", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] }, monitorCount: 1 });
        expect(out.find((s) => s.id === "monitors")).toBeUndefined();
    });
});

describe("rankSignals — caps at 4", () => {
    it("returns at most 4 signals", () => {
        const out = rankSignals({
            snapshot: { names: ["visual studio code", "chrome"] },
            persona: "developer",
            hourOfDay: "morning",
            monitorCount: 3,
        });
        expect(out.length).toBeLessThanOrEqual(4);
    });
});
