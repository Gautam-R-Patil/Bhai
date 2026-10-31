// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// Finds the Site Skill for a URL. Skills live in folders with a skill.json
// manifest ({ name, domains, version, status? }) next to skill.cjs: user/store skills in
// ~/.bhai/store/site-skills, built-ins in <bot>/site-skills. The dirs are read
// on every lookup, so an added or edited skill is used by the next task without
// a restart (the runtime also forks a fresh process per call).
//
// Only live skills are found: a manifest whose `status` is set to anything but
// "active" (awaiting_approval, drifted, archived) is skipped, as is one with no
// domains (the runtime's same-site fence would be off) and any "_" folder
// (e.g. _staging). A missing status means active, so built-ins need none.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getBhaiHome, getScriptsDir } from "../../config/paths.js";

export const defaultSkillDirs = () => [
    path.join(getBhaiHome(), "store", "site-skills"),
    path.resolve(getScriptsDir(), "..", "site-skills"),
];

export function findSiteSkill(url: string, dirs = defaultSkillDirs()): string | null {
    let host: string;
    try {
        host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return null;
    }
    for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
            if (name.startsWith("_")) continue;
            const skill = path.join(dir, name, "skill.cjs");
            try {
                const meta = JSON.parse(readFileSync(path.join(dir, name, "skill.json"), "utf8")) as { domains?: unknown; status?: unknown };
                if ((meta.status ?? "active") !== "active" || !Array.isArray(meta.domains) || !meta.domains.length) continue;
                if (existsSync(skill) && meta.domains.some((d) => typeof d === "string" && d && (host === d || host.endsWith(`.${d}`)))) return skill;
            } catch {
                /* no or bad manifest: not a skill */
            }
        }
    }
    return null;
}
