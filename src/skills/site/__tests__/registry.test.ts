// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// findSiteSkill finds only live skills: not ones awaiting approval, drifted or
// archived, not ones without domains (the same-site fence would be off), and
// nothing in a "_" folder such as _staging.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findSiteSkill } from "../registry.js";

const dir = mkdtempSync(path.join(tmpdir(), "site-registry-"));
const add = (name: string, manifest: object) => {
    mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, name, "skill.json"), JSON.stringify(manifest));
    writeFileSync(path.join(dir, name, "skill.cjs"), "exports.step = () => ({ fail: { reason: 'x' } });");
    return path.join(dir, name, "skill.cjs");
};

describe("findSiteSkill", () => {
    it("a skill with no status is active (built-ins need none), and subdomains match", () => {
        const p = add("builtin", { name: "builtin", domains: ["a.test"] });
        expect(findSiteSkill("https://www.a.test/x", [dir])).toBe(p);
        expect(findSiteSkill("https://m.a.test/", [dir])).toBe(p);
        expect(findSiteSkill("https://evila.test/", [dir])).toBeNull();
    });

    it("skips awaiting_approval, drifted and archived skills; finds status active", () => {
        for (const status of ["awaiting_approval", "drifted", "archived", "ACTIVE"]) add(`b-${status}`, { domains: ["b.test"], status });
        expect(findSiteSkill("https://b.test/", [dir])).toBeNull();
        const live = add("b-live", { domains: ["b.test"], status: "active" });
        expect(findSiteSkill("https://b.test/", [dir])).toBe(live);
    });

    it("refuses empty, missing or malformed domains (it would never fence the task to a site)", () => {
        add("c-empty", { domains: [] });
        add("c-missing", { name: "c" });
        add("c-blank", { domains: [""] });
        add("c-string", { domains: "c.test" });
        expect(findSiteSkill("https://c.test/", [dir])).toBeNull();
    });

    it("never looks inside _staging", () => {
        add("_staging", { domains: ["d.test"], status: "active" });
        expect(findSiteSkill("https://d.test/", [dir])).toBeNull();
    });
});
