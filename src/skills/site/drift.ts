// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// Self-healing bookkeeping for minted Site Skills (a skill.json with a
// `minted` field; hand-written and built-in skills are left alone):
//
//   noteRun        after every run: one line in data/site-skill-runs.jsonl
//                  (structure only: no page text, no inputs). On drift, 2
//                  drifts in the skill's last 5 runs mark it "drifted" (the
//                  registry skips it), and a repaired version whose first 2
//                  runs both drift rolls back to skill.cjs.prev.
//   captureDrift   on drift: what a repair needs, in
//                  data/site-mint/repairs/<slug>/<ts>/ (the failing page's
//                  snapshot and stamped HTML, the phase, its input, the last
//                  error and actions). Only the newest capture is kept, and
//                  it stays until a repair is used or the skill is archived,
//                  so a drifted skill is retried the next day. Only search,
//                  select and confirm are repaired; a resume is never captured.
//   repairBlocked  why a repair can't run: repairs off, one already ran in
//                  the last day, or the skill is archived (3 failed repairs).
//
// Drift: the skill stopped fitting the site (a target gone, an unexpected
// page, no progress, a skill that broke) and nothing was sent. A failure once
// the order may exist (may_have_applied) is never drift: nobody can tell what
// state the order is in, so it is never repaired automatically.

import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { getDataDir } from "../../config/paths.js";

export const runLogPath = () => path.join(getDataDir(), "site-skill-runs.jsonl");
export const repairsDir = () => path.join(getDataDir(), "site-mint", "repairs");
const DAY_MS = 86_400_000;
/** This many failed repairs in a row archive the skill until the owner asks to re-learn the site. */
export const MAX_FAILED_REPAIRS = 3;

export interface RunLine {
    at: string;
    skill: string; // the skill's folder name (its slug)
    skillHash: string;
    phase: string;
    status: string;
    reason?: string;
    steps: number;
    ms: number;
    pagePath: string; // the last page's path, never its query
    writeStatus: string;
    drift: boolean;
}

export interface DriftCapture {
    at: number;
    skill: string;
    skillDir: string;
    skillHash: string;
    phase: string;
    reason?: string;
    input?: unknown; // the failing phase's input (local only, like a trace)
    searchInput?: unknown;
    choice?: string; // the label of the option the owner picked, once select ran (local only)
    lastError?: string;
    lastActions: unknown[];
    pagePath: string;
    snapshot: unknown;
}

const DRIFT =
    /^(?:not_found|ambiguous_target|unexpected page|(?:skill_no_progress|loop_identical_args|max_steps|skill_error|skill_garbage|skill_timeout|total_changed)$)/;

export function isDrift(status: string, reason: string | undefined, writeStatus: string, kind?: string): boolean {
    if ((status !== "failed" && status !== "aborted") || writeStatus !== "not_attempted") return false;
    return kind === "unexpected_page" || DRIFT.test(reason ?? "");
}

const readJson = (p: string) => {
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    } catch {
        return null;
    }
};
const readLines = <T>(p: string): T[] =>
    existsSync(p)
        ? readFileSync(p, "utf8")
              .split("\n")
              .filter(Boolean)
              .flatMap((l) => {
                  try {
                      return [JSON.parse(l) as T];
                  } catch {
                      return [];
                  }
              })
        : [];
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2));
/** The manifest of a minted skill's folder, else null. */
const mintedManifest = (dir: string) => {
    const m = readJson(path.join(dir, "skill.json"));
    return m?.minted ? m : null;
};

// ── Repairs ───────────────────────────────────

const historyPath = (slug: string) => path.join(repairsDir(), slug, "history.jsonl");
export const repairHistory = (slug: string) =>
    readLines<{ at: number; status: string; reason?: string }>(historyPath(slug));

/** A repair ended: logged, and the 3rd failure in a row archives the skill at `skillDir`. */
export function noteRepair(slug: string, skillDir: string, status: string, reason?: string): void {
    try {
        mkdirSync(path.dirname(historyPath(slug)), { recursive: true });
        appendFileSync(historyPath(slug), `${JSON.stringify({ at: Date.now(), status, reason })}\n`);
        let failed = 0;
        for (const h of repairHistory(slug).reverse()) {
            if (h.status === "activated" || h.status === "installed") break;
            if (h.reason !== "cancelled") failed++;
        }
        const m = mintedManifest(skillDir);
        if (failed >= MAX_FAILED_REPAIRS && m && m.status !== "archived") {
            m.status = "archived";
            writeJson(path.join(skillDir, "skill.json"), m);
        }
    } catch {}
}

/** Why a repair of `slug` can't run now, or null. */
export function repairBlocked(slug: string, skillDir: string): string | null {
    if (process.env.ATLAS_NO_SITE_REPAIR === "true" || process.env.ATLAS_NO_SITE_MINT === "true") return "repairs_off";
    if (readJson(path.join(skillDir, "skill.json"))?.status === "archived") return "archived";
    const last = repairHistory(slug)
        .filter((h) => h.reason !== "cancelled") // a cancelled repair may run again
        .at(-1);
    if (last && Date.now() - last.at < DAY_MS) return "rate_limited";
    return null;
}

/** The newest drift capture waiting for a repair of a skill on `host`, if any. */
export function pendingRepair(host: string): { captureDir: string; capture: DriftCapture } | null {
    const root = repairsDir();
    if (!existsSync(root)) return null;
    let best: { captureDir: string; capture: DriftCapture } | null = null;
    for (const slug of readdirSync(root)) {
        for (const ts of existsSync(path.join(root, slug)) ? readdirSync(path.join(root, slug)) : []) {
            const captureDir = path.join(root, slug, ts);
            const capture = readJson(path.join(captureDir, "capture.json")) as DriftCapture | null;
            const domains: unknown = readJson(path.join(capture?.skillDir ?? "", "skill.json"))?.domains;
            if (!capture || !Array.isArray(domains)) continue;
            if (!domains.some((d) => typeof d === "string" && (host === d || host.endsWith(`.${d}`)))) continue;
            if (!best || capture.at > best.capture.at) best = { captureDir, capture };
        }
    }
    return best;
}

/** The phases a repair can re-mint (confirm's review page belongs to select); after_confirm code is never repaired. */
const REPAIRABLE = new Set(["search", "select", "confirm"]);

/**
 * On drift: saves the failing page and how the skill got there, for a repair.
 * Older captures of the skill are dropped. Returns the folder, or null when
 * the skill isn't minted, the phase can't be repaired, or a repair can't run
 * (repairBlocked). Never throws.
 */
export async function captureDrift(
    skillPath: string,
    c: Omit<DriftCapture, "at" | "skill" | "skillDir" | "snapshot">,
    driver: { snapshot(): Promise<unknown>; html?(): Promise<string> },
): Promise<string | null> {
    const skillDir = path.dirname(skillPath);
    const skill = path.basename(skillDir);
    if (!REPAIRABLE.has(c.phase) || !mintedManifest(skillDir) || repairBlocked(skill, skillDir)) return null;
    try {
        const snapshot = await driver.snapshot();
        const html = (await driver.html?.().catch(() => "")) ?? "";
        const root = path.join(repairsDir(), skill);
        for (const n of existsSync(root) ? readdirSync(root) : [])
            if (n !== "history.jsonl") rmSync(path.join(root, n), { recursive: true, force: true });
        const dir = path.join(root, String(Date.now()));
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "page.html"), html);
        writeJson(path.join(dir, "capture.json"), { at: Date.now(), skill, skillDir, ...c, snapshot });
        return dir;
    } catch {
        return null;
    }
}

// ── Runs ──────────────────────────────────────

/**
 * Logs one run of the skill at `skillPath` (minted skills only) and, on drift,
 * rolls a repaired version back or marks the skill drifted. Returns what it
 * changed. Never throws.
 */
export function noteRun(skillPath: string, run: Omit<RunLine, "at" | "skill">): "rolled_back" | "drifted" | null {
    const dir = path.dirname(skillPath);
    const skill = path.basename(dir);
    try {
        const m = mintedManifest(dir);
        if (!m) return null;
        mkdirSync(getDataDir(), { recursive: true });
        appendFileSync(runLogPath(), `${JSON.stringify({ at: new Date().toISOString(), skill, ...run })}\n`);
        if (!run.drift) return null;
        // ponytail: reads the whole log per drift; rotate it if it ever grows past a few MB.
        const runs = readLines<RunLine>(runLogPath()).filter((r) => r.skill === skill && r.skillHash === run.skillHash);
        const prev = path.join(dir, "skill.cjs.prev");
        if (runs.length === 2 && runs.every((r) => r.drift) && existsSync(prev)) {
            const old = readJson(path.join(dir, "skill.json.prev")) ?? m;
            renameSync(prev, path.join(dir, "skill.cjs"));
            writeJson(path.join(dir, "skill.json"), {
                ...old,
                status: "active",
                minted: { ...old.minted, rolledBackAt: new Date().toISOString() },
            });
            rmSync(path.join(dir, "skill.json.prev"), { force: true });
            return "rolled_back";
        }
        if ((m.status ?? "active") === "active" && runs.slice(-5).filter((r) => r.drift).length >= 2) {
            writeJson(path.join(dir, "skill.json"), { ...m, status: "drifted" });
            return "drifted";
        }
    } catch {}
    return null;
}
