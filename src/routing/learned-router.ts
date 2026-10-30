// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Learned model router ───────────────────────
// Picks the model for a turn from evidence: for each kind of task and each model it
// keeps how often the model got the job done, how many calls (credits) it took and
// how long. It starts from measured eval results and keeps learning from real turns.
//
// - One or two failures barely move a model: every estimate starts from a prior worth
//   ~10 tasks, and nothing is ever ruled out for good.
// - Old evidence fades (half-life 14 days), so a model that improves can win again.
// - Choice: the cheapest model whose expected success is within 5 points of the best.
// - Exploration: ~5% of low-risk turns (never sends, payments, browsing, coding) try a
//   model by Thompson sampling, so the evidence keeps up.
// - Only failures that are the model's doing count: provider errors, a silent fallback
//   to another model, and cancels are not held against it.
// Kill switch: ATLAS_NO_LEARNED_ROUTER=true.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../config/paths.js";

export type TaskClass = "chat" | "quick" | "desktop" | "browser" | "coding" | "research" | "vision" | "general";

export interface Arm {
    id: string;
    /** The model id sent to the proxy. */
    model: string;
    /** Credits per call (convex/credit_cost.ts). */
    credits: number;
    /** Takes images. */
    vision: boolean;
}

export const ARMS: Arm[] = [
    { id: "haiku", model: "anthropic/claude-haiku-4.5", credits: 0.25, vision: true },
    { id: "sonnet", model: "anthropic/claude-sonnet-4.6", credits: 1, vision: true },
    { id: "gpt-4.1-nano", model: "azure/gpt-4.1-nano", credits: 0.25, vision: true },
    { id: "gpt-4o-mini", model: "azure/gpt-4o-mini", credits: 0.25, vision: true },
    { id: "gpt-5-mini", model: "azure/gpt-5-mini", credits: 0.25, vision: true },
    { id: "gpt-6.1-terra", model: "azure/gpt-6.1-terra", credits: 1, vision: true },
];

/** What a weighted outcome adds: successes, failures, calls taken and seconds. */
interface Stat {
    s: number;
    f: number;
    n: number;
    calls: number;
    secs: number;
    t: number;
}

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const PRIOR_WEIGHT = 10; // a measured prior counts as ~10 tasks
const UNKNOWN_PRIOR = { p: 0.5, k: 2 }; // no evidence: weak, so only exploration tries it
const NEAR_BEST = 0.05;
const EXPLORE_RATE = 0.05;

/**
 * Measured with scripts/eval-computer-use.ts on real macOS tasks (2026-10-30), each checked
 * against machine state: quick = 12 single-step tasks; desktop = the multi-step / multi-app
 * tasks a model had to drive. [successes, tasks, LLM calls/task, seconds/task]. Credits are
 * per call, so calls/task is the cost. Models not measured on a kind of task start from
 * DEFAULT_PRIOR or unknown.
 */
const SEED: Partial<Record<TaskClass, Record<string, [number, number, number, number]>>> = {
    quick: {
        "gpt-4.1-nano": [12, 12, 2.6, 4.6],
        haiku: [12, 12, 2.6, 4.7],
        "gpt-4o-mini": [11, 12, 3.0, 6.5],
        "gpt-5-mini": [11, 12, 3.7, 16.5],
        "gpt-6.1-terra": [11, 12, 4.2, 8.7],
    },
    desktop: {
        haiku: [7, 7, 4.4, 9.3],
        "gpt-4o-mini": [6, 7, 3.9, 8.8],
        "gpt-6.1-terra": [6, 7, 5.3, 9.4],
        "gpt-4.1-nano": [3, 7, 4.1, 8.0],
    },
};
/**
 * Where nothing was measured, start where the rules before this router stood: chat,
 * general, research and vision on Haiku; coding and browsing on Sonnet (the coding and
 * browser escalations). Other models start unknown. Evidence moves all of it.
 */
const SONNET_PRIOR = { p: 0.92, k: 6 };
const HAIKU_PRIOR: Record<TaskClass, number> = {
    chat: 0.9,
    quick: 0.88,
    desktop: 0.88,
    general: 0.88,
    research: 0.88,
    vision: 0.88,
    coding: 0.8,
    browser: 0.8,
};
const defaultPrior = (cls: TaskClass, arm: string) =>
    // In a measured class, what wasn't measured starts unknown: an unmeasured Sonnet sitting
    // just above a measured Haiku would take the class on the first stuck turn.
    SEED[cls]
        ? UNKNOWN_PRIOR
        : arm === "sonnet"
          ? SONNET_PRIOR
          : arm === "haiku"
            ? { p: HAIKU_PRIOR[cls], k: 6 }
            : UNKNOWN_PRIOR;

type Store = Record<string, Stat>; // key: `${class}|${arm}`
let store: Store | undefined;
const storeFile = () => join(getDataDir(), "router-stats.json");

function load(): Store {
    if (store) return store;
    try {
        store = JSON.parse(readFileSync(storeFile(), "utf8")) as Store;
    } catch {
        store = {};
    }
    return store;
}

function save(): void {
    try {
        mkdirSync(getDataDir(), { recursive: true });
        const tmp = `${storeFile()}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(load()));
        renameSync(tmp, storeFile());
    } catch {
        /* learning continues in memory */
    }
}

/** The stat for a class and arm, faded to `now`. */
function stat(cls: TaskClass, arm: string, now: number): Stat {
    const st = load()[`${cls}|${arm}`] ?? { s: 0, f: 0, n: 0, calls: 0, secs: 0, t: now };
    const k = 0.5 ** (Math.max(0, now - st.t) / HALF_LIFE_MS);
    return { s: st.s * k, f: st.f * k, n: st.n * k, calls: st.calls * k, secs: st.secs * k, t: now };
}

export interface ArmEstimate {
    arm: Arm;
    /** Posterior mean success. */
    p: number;
    alpha: number;
    beta: number;
    /** Expected credits for the task (credits/call × calls). */
    cost: number;
    seconds: number;
}

/** Every arm's current estimate for a kind of task: prior + faded evidence. */
export function estimates(cls: TaskClass, now = Date.now()): ArmEstimate[] {
    return ARMS.map((arm) => {
        const seed = SEED[cls]?.[arm.id];
        const prior = seed
            ? { p: seed[0] / seed[1], k: PRIOR_WEIGHT } // alpha/beta add their own 1s
            : defaultPrior(cls, arm.id);
        const st = stat(cls, arm.id, now);
        const alpha = 1 + prior.p * prior.k + st.s;
        const beta = 1 + (1 - prior.p) * prior.k + st.f;
        const seedCalls = seed?.[2] ?? 3;
        const seedSecs = seed?.[3] ?? 10;
        // Observed averages pull away from the seed as evidence comes in.
        const w = st.n / (st.n + 3);
        const calls = (1 - w) * seedCalls + w * (st.n ? st.calls / st.n : seedCalls);
        const seconds = (1 - w) * seedSecs + w * (st.n ? st.secs / st.n : seedSecs);
        return { arm, p: alpha / (alpha + beta), alpha, beta, cost: arm.credits * calls, seconds };
    });
}

/** The kind of task, from the tool router's classification of the turn. */
export function classifyTurn(
    c: { tier?: string; categories?: string[]; multi_step?: boolean } | null | undefined,
    hasMedia: boolean,
): TaskClass {
    if (!c) return hasMedia ? "vision" : "general";
    const cats = new Set(c.categories ?? []);
    const any = (...xs: string[]) => xs.some((x) => cats.has(x));
    if (c.tier === "chat") return "chat";
    if (any("coding", "codebase", "code_execution", "github", "shell")) return "coding";
    if (any("browser")) return "browser";
    if (hasMedia) return "vision"; // a screenshot with code or a web page stays coding/browser
    if (any("research", "web_search") && !any("os_control", "app_management")) return "research";
    const gui = [...cats].filter((x) => x !== "core" && x !== "memory" && x !== "tool_creation");
    if (
        gui.length &&
        gui.every((x) => ["os_control", "app_management", "system_controls", "media", "file_system"].includes(x))
    )
        return c.tier === "simple" && !c.multi_step ? "quick" : "desktop";
    return "general";
}

/** Kinds of task where a worse pick can't do harm beyond a retry (no sends, buys, browsing, code). */
export function lowRiskTurn(cls: TaskClass, categories: string[] = []): boolean {
    if (!["chat", "quick", "desktop", "research", "general"].includes(cls)) return false;
    return !categories.some((c) => ["communication", "google_api", "browser", "marketing", "long_tasks"].includes(c));
}

/** Standard-normal and gamma draws for a Beta sample (Marsaglia–Tsang). */
function gamma(k: number, rand: () => number): number {
    if (k < 1) return gamma(k + 1, rand) * rand() ** (1 / k);
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
        let x: number;
        let v: number;
        do {
            x = Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
            v = 1 + c * x;
        } while (v <= 0);
        v = v * v * v;
        const u = rand();
        if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
}
const betaSample = (a: number, b: number, rand: () => number) => {
    const x = gamma(a, rand);
    return x / (x + gamma(b, rand));
};

export interface Pick {
    arm: Arm;
    explored: boolean;
    reason: string;
}

/**
 * The model for a turn: the cheapest whose expected success is within NEAR_BEST of the
 * best (then the faster); on ~5% of low-risk turns, a Thompson-sampled one instead.
 */
export function chooseArm(
    cls: TaskClass,
    opts: { lowRisk: boolean; vision?: boolean; rand?: () => number; now?: number } = { lowRisk: false },
): Pick {
    const rand = opts.rand ?? Math.random;
    const est = estimates(cls, opts.now).filter((e) => !opts.vision || e.arm.vision);
    if (opts.lowRisk && rand() < EXPLORE_RATE) {
        // Each arm by a draw from its belief: a model with little evidence or a bad run
        // still gets picked now and then, so nothing is written off for good.
        const drawn = est.map((e) => ({ e, v: betaSample(e.alpha, e.beta, rand) - 0.02 * e.cost }));
        const best = drawn.sort((a, b) => b.v - a.v)[0].e;
        return { arm: best.arm, explored: true, reason: `explore (p≈${best.p.toFixed(2)})` };
    }
    const top = Math.max(...est.map((e) => e.p));
    const pick = est
        .filter((e) => e.p >= top - NEAR_BEST)
        // Costs within a twentieth of a credit are the same price: then the faster wins.
        .sort((a, b) => Math.round(a.cost * 20) - Math.round(b.cost * 20) || a.seconds - b.seconds)[0];
    return {
        arm: pick.arm,
        explored: false,
        reason: `p≈${pick.p.toFixed(2)} (best ${top.toFixed(2)}), ~${pick.cost.toFixed(2)} credits, ~${pick.seconds.toFixed(0)}s`,
    };
}

export interface Outcome {
    /** Weighted: 1 for a verified finish, 0.5 for an unchecked one. */
    success: number;
    /** Weighted: the model's share of a failure. */
    failure: number;
    calls: number;
    seconds: number;
}

/** Fold one turn's outcome into the evidence. */
export function recordOutcome(cls: TaskClass, armId: string, o: Outcome, now = Date.now()): void {
    if (process.env.ATLAS_NO_LEARNED_ROUTER === "true") return;
    store = undefined; // re-read: an eval run (RECORD=1) or another process may have added evidence
    const st = stat(cls, armId, now);
    const w = o.success + o.failure;
    load()[`${cls}|${armId}`] = {
        s: st.s + o.success,
        f: st.f + o.failure,
        n: st.n + w,
        calls: st.calls + o.calls * w,
        secs: st.secs + o.seconds * w,
        t: now,
    };
    save();
}

/**
 * How a finished turn reads for its model: a verified finish is a full success, an
 * unchecked one half; a stuck report or a give-up exit is half a failure (the cause may
 * be a blocker or a tool, not the model). null = don't count it (a provider error, a
 * silent fallback to another model, a cancel).
 */
export function turnOutcome(t: {
    verified: boolean;
    stuck: boolean;
    infra: boolean;
    calls: number;
    seconds: number;
}): Outcome | null {
    if (t.infra) return null;
    if (t.stuck) return { success: 0, failure: 0.5, calls: t.calls, seconds: t.seconds };
    return { success: t.verified ? 1 : 0.5, failure: 0, calls: t.calls, seconds: t.seconds };
}

// The last turn, so the owner's "no, that's wrong" right after it counts against it.
let lastTurn: { cls: TaskClass; arm: string; success: number; at: number } | undefined;
// "no" alone answers a question ("no thanks"); it's a correction only with what's wrong.
const CORRECTION_RE =
    /^\s*(no+[\s,.!]+.{0,30}?\b(wrong|incorrect|mistake|not (it|that|this|what|right)|didn'?t|forgot|missed|i (said|meant|asked|wanted))\b|wrong\b|that'?s (not right|wrong|incorrect)|not (that|what i)|(it )?didn'?t work|try again|redo|still (not|wrong)|you (didn'?t|forgot|missed))/i;

export function noteTurn(cls: TaskClass, arm: string, success: number, now = Date.now()): void {
    lastTurn = { cls, arm, success, at: now };
}

/** The owner's next message: a correction within 3 minutes turns the last turn into a failure. */
export function noteNextMessage(text: string, now = Date.now()): void {
    const t = lastTurn;
    lastTurn = undefined;
    if (!t || now - t.at > 3 * 60_000 || !CORRECTION_RE.test(text)) return;
    store = undefined;
    const st = stat(t.cls, t.arm, now);
    load()[`${t.cls}|${t.arm}`] = { ...st, s: Math.max(0, st.s - t.success), f: st.f + 1 };
    save();
}

/** For tests: forget the in-memory evidence. */
export function resetRouterForTests(): void {
    store = {};
    lastTurn = undefined;
}
