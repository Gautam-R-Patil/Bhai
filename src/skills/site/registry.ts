// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Finds the Site Skill for a URL. Skills live in folders with a skill.json
// manifest ({ name, domains, version }) next to skill.cjs: user/store skills in
// ~/.atlas/store/site-skills, built-ins in <bot>/site-skills. The dirs are read
// on every lookup, so an added or edited skill is used by the next task without
// a restart (the runtime also forks a fresh process per call).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getScriptsDir } from "../../config/paths.js";

export const defaultSkillDirs = () => [
    path.join(homedir(), ".atlas", "store", "site-skills"),
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
            const skill = path.join(dir, name, "skill.cjs");
            try {
                const meta = JSON.parse(readFileSync(path.join(dir, name, "skill.json"), "utf8")) as { domains?: string[] };
                if (existsSync(skill) && meta.domains?.some((d) => host === d || host.endsWith(`.${d}`))) return skill;
            } catch {
                /* no or bad manifest: not a skill */
            }
        }
    }
    return null;
}
