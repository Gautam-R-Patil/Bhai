// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// The Skill Minter: turns a recorded session (recorder.ts) into a Site Skill.
// A small tool loop: the model reads the redacted digest and captures, writes
// skill.json + skill.cjs, replays it offline (replay.ts) until it passes, and
// finishes. Finish runs the static gate (checks.ts), the full replay and one
// review call; a pass installs the skill as awaiting_approval, which the
// registry skips until the owner approves it (approveSiteSkill, ownerSaid).
//
// Budgets: 12 model turns (ATLAS_SITE_MINT_MAX_TURNS), 10 minutes, 2 review
// rounds, 2 replies in a row with no tool call. Sonnet throughout; Opus for at
// most 2 turns once 2 replays failed at turn ≥6. So a mint never costs more than
// maxMintCredits(): with 12 turns, 16 credits.
//
// What the model sees is redacted here first: the owner's own values become
// placeholders ({{input.query}}, {{choice.label}}, [typed text]), then PII,
// credentials and phone numbers are masked. Site text goes inside
// <page_data>…</page_data> with every "<" escaped, so a page can't close that
// block and talk to the model from outside it. Recorded HTML never leaves the
// machine; only replay reads it.
//
// Repair (repairSiteSkill): when the site changed under a live minted skill
// (drift.ts captured the failing page) and Bhai then finished the task by
// hand while recording, only the broken phase is re-minted: write_phase
// replaces that one function (spliced in by its acorn node range), at most 6
// turns and 5 minutes. Replay runs the new session from the phase that broke,
// and every session the skill was verified on before; on those, only stale
// pages of the repaired phase may fail, never a commit, a probe or a site
// fence. A repair that leaves the safety fields (domains, commits, questions,
// effect, paymentDomains) as they were, was replayed on an earlier session
// too, and keeps every phase verified that was verified before goes live at
// once, keeping the old code as skill.cjs.prev (drift.ts rolls back to it if
// the new version's first 2 runs drift); any other waits for the owner's
// approval beside the live one. A failed repair keeps the capture, so the
// skill (drifted by then) is retried the next day, until the 3rd failure in
// a row archives it.

import { randomBytes } from "node:crypto";
import * as acorn from "acorn";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getDataDir } from "../../../config/paths.js";
import { type ChatCompletionMessageParam, type ChatCompletionTool, type LLMClient, MODELS } from "../../../llm.js";
import { ownerSaid } from "../../../security/consent.js";
import { maskCredentials } from "../../../security/credential-mask.js";
import { redactPii } from "../../../security/pii-redactor.js";
import { knownForms } from "../../../security/value-forms.js";
import { extractJSON } from "../../../utils/json-extract.js";
import { type DriftCapture, noteRepair, repairBlocked } from "../drift.js";
import { checkSkill, type Finding, type MintedManifest, type RecordedValue } from "./checks.js";
import { commitEvent, type Descriptor, type LoadedTrace, loadTrace } from "./recorder.js";
import { type PhaseName, type ReplayReport, replaySkill, type Verdict } from "./replay.js";

export const maxTurns = () => Math.max(1, Number(process.env.ATLAS_SITE_MINT_MAX_TURNS) || 12);
const WALL_MS = 10 * 60_000;
const REPAIR_TURNS = 6;
const REPAIR_WALL_MS = 5 * 60_000;
const MAX_REVIEWS = 2;
const MAX_OPUS_TURNS = 2;
const CAPTURE_BYTES = 16_000;
const FULL_CAPTURES = 3;
/** Worst case: every turn billed, two of them on Opus, plus both review rounds. */
export const maxMintCredits = (turns = maxTurns()) => turns + MAX_OPUS_TURNS + MAX_REVIEWS;
// Mirrors convex/credit_cost.ts for the three ids used here.
export const creditCost = (model: string) => (/opus/i.test(model) ? 2 : /haiku/i.test(model) ? 0.25 : 1);

export const siteSkillStore = () => path.join(homedir(), ".atlas", "store", "site-skills");
export const mintJobsDir = () => path.join(getDataDir(), "site-mint", "jobs");
/** Sessions a skill was verified on, kept past trace retention for its repairs' regression replays (never in the store). */
export const fixturesDir = () => path.join(getDataDir(), "site-mint", "fixtures");
// A code the replay types where the owner typed theirs (the real one was never recorded).
const REPLAY_ANSWER = "424242";

export interface MintJob {
    traceDir: string;
    llm: LLMClient;
    /** The search input as the owner gave it, e.g. {query: "paneer"}: replay types it and probes with others. */
    input: Record<string, string>;
    /**
     * The label of the item the owner picked: hidden from the model and banned
     * from the code. Default: read off the trace (choiceFromTrace).
     */
    choice?: string;
    storeDir?: string;
    jobsDir?: string;
    jobId?: string;
    // biome-ignore lint/suspicious/noExplicitAny: a running Playwright Browser to reuse for replays
    browser?: any;
    signal?: AbortSignal;
    /** Repair mode (repairSiteSkill): re-mint the phase of this live skill that the capture shows broken. */
    repair?: RepairJob;
}
export interface RepairJob {
    skillDir: string; // the live skill's folder
    captureDir: string; // drift.ts captureDrift's folder
}
export interface MintResult {
    /** activated: a repair went live at once; installed: waiting for the owner's approval. */
    status: "installed" | "activated" | "blocked" | "failed";
    jobId: string;
    slug?: string;
    dir?: string;
    reason?: string;
    credits: number;
    turns: number;
}

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) =>
    ({
        type: "function",
        function: {
            name,
            description,
            parameters: { type: "object", properties, required, additionalProperties: false },
        },
    }) as ChatCompletionTool;

/** Sent byte-identical on every turn, so the prompt cache holds. */
export const MINT_TOOLS: ChatCompletionTool[] = [
    fn("read_capture", "The redacted elements, text and events of recorded page k.", { k: { type: "integer" } }, ["k"]),
    fn(
        "write_skill",
        "Save skill.json fields and skill.cjs (≤24 KB). Returns static findings; fix every error.",
        {
            skill_json: {
                type: "object",
                description: "{input, commits, questions, confirmPattern, assumptions?, untested?}",
            },
            skill_cjs: { type: "string" },
        },
        ["skill_json", "skill_cjs"],
    ),
    fn("replay", "Re-run the saved skill offline against every recorded page, plus generalization probes.", {}),
    fn(
        "finish",
        "Run the full gate and review; on a pass the skill is installed for the owner's approval.",
        {
            assumptions: { type: "array", items: { type: "string" } },
            untested: { type: "array", items: { type: "string" } },
        },
        ["assumptions", "untested"],
    ),
    fn(
        "report_blocked",
        "Stop: this session cannot support a skill.",
        {
            reason: { type: "string", enum: ["site_lacks_capability", "trace_incomplete", "needs_vision", "other"] },
            detail: { type: "string" },
        },
        ["reason", "detail"],
    ),
];

const WRITE_PHASE = fn(
    "write_phase",
    "Replace one function of skill.cjs: the phase that broke, or interstitials. source is the whole function, e.g. search(ctx, lib) { … }. Pass skill_json ({commits, questions, …}) only when the site's commit control or questions changed: that needs the owner's approval. Returns static findings; fix every error.",
    {
        phase: { type: "string", enum: ["search", "select", "after_confirm", "interstitials"] },
        source: { type: "string" },
        skill_json: { type: "object", description: "optional: the skill.json fields that change" },
    },
    ["phase", "source"],
);
/** Repair mode: write_phase in write_skill's place, byte-identical on every turn too. */
export const REPAIR_TOOLS: ChatCompletionTool[] = MINT_TOOLS.map((t) =>
    t.type === "function" && t.function.name === "write_skill" ? WRITE_PHASE : t,
);

const CONTINUE =
    "Your reply did not finish the task. Continue: fix the skill and call finish, or call report_blocked. Another reply without a tool call ends this attempt.";

// ── Redaction ─────────────────────────────────

const PHONE = /(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PRICE = /(?:₹|\brs\.?|\binr)\s*[\d,]+(?:\.\d+)?/gi;

/**
 * The item the owner picked, as the site named it: the first click, after the
 * search was typed, on an element inside an item's card (an li, tr, article or
 * [data-item]); the card's text without prices and without the clicked
 * control's own label ("Paneer Tikka — ₹249 Add" → "Paneer Tikka").
 */
export function choiceFromTrace(t: LoadedTrace, input: Record<string, string>): string | undefined {
    const typed = new Set(Object.values(input).filter(Boolean).map(String));
    const from = t.pages.findIndex((p) =>
        p.events.some((e) => e.op === "fill" && typeof e.value === "string" && (!typed.size || typed.has(e.value))),
    );
    if (from < 0) return undefined;
    for (const p of t.pages.slice(from)) {
        if (p.offsite) continue;
        for (const e of p.events) {
            if (e.op !== "click") continue;
            const d = e.target;
            const el = (p.snapshot.elements as Array<Record<string, string | undefined>>).find(
                (x) =>
                    (d.dataId && x.dataId === d.dataId) ||
                    (d.testid && x.testid === d.testid) ||
                    (d.id && x.id === d.id) ||
                    (!!d.text && x.tag === d.tag && x.text === d.text),
            );
            if (!el?.context) continue;
            const own = (el.text ?? "").replace(/\s+/g, " ").trim();
            const ownRe = own ? new RegExp(`(^|\\s)${escapeRe(own)}(?=\\s|$)`, "gi") : null;
            for (const line of el.context.split(/\n+/)) {
                let label = line.replace(PRICE, " ").replace(/\s+/g, " ");
                if (ownRe) label = label.replace(ownRe, " ");
                label = label.replace(/\s+/g, " ").replace(/^[\s\-—–·|:,]+|[\s\-—–·|:,]+$/g, "");
                if (label.length >= 3) return label;
            }
            if (own.length >= 3) return own; // the name itself was clicked
        }
    }
    return undefined;
}

/** The session's own values: the input, the chosen item, and anything else that was typed. */
export function recordedValues(t: LoadedTrace, input: Record<string, string>, choice?: string): RecordedValue[] {
    const out: RecordedValue[] = [];
    if (choice) out.push({ value: choice, label: "{{choice.label}}" });
    for (const [k, v] of Object.entries(input)) if (v) out.push({ value: String(v), label: `{{input.${k}}}` });
    for (const p of t.pages)
        for (const e of p.events)
            if (
                typeof e.value === "string" &&
                e.value !== "{{answer}}" &&
                e.value.trim() &&
                !out.some((o) => o.value === e.value)
            )
                out.push({ value: e.value, label: "[typed text]" });
    return out;
}

/** Text for the model: values → placeholders (every encoded form, any case), then PII, credentials, phones. */
export function redactor(values: RecordedValue[]): (text: string) => string {
    const forms = values
        .flatMap((v) => knownForms(v.value).map(([f]) => [f, v.label] as const))
        .filter(([f]) => f.trim().length >= 2)
        .sort((a, b) => b[0].length - a[0].length);
    const re = forms.length ? new RegExp(forms.map(([f]) => escapeRe(f)).join("|"), "gi") : null;
    const label = new Map(forms.map(([f, l]) => [f.toLowerCase(), l]));
    return (text) => {
        const s = re ? text.replace(re, (m) => label.get(m.toLowerCase()) ?? "[typed text]") : text;
        return maskCredentials(redactPii(s).text).replace(PHONE, "[phone]");
    };
}

const describe = (d: Descriptor) => {
    const q = JSON.stringify;
    const id = d.id
        ? `#${d.id}`
        : d.testid
          ? `[data-testid=${q(d.testid)}]`
          : d.dataId
            ? `[data-id=${q(d.dataId)}]`
            : d.name
              ? `${d.tag}[name=${q(d.name)}]`
              : d.tag;
    return d.text ? `${id} ${q(d.text)}` : id;
};
/** Site text for the model, inside <page_data>: every "<" escaped, so the block can't be closed early. */
const pageData = (s: string) => `<page_data>${s.replace(/</g, "\\u003c")}</page_data>`;
/** Text that quotes the site (a replay report) and goes to a model: "<" escaped likewise. */
const quoted = (s: string) => s.replace(/</g, "\\u003c");

const pathOf = (url: string) => {
    try {
        const u = new URL(url);
        return u.pathname + u.search;
    } catch {
        return url;
    }
};

/** The first user message: one line per recorded page. */
export function buildDigest(t: LoadedTrace, redact: (s: string) => string, input: Record<string, string>): string {
    const commit = commitEvent(t);
    const last = t.pages[t.pages.length - 1];
    const goal = Object.keys(input)
        .map((k) => `{{input.${k}}}`)
        .join(", ");
    const lines = [
        `SITE ${t.domain}   INPUT ${goal || "(none)"}   OUTCOME ${
            commit
                ? `order placed (commit at k=${commit.k}${commit.event.consented ? ", the owner said yes" : ""})`
                : "no order placed"
        }`,
    ];
    for (const p of t.pages) {
        if (p.offsite) {
            lines.push(`k=${p.k} (off the site: ${p.url}; nothing kept)`);
            continue;
        }
        const evs = p.events.map((e, i) => {
            const v =
                e.op === "press"
                    ? ` ${e.key}`
                    : e.value === null
                      ? " [password]"
                      : e.value !== undefined
                        ? ` ${JSON.stringify(e.value)}`
                        : "";
            const mark = commit && commit.k === p.k && commit.i === i ? "  ← COMMIT" : "";
            return `${e.op} ${describe(e.target)}${v}${mark}`;
        });
        let line = `k=${p.k} ${pathOf(p.url)}  ${JSON.stringify(p.title)}  ${p.snapshot.elements.length} els`;
        if ((commit && p.k === commit.k) || p === last)
            line += `  text: ${JSON.stringify(p.snapshot.text.replace(/\s+/g, " ").slice(0, 240))}`;
        lines.push(`${line}  events: ${evs.join("; ") || "(none)"}`);
    }
    return `${pageData(`\n${redact(lines.join("\n"))}\n`)}\nUse read_capture {k} for a page's full elements and text.`;
}

// ── One phase of a minted skill.cjs ───────────

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes
type N = any;
const parse = (src: string) => acorn.parse(src, { ecmaVersion: "latest", sourceType: "script" }) as N;
const keyOf = (p: N) => (p?.type === "Property" && !p.computed ? (p.key.name ?? p.key.value) : undefined);

// [start, end) of phases.<name> (the `name(ctx, lib) {…}` member of the
// top-level `const phases = {…}`), or of `function interstitials`.
function phaseRange(src: string, name: string): [number, number] {
    const body = parse(src).body as N[];
    const node =
        name === "interstitials"
            ? body.find((s) => s.type === "FunctionDeclaration" && s.id?.name === "interstitials")
            : body
                  .filter((s) => s.type === "VariableDeclaration")
                  .flatMap((s) => s.declarations)
                  .find(
                      (d: N) =>
                          d.id.type === "Identifier" && d.id.name === "phases" && d.init?.type === "ObjectExpression",
                  )
                  ?.init.properties.find((p: N) => keyOf(p) === name);
    if (!node)
        throw new Error(`skill.cjs has no ${name === "interstitials" ? "function interstitials" : `phases.${name}`}`);
    return [node.start, node.end];
}

/** The source of phases.<name> (or of function interstitials) in a minted skill.cjs. */
export function phaseSource(src: string, name: string): string {
    const [a, b] = phaseRange(src, name);
    return src.slice(a, b);
}

/**
 * `src` with phases.<name> (or function interstitials) replaced by `source`,
 * which must be exactly that one function and nothing around it.
 */
export function splicePhase(src: string, name: string, source: string): string {
    const [a, b] = phaseRange(src, name);
    const wrap = name === "interstitials" ? "" : "({";
    let node: N = null;
    try {
        const body = parse(name === "interstitials" ? source : `({${source}\n})`).body as N[];
        const one =
            body.length === 1 &&
            (name === "interstitials"
                ? body[0].type === "FunctionDeclaration" && body[0].id?.name === "interstitials"
                : body[0].type === "ExpressionStatement" &&
                  body[0].expression.type === "ObjectExpression" &&
                  body[0].expression.properties.length === 1 &&
                  keyOf(body[0].expression.properties[0]) === name);
        if (one) node = name === "interstitials" ? body[0] : body[0].expression.properties[0];
    } catch (e) {
        throw new Error(`source does not parse: ${(e as Error).message}`);
    }
    if (!node)
        throw new Error(
            name === "interstitials"
                ? "source must be exactly function interstitials(s, lib) { … }"
                : `source must be exactly phases.${name}: ${name}(ctx, lib) { … }`,
        );
    // The function's own node range: comments and a comma around it stay out
    // (a trailing "// note" would otherwise swallow the comma after it).
    const fresh = source.slice(node.start - wrap.length, node.end - wrap.length);
    const out = src.slice(0, a) + fresh + src.slice(b);
    try {
        parse(out);
    } catch (e) {
        throw new Error(`the spliced skill.cjs does not parse: ${(e as Error).message}`);
    }
    return out;
}

// ── Repair inputs ─────────────────────────────

/** The fields a repair may not change without the owner's approval. */
const SAFETY_FIELDS = ["domains", "commits", "questions", "effect", "paymentDomains"];
const safetyOf = (m: Record<string, unknown> | null) =>
    JSON.stringify(SAFETY_FIELDS.map((k) => m?.[k] ?? (k === "effect" ? null : [])));
// Replay verdicts that only say an old page no longer matches the new code (the
// site changed there): tolerated on old sessions, in the repaired phase only.
const STALE = new Set([
    "mismatch",
    "no_progress",
    "skill_no_progress",
    "skill_failed",
    "skill_refused",
    "options_missing_choice",
    "expect_unmatched",
]);
const PHASES: PhaseName[] = ["search", "select", "confirm", "after_confirm"];

interface Fixture {
    trace: LoadedTrace;
    input: Record<string, unknown>;
    phase?: "search" | "select";
    choice?: string;
}
interface Repair {
    dir: string;
    // biome-ignore lint/suspicious/noExplicitAny: the live skill.json
    manifest: any;
    source: string;
    fields: Record<string, unknown>; // the minter's fields of the live manifest
    capture: DriftCapture;
    captureDir: string;
    phase: "search" | "select"; // the phase to re-mint and to replay the new session from
    phaseInput: Record<string, unknown>;
    choice?: string; // the item the failing run picked, as the site named it (no price)
    olds: Fixture[];
}

/** A session kept for regression replays: the trace plus the input it ran with. */
function keepFixture(t: LoadedTrace, meta: Omit<Fixture, "trace">): void {
    try {
        const dir = path.join(fixturesDir(), t.id);
        rmSync(dir, { recursive: true, force: true });
        cpSync(t.dir, dir, { recursive: true });
        writeFileSync(path.join(dir, "replay.json"), JSON.stringify(meta));
    } catch {}
}
function loadFixture(id: unknown): Fixture | null {
    if (typeof id !== "string" || !/^t_[a-z0-9_]+$/i.test(id)) return null;
    const dir = path.join(fixturesDir(), id);
    const meta = readJson(path.join(dir, "replay.json"));
    try {
        return meta ? { trace: loadTrace(dir), input: meta.input ?? {}, phase: meta.phase, choice: meta.choice } : null;
    } catch {
        return null;
    }
}

function loadRepair(r: RepairJob): Repair {
    const manifest = JSON.parse(readFileSync(path.join(r.skillDir, "skill.json"), "utf8"));
    const source = readFileSync(path.join(r.skillDir, "skill.cjs"), "utf8");
    const capture = JSON.parse(readFileSync(path.join(r.captureDir, "capture.json"), "utf8")) as DriftCapture;
    // The review page belongs to select (the runtime re-runs select there before paying).
    const phase =
        capture.phase === "search"
            ? "search"
            : capture.phase === "select" || capture.phase === "confirm"
              ? "select"
              : null;
    if (!phase) throw new Error(`a ${capture.phase} failure is not repaired`);
    const input = capture.phase === phase ? capture.input : undefined;
    return {
        dir: r.skillDir,
        manifest,
        source,
        fields: {
            input: manifest.input,
            commits: manifest.commits ?? [],
            questions: manifest.questions ?? [],
            confirmPattern: manifest.confirmPattern,
            ...(manifest.paymentDomains?.length && { paymentDomains: manifest.paymentDomains }),
            assumptions: manifest.minted?.assumptions ?? [],
            untested: manifest.minted?.untested ?? [],
        },
        capture,
        captureDir: r.captureDir,
        phase,
        phaseInput: input && typeof input === "object" ? (input as Record<string, unknown>) : {},
        choice:
            typeof capture.choice === "string"
                ? capture.choice
                      .replace(PRICE, " ")
                      .replace(/\s+/g, " ")
                      .replace(/^[\s\-—–·|:,]+|[\s\-—–·|:,]+$/g, "") || undefined
                : undefined,
        olds: [manifest.minted?.traceId, manifest.minted?.repairTraceId]
            .filter((id, i, a) => a.indexOf(id) === i)
            .map(loadFixture)
            .filter((f): f is Fixture => !!f),
    };
}

/**
 * One report for a repair: the new session must pass (the repaired phase
 * included); on the old sessions only stale pages of the repaired phase may
 * fail. A phase passes when any session passed it and none failed it.
 */
function mergeRepairReplays(repaired: PhaseName, fresh: ReplayReport, olds: ReplayReport[]): ReplayReport {
    const failures = [
        ...fresh.failures,
        ...olds.flatMap((r) =>
            r.failures
                .filter((f) => f.phase !== repaired || !STALE.has(f.verdict))
                .map((f) => ({ ...f, verdict: `${f.verdict} (an earlier session)` })),
        ),
    ];
    if (fresh.phases[repaired] !== "pass" && !failures.some((f) => f.phase === repaired))
        failures.push({
            phase: repaired,
            k: 0,
            verdict: "unverified",
            expected: `the new session to pass ${repaired}`,
        });
    const phases = Object.fromEntries(
        PHASES.map((p): [PhaseName, Verdict] => [
            p,
            failures.some((f) => f.phase === p)
                ? "fail"
                : [fresh, ...olds].some((r) => r.phases[p] === "pass")
                  ? "pass"
                  : "unverified",
        ]),
    ) as Record<PhaseName, Verdict>;
    return {
        ok: failures.length === 0,
        phases,
        failures,
        warnings: [...fresh.warnings, ...olds.flatMap((r) => r.warnings)].slice(0, 20),
        calls: [fresh, ...olds].reduce((n, r) => n + r.calls, 0),
        ms: [fresh, ...olds].reduce((n, r) => n + r.ms, 0),
    };
}

// ── Install / approve ─────────────────────────

const readJson = (p: string) => {
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    } catch {
        return null;
    }
};

/**
 * Moves a staged skill into the store as awaiting_approval. A skill already
 * there (live, drifted or archived) is never overwritten: the new one waits in
 * <slug>.v<n>/ until approved.
 */
function install(stage: string, storeDir: string, slug: string): string {
    const manifest = readJson(path.join(stage, "skill.json"));
    let dest = path.join(storeDir, slug);
    const live = readJson(path.join(dest, "skill.json"));
    if (live && live.status !== "awaiting_approval") {
        manifest.version = (Number(live.version) || 1) + 1;
        dest = path.join(storeDir, `${slug}.v${manifest.version}`);
    }
    manifest.status = "awaiting_approval";
    manifest.minted.at = new Date().toISOString(); // approval quotes must come after this
    writeFileSync(path.join(stage, "skill.json"), JSON.stringify(manifest, null, 2));
    rmSync(dest, { recursive: true, force: true });
    renameSync(stage, dest);
    return dest;
}

/**
 * The owner's approval: `userQuote` must be words the owner actually sent after
 * the skill was installed (ownerSaid). The newest waiting version becomes the
 * live skill; the one it replaces is kept in _prev/.
 */
export function approveSiteSkill(opts: { slug: string; userQuote: string; storeDir?: string }): {
    ok: boolean;
    error?: string;
    skill?: string;
} {
    const store = opts.storeDir ?? siteSkillStore();
    const slug = opts.slug.trim();
    if (!/^[a-z0-9-]+$/.test(slug) || !existsSync(store))
        return { ok: false, error: `No site skill "${slug}" is waiting for approval.` };
    const waiting = readdirSync(store)
        .filter((n) => n === slug || n.startsWith(`${slug}.v`))
        .map((n) => ({ n, m: readJson(path.join(store, n, "skill.json")) }))
        .filter((x) => x.m?.status === "awaiting_approval")
        .sort((a, b) => (Number(b.m.version) || 1) - (Number(a.m.version) || 1))[0];
    if (!waiting) return { ok: false, error: `No site skill "${slug}" is waiting for approval.` };
    if (!ownerSaid(opts.userQuote, Date.parse(waiting.m.minted?.at ?? "") || Date.now()))
        return {
            ok: false,
            error: "user_quote must be the user's own words from a message sent after the skill was ready. Show them the card and ask first.",
        };
    let dir = path.join(store, waiting.n);
    if (waiting.n !== slug) {
        const live = path.join(store, slug);
        if (existsSync(live)) {
            mkdirSync(path.join(store, "_prev"), { recursive: true });
            const old = readJson(path.join(live, "skill.json"));
            const keep = path.join(store, "_prev", `${slug}.v${Number(old?.version) || 1}-${Date.now()}`);
            renameSync(live, keep);
        }
        renameSync(dir, live);
        dir = live;
    }
    const m = readJson(path.join(dir, "skill.json"));
    m.status = "active";
    m.minted = { ...m.minted, approvedBy: opts.userQuote, approvedAt: new Date().toISOString() };
    writeFileSync(path.join(dir, "skill.json"), JSON.stringify(m, null, 2));
    return { ok: true, skill: path.join(dir, "skill.cjs") };
}

/** The repair's opening: what broke, where, the phase's code, and what may change. */
function repairBrief(r: Repair, slug: string, redact: (s: string) => string): string {
    const c = r.capture;
    const failure = redact(
        JSON.stringify({
            phase: c.phase,
            reason: c.reason,
            lastError: c.lastError,
            lastActions: c.lastActions,
            page: { path: c.pagePath, ...(c.snapshot as object) },
        }),
    );
    return [
        `REPAIR the ${slug} skill. The site changed: a run stopped in ${c.phase}. The run and the page it stopped on:`,
        pageData(failure.length > CAPTURE_BYTES ? `${failure.slice(0, CAPTURE_BYTES)}…(cut at 16 KB)` : failure),
        `The current phases.${r.phase}:`,
        "```js",
        phaseSource(r.source, r.phase),
        "```",
        `skill.json fields: ${JSON.stringify(r.fields)}`,
        `Below is a new session in which Bhai finished the task by hand on the changed site, from that page on. Fix the whole class of failure, not this instance. Keep every input working. Write the full replacement for phases.${r.phase} with write_phase (and interstitials, if a new banner or modal is in the way); every other phase stays as it is. Pass skill_json only when the site's commit control or questions changed: that change waits for the owner's approval. replay runs the new session from ${r.phase} and every earlier session the skill was verified on.`,
    ].join("\n");
}

// ── The loop ──────────────────────────────────

interface ToolOutcome {
    ok: boolean;
    content: string;
    end?: Omit<MintResult, "jobId" | "credits" | "turns">;
}

/**
 * Repairs a live minted skill after the site changed: `captureDir` is the
 * failing run's capture (drift.ts), `traceDir` the session in which Bhai then
 * finished the task by hand. At most 1 repair per skill per day; the 3rd
 * failed one in a row archives the skill.
 */
export function repairSiteSkill(job: Omit<MintJob, "input" | "repair" | "storeDir"> & RepairJob): Promise<MintResult> {
    const { skillDir, captureDir, ...rest } = job;
    const searchInput = readJson(path.join(captureDir, "capture.json"))?.searchInput;
    const input = Object.fromEntries(
        Object.entries(searchInput && typeof searchInput === "object" ? searchInput : {}).filter(
            ([, v]) => typeof v === "string",
        ),
    ) as Record<string, string>;
    return mintSiteSkill({ ...rest, input, storeDir: path.dirname(skillDir), repair: { skillDir, captureDir } });
}

/** Mints a Site Skill from the trace at job.traceDir. Never throws; never acts on a live site. */
export async function mintSiteSkill(job: MintJob): Promise<MintResult> {
    const started = Date.now();
    const jobId = job.jobId ?? `m_${randomBytes(5).toString("hex")}`;
    const jobsDir = job.jobsDir ?? mintJobsDir();
    const storeDir = job.storeDir ?? siteSkillStore();
    let turns = 0;
    let credits = 0;
    const record = (extra: Record<string, unknown>) => {
        try {
            mkdirSync(jobsDir, { recursive: true });
            writeFileSync(
                path.join(jobsDir, `${jobId}.json`),
                JSON.stringify({
                    id: jobId,
                    traceDir: job.traceDir,
                    startedAt: new Date(started).toISOString(),
                    turns,
                    credits,
                    ...extra,
                }),
            );
        } catch {}
    };
    let t: LoadedTrace;
    try {
        t = loadTrace(job.traceDir);
    } catch (e) {
        const r: MintResult = {
            status: "failed",
            jobId,
            reason: `trace_unreadable: ${(e as Error).message}`,
            credits,
            turns,
        };
        record({ status: r.status, reason: r.reason });
        return r;
    }
    const early = (reason: string, slug?: string): MintResult => {
        record({ status: "failed", slug, reason });
        return { status: "failed", jobId, slug, reason, credits, turns };
    };
    let rep: Repair | null = null;
    if (job.repair) {
        try {
            rep = loadRepair(job.repair);
        } catch (e) {
            return early(`repair_unreadable: ${(e as Error).message}`.slice(0, 200));
        }
    }
    const domains: string[] = rep ? rep.manifest.domains : [t.domain.replace(/^www\./, "")];
    const slug = rep
        ? path.basename(rep.dir)
        : domains[0]
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "");
    if (rep) {
        const blocked = repairBlocked(slug, rep.dir);
        if (blocked) return early(blocked, slug); // before any model call: costs nothing
        if (!domains.some((d) => t.domain === d || t.domain.endsWith(`.${d}`))) return early("trace_off_site", slug);
    }
    const commit = commitEvent(t);
    // A skill that may submit is a write skill: the session ordered, or the minter declared a commit.
    const effectOf = (m: MintedManifest | null) => (commit || m?.commits?.length ? "write" : "read");
    // A select repair's session starts past the search: the item is the one the failing run picked.
    const choice = job.choice ?? choiceFromTrace(t, job.input) ?? rep?.choice;
    // The owner's values from this session and, in a repair, from the sessions the skill was verified on
    // (a select session's input is an option id, not the owner's words: never a value to hide).
    const values = [
        ...recordedValues(t, job.input, choice),
        ...(rep?.olds ?? []).flatMap((o) =>
            recordedValues(
                o.trace,
                o.phase === "select"
                    ? {}
                    : (Object.fromEntries(Object.entries(o.input).filter(([, v]) => typeof v === "string")) as Record<
                          string,
                          string
                      >),
                o.choice,
            ),
        ),
    ].filter((v, i, a) => a.findIndex((x) => x.value === v.value) === i);
    const redact = redactor(values);
    let digest: string;
    try {
        digest = rep
            ? `${repairBrief(rep, slug, redact)}\n\n${buildDigest(t, redact, job.input)}`
            : buildDigest(t, redact, job.input);
    } catch (e) {
        return early(`${rep ? "repair" : "trace"}_unreadable: ${(e as Error).message}`.slice(0, 200), slug);
    }
    const stage = path.join(storeDir, "_staging", jobId);
    const ownBrowser = !job.browser;
    // biome-ignore lint/suspicious/noExplicitAny: Playwright Browser
    let browser: any = job.browser;

    let written: { seq: number; manifest: MintedManifest | null; findings: Finding[] } | null = null;
    let replayed: { seq: number; report: ReplayReport } | null = null;
    let failedReplays = 0;
    let reviews = 0;
    let opusTurns = 0;
    let model: string = MODELS.SONNET;
    record({ status: "running", slug });

    const replay = async (): Promise<ReplayReport> => {
        if (!written) throw new Error("nothing written");
        if (replayed?.seq === written.seq) return replayed.report;
        browser ??= await (await import("playwright")).chromium.launch({ headless: true });
        const run = (trace: LoadedTrace, input: Record<string, unknown>, phase?: "search" | "select") =>
            replaySkill(path.join(stage, "skill.cjs"), trace, {
                input,
                answer: REPLAY_ANSWER,
                browser,
                signal: job.signal,
                phase,
            });
        let report: ReplayReport;
        if (rep) {
            const fresh = await run(t, rep.phase === "search" ? job.input : rep.phaseInput, rep.phase);
            const olds: ReplayReport[] = [];
            for (const o of rep.olds) olds.push(await run(o.trace, o.input, o.phase));
            report = mergeRepairReplays(rep.phase, fresh, olds);
        } else report = await run(t, job.input);
        replayed = { seq: written.seq, report };
        if (!report.ok) failedReplays++;
        return report;
    };
    const blockingErrors = () => written?.findings.filter((f) => f.severity === "error") ?? [];

    // Checks and stages skill.json + skill.cjs; a repair keeps the live manifest's other fields.
    const save = async (skillJson: unknown, cjs: string): Promise<ToolOutcome> => {
        const { manifest, findings } = await checkSkill({ skillJson, skillCjs: cjs, trace: t, values, domains });
        written = { seq: (written?.seq ?? 0) + 1, manifest, findings };
        mkdirSync(stage, { recursive: true });
        writeFileSync(path.join(stage, "skill.cjs"), cjs);
        const { domains: _d, assumptions = [], untested = [], ...fields } = manifest ?? ({} as Partial<MintedManifest>);
        const base = rep?.manifest ?? {
            name: slug,
            version: 1,
            status: "awaiting_approval",
            paymentDomains: [],
            minted: { at: null, model: "sonnet", traceId: t.id, verified: {}, approvedBy: null },
        };
        writeFileSync(
            path.join(stage, "skill.json"),
            JSON.stringify(
                {
                    ...base,
                    domains,
                    effect: effectOf(manifest),
                    ...fields,
                    minted: { ...base.minted, assumptions, untested },
                },
                null,
                2,
            ),
        );
        const ok = !findings.some((f) => f.severity === "error");
        return { ok, content: JSON.stringify({ saved: ok, findings }) };
    };
    // A repair goes live at once when no safety field changed; else it waits for the owner.
    // biome-ignore lint/suspicious/noExplicitAny: skill.json
    const activate = (r: Repair, m: any): Omit<MintResult, "jobId" | "credits" | "turns"> => {
        keepFixture(t, { input: r.phase === "search" ? job.input : r.phaseInput, phase: r.phase, choice });
        m.version = (Number(r.manifest.version) || 1) + 1;
        m.minted = { ...m.minted, repairedAt: new Date().toISOString(), repairTraceId: t.id };
        writeFileSync(path.join(stage, "skill.cjs.prev"), r.source);
        writeFileSync(path.join(stage, "skill.json.prev"), JSON.stringify(r.manifest, null, 2));
        // Live at once only when nothing the owner approved changed: the same safety fields, an earlier
        // session replayed too, and every phase verified before still verified.
        const kept = Object.entries(r.manifest.minted?.verified ?? {}).every(
            ([k, v]) => v !== "replay" || m.minted.verified?.[k] === "replay",
        );
        const auto =
            safetyOf(m) === safetyOf(r.manifest) &&
            r.olds.length > 0 &&
            kept &&
            process.env.ATLAS_SITE_REPAIR_REQUIRE_APPROVAL !== "true";
        if (auto) m.status = "active";
        writeFileSync(path.join(stage, "skill.json"), JSON.stringify(m, null, 2));
        if (!auto) return { status: "installed", slug, dir: install(stage, path.dirname(r.dir), slug) };
        // File by file, the code last: a run in between sees the old code with unchanged safety fields.
        for (const f of ["skill.cjs.prev", "skill.json.prev", "skill.json", "skill.cjs"])
            renameSync(path.join(stage, f), path.join(r.dir, f));
        return { status: "activated", slug, dir: r.dir };
    };

    const tools: Record<string, (args: Record<string, unknown>) => Promise<ToolOutcome>> = {
        async read_capture(args) {
            const p = t.pages.find((x) => x.k === Number(args.k));
            if (!p)
                return {
                    ok: false,
                    content: JSON.stringify({ error: `no page k=${args.k}; k runs 0..${t.pages.length - 1}` }),
                };
            if (p.offsite)
                return {
                    ok: true,
                    content: pageData(`k=${p.k} is off the site (${p.url}); nothing was kept.`),
                };
            const body = redact(
                JSON.stringify({
                    k: p.k,
                    url: pathOf(p.url),
                    title: p.snapshot.title,
                    events: p.events.map((e) => ({
                        op: e.op,
                        target: e.target,
                        value: e.value ?? undefined,
                        key: e.key,
                    })),
                    text: p.snapshot.text,
                    elements: p.snapshot.elements,
                }),
            );
            const cut = body.length > CAPTURE_BYTES ? `${body.slice(0, CAPTURE_BYTES)}…(cut at 16 KB)` : body;
            return { ok: true, content: pageData(cut) };
        },
        async write_skill(args) {
            return save(args.skill_json, typeof args.skill_cjs === "string" ? args.skill_cjs : "");
        },
        async write_phase(args) {
            const r = rep as Repair;
            const name = String(args.phase ?? "");
            if (name !== r.phase && name !== "interstitials")
                return {
                    ok: false,
                    content: JSON.stringify({
                        error: `only phases.${r.phase} (or interstitials) may change in this repair`,
                    }),
                };
            let cjs: string;
            try {
                const current = written ? readFileSync(path.join(stage, "skill.cjs"), "utf8") : r.source;
                cjs = splicePhase(current, name, typeof args.source === "string" ? args.source : "");
            } catch (e) {
                return { ok: false, content: JSON.stringify({ error: (e as Error).message.slice(0, 300) }) };
            }
            const patch = args.skill_json && typeof args.skill_json === "object" ? args.skill_json : {};
            return save({ ...r.fields, ...patch }, cjs);
        },
        async replay() {
            if (!written) return { ok: false, content: JSON.stringify({ error: "call write_skill first" }) };
            if (blockingErrors().length)
                return {
                    ok: false,
                    content: JSON.stringify({ error: "fix the write_skill errors first", findings: blockingErrors() }),
                };
            const report = await replay();
            return { ok: report.ok, content: quoted(redact(JSON.stringify(report))) }; // a failure can quote a typed value or site text
        },
        async finish(args) {
            if (!written || blockingErrors().length)
                return {
                    ok: false,
                    content: JSON.stringify({
                        error: "write a skill with no errors first",
                        findings: blockingErrors(),
                    }),
                };
            const report = await replay();
            if (!report.ok)
                return { ok: false, content: quoted(redact(JSON.stringify({ error: "replay must pass", report }))) };
            if (!rep && report.phases.search !== "pass")
                return {
                    ok: false,
                    content: quoted(redact(JSON.stringify({ error: "search must pass replay", report }))),
                };
            // One review call; Haiku is enough for a skill that cannot order.
            reviews++;
            const reviewModel = effectOf(written.manifest) === "read" ? MODELS.HAIKU : MODELS.SONNET;
            credits += creditCost(reviewModel);
            let verdict: { allow?: unknown; findings?: unknown } = {};
            try {
                const r = await job.llm.chat({
                    messages: [
                        {
                            role: "user",
                            content: [
                                `<skill_json>\n${readFileSync(path.join(stage, "skill.json"), "utf8")}\n</skill_json>`,
                                `<skill_cjs>\n${readFileSync(path.join(stage, "skill.cjs"), "utf8")}\n</skill_cjs>`,
                                `<replay_report>\n${quoted(redact(JSON.stringify(report)))}\n</replay_report>`,
                                digest,
                            ].join("\n\n"),
                        },
                    ],
                    serverPromptSlug: "site-skill-review",
                    modelOverride: reviewModel,
                    thinkingLevel: "low",
                    responseFormat: "json_object",
                    timeoutMs: 60_000,
                    signal: job.signal,
                });
                verdict = JSON.parse(extractJSON(r.choices[0]?.message?.content ?? "") ?? "{}");
            } catch (e) {
                verdict = {
                    allow: false,
                    findings: [{ problem: `review failed: ${(e as Error).message}`.slice(0, 200) }],
                };
            }
            if (verdict.allow !== true) {
                if (reviews >= MAX_REVIEWS)
                    return { ok: false, content: "", end: { status: "failed", slug, reason: "review_denied" } };
                return {
                    ok: false,
                    content: JSON.stringify({
                        error: "the review denied this skill; fix every finding, write_skill, then finish",
                        review: verdict.findings ?? [],
                    }),
                };
            }
            const m = readJson(path.join(stage, "skill.json"));
            // A repair that names no assumptions keeps the skill's earlier ones.
            const list = (v: unknown, prior: unknown) =>
                Array.isArray(v) && (v.length || !rep) ? v.map(String).slice(0, 20) : Array.isArray(prior) ? prior : [];
            m.minted = {
                ...m.minted,
                model: opusTurns ? "opus" : "sonnet",
                verified: Object.fromEntries(
                    Object.entries(report.phases).map(([k, v]) => [k, v === "pass" ? "replay" : "unverified"]),
                ),
                assumptions: list(args.assumptions, m.minted?.assumptions),
                untested: list(args.untested, m.minted?.untested),
            };
            if (rep) return { ok: true, content: "", end: activate(rep, m) };
            writeFileSync(path.join(stage, "skill.json"), JSON.stringify(m, null, 2));
            keepFixture(t, { input: job.input, choice });
            const dir = install(stage, storeDir, slug);
            return { ok: true, content: "", end: { status: "installed", slug, dir } };
        },
        async report_blocked(args) {
            return {
                ok: true,
                content: "",
                end: {
                    status: "blocked",
                    slug,
                    reason: `${String(args.reason)}: ${String(args.detail ?? "").slice(0, 300)}`,
                },
            };
        },
    };

    if (rep) delete tools.write_skill;
    else delete tools.write_phase;
    const offered = rep ? REPAIR_TOOLS : MINT_TOOLS;
    const turnCap = rep ? Math.min(maxTurns(), REPAIR_TURNS) : maxTurns();
    const wallMs = rep ? REPAIR_WALL_MS : WALL_MS;

    const messages: ChatCompletionMessageParam[] = [{ role: "user", content: digest }];
    const captures: Array<{ msg: { content: string }; k: unknown }> = []; // read_capture results, oldest first
    let idle = 0;
    const finish = (r: Omit<MintResult, "jobId" | "credits" | "turns">): MintResult => {
        const out = { ...r, jobId, credits, turns };
        if (rep) {
            noteRepair(slug, rep.dir, out.status, out.reason);
            // A failed repair keeps the capture: the next day's repair (or the 3rd failure's archive) uses it up.
            if (
                out.status === "activated" ||
                out.status === "installed" ||
                readJson(path.join(rep.dir, "skill.json"))?.status === "archived"
            )
                rmSync(rep.captureDir, { recursive: true, force: true });
        }
        record({
            status: out.status,
            slug: out.slug,
            dir: out.dir,
            reason: out.reason,
            endedAt: new Date().toISOString(),
        });
        return out;
    };
    try {
        for (;;) {
            if (job.signal?.aborted) return finish({ status: "failed", slug, reason: "cancelled" });
            if (turns >= turnCap) return finish({ status: "failed", slug, reason: "max_turns" });
            if (Date.now() - started > wallMs) return finish({ status: "failed", slug, reason: "time_limit" });
            // Opus only once replays keep failing late in the job, and for 2 turns at most.
            model = failedReplays >= 2 && turns + 1 >= 6 && opusTurns < MAX_OPUS_TURNS ? MODELS.PRO : MODELS.SONNET;
            if (model === MODELS.PRO) opusTurns++;
            turns++;
            credits += creditCost(model);
            record({ status: "running", slug });
            let msg: { content?: string | null; tool_calls?: unknown[] } | undefined;
            try {
                const res = await job.llm.chat({
                    messages,
                    tools: offered,
                    serverPromptSlug: "site-skill-mint",
                    modelOverride: model,
                    thinkingLevel: "medium",
                    timeoutMs: 120_000,
                    signal: job.signal,
                });
                msg = res.choices[0]?.message;
            } catch (e) {
                if (job.signal?.aborted) return finish({ status: "failed", slug, reason: "cancelled" });
                return finish({ status: "failed", slug, reason: `llm_error: ${(e as Error).message}`.slice(0, 200) });
            }
            const calls = (msg?.tool_calls ?? []) as Array<{
                id: string;
                type: string;
                function: { name: string; arguments: string };
            }>;
            messages.push({
                role: "assistant",
                content: msg?.content ?? null,
                ...(calls.length ? { tool_calls: calls } : {}),
            } as ChatCompletionMessageParam);
            if (!calls.length) {
                if (++idle >= 2) return finish({ status: "failed", slug, reason: "no_tool_call" });
                messages.push({ role: "user", content: CONTINUE });
                continue;
            }
            idle = 0;
            // In order; the first error skips the rest of the reply.
            let stopped = false;
            for (const c of calls) {
                if (stopped) {
                    messages.push({
                        role: "tool",
                        tool_call_id: c.id,
                        content: JSON.stringify({ error: "skipped: an earlier call in this reply failed" }),
                    });
                    continue;
                }
                let out: ToolOutcome;
                const tool = tools[c.function?.name];
                let args: Record<string, unknown> = {};
                try {
                    args = JSON.parse(c.function?.arguments || "{}");
                } catch {}
                try {
                    out = tool
                        ? await tool(args)
                        : { ok: false, content: JSON.stringify({ error: `unknown tool ${c.function?.name}` }) };
                } catch (e) {
                    out = { ok: false, content: JSON.stringify({ error: (e as Error).message.slice(0, 300) }) };
                }
                if (job.signal?.aborted) return finish({ status: "failed", slug, reason: "cancelled" });
                if (out.end) return finish(out.end);
                const m = { role: "tool" as const, tool_call_id: c.id, content: out.content };
                messages.push(m);
                if (c.function.name === "read_capture" && out.ok) {
                    captures.push({ msg: m, k: args.k });
                    // Only the newest few captures stay whole; the model can read the rest again.
                    if (captures.length > FULL_CAPTURES) {
                        const old = captures[captures.length - FULL_CAPTURES - 1];
                        old.msg.content = `(read again with read_capture ${old.k})`;
                    }
                }
                if (!out.ok) stopped = true;
            }
        }
    } finally {
        if (ownBrowser) await browser?.close().catch(() => {});
        rmSync(stage, { recursive: true, force: true });
    }
}
