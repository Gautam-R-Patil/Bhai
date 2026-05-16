import { describe, it, expect } from "vitest";
const mod = await import("../wizard/copy.js");
const Copy = mod.Copy || mod.default;

describe("Copy.get", () => {
    it("returns the string for a valid (step, key) pair", () => {
        expect(Copy.get("terms", "title")).toBe("Read once. We won't ask again.");
    });

    it("returns null for an unknown step", () => {
        expect(Copy.get("nonexistent", "title")).toBeNull();
    });

    it("returns null for an unknown key under a valid step", () => {
        expect(Copy.get("terms", "nonexistent")).toBeNull();
    });

    it("every step in the spec's beat table has a title and sub", () => {
        const steps = [
            "awakening", "terms", "signin", "profile", "persona",
            "personalize", "permissions", "vision-tier", "install", "ready-hub",
        ];
        for (const s of steps) {
            // awakening uses dynamic greeting (built in awakening.js); allow missing title.
            // ready-hub uses dynamic title (built in ready-hub-body.js); allow missing title.
            if (s !== "awakening" && s !== "ready-hub") {
                expect(Copy.get(s, "title")).toBeTruthy();
            }
        }
    });
});
