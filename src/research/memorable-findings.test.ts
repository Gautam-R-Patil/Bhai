// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// One research run shouldn't store the same fact six times as six memories.
import { expect, it } from "vitest";
import { pickMemorableFindings } from "./persistence.js";

const f = (text: string, confidence: "strong" | "moderate" | "weak") =>
    ({ text, confidence, sourceTitle: "src", category: "timeline" }) as never;

it("keeps strong first, drops near-repeats and weak ones, and caps the count", () => {
    const findings = [
        f("PM Modi and CM Vijay flagged off the 15 km Poonamallee Bypass to Vadapalani Yellow Line stretch.", "moderate"),
        f("Phase 2 comprises three corridors totalling 118.9 km and 128 new stations.", "strong"),
        f("PM Narendra Modi and CM C Joseph Vijay flagged off the 15 km Yellow Line stretch from Poonamallee Bypass to Vadapalani.", "moderate"),
        f("Yellow Line operating hours are 7 am to 9 pm daily.", "moderate"),
        f("CMRL received conditional approval from the CMRS in February 2026.", "moderate"),
        f("Some blog claims the line opens in 2030.", "weak"),
    ];
    const picked = pickMemorableFindings(findings, 8).map((x: { text: string }) => x.text);
    expect(picked[0]).toMatch(/118\.9 km/); // strong first
    expect(picked.filter((t: string) => /flagged off/.test(t))).toHaveLength(1);
    expect(picked.some((t: string) => /2030/.test(t))).toBe(false);
    expect(picked).toHaveLength(4);
    expect(pickMemorableFindings(findings, 2)).toHaveLength(2);
});
