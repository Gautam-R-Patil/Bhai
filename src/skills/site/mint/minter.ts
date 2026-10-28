// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
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
// credentials and phone numbers are masked. Recorded HTML never leaves the
// machine; only replay reads it.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getDataDir } from "../../../config/paths.js";
import { type ChatCompletionMessageParam, type ChatCompletionTool, type LLMClient, MODELS } from "../../../llm.js";
import { ownerSaid } from "../../../security/consent.js";
import { maskCredentials } from "../../../security/credential-mask.js";
import { redactPii } from "../../../security/pii-redactor.js";
import { knownForms } from "../../../security/value-forms.js";
import { extractJSON } from "../../../utils/json-extract.js";
import { checkSkill, type Finding, type MintedManifest, type RecordedValue } from "./checks.js";
import { commitEvent, type Descriptor, type LoadedTrace, loadTrace } from "./recorder.js";
import { type ReplayReport, replaySkill } from "./replay.js";

export const maxTurns = () => Math.max(1, Number(process.env.ATLAS_SITE_MINT_MAX_TURNS) || 12);
const WALL_MS = 10 * 60_000;
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
// A code the replay types where the owner typed theirs (the real one was never recorded).
const REPLAY_ANSWER = "424242";

export interface MintJob {
    traceDir: string;
    llm: LLMClient;
    /** The search input as the owner gave it, e.g. {query: "paneer"}: replay types it and probes with others. */
    input: Record<string, string>;
    /** The label of the item the owner picked, if known: hidden from the model and banned from the code. */
    choice?: string;
    storeDir?: string;
    jobsDir?: string;
    jobId?: string;
    // biome-ignore lint/suspicious/noExplicitAny: a running Playwright Browser to reuse for replays
    browser?: any;
    signal?: AbortSignal;
}
export interface MintResult {
    status: "installed" | "blocked" | "failed";
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

const CONTINUE =
    "Your reply did not finish the task. Continue: fix the skill and call finish, or call report_blocked. Another reply without a tool call ends this attempt.";

// ── Redaction ─────────────────────────────────

const PHONE = /(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
    return `<page_data>\n${redact(lines.join("\n"))}\n</page_data>\nUse read_capture {k} for a page's full elements and text.`;
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
 * Moves a staged skill into the store as awaiting_approval. A live skill for the
 * site is never overwritten: the new one waits in <slug>.v<n>/ until approved.
 */
function install(stage: string, storeDir: string, slug: string): string {
    const manifest = readJson(path.join(stage, "skill.json"));
    let dest = path.join(storeDir, slug);
    const live = readJson(path.join(dest, "skill.json"));
    if (live && (live.status ?? "active") === "active") {
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

// ── The loop ──────────────────────────────────

interface ToolOutcome {
    ok: boolean;
    content: string;
    end?: Omit<MintResult, "jobId" | "credits" | "turns">;
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
    const domains = [t.domain.replace(/^www\./, "")];
    const slug = domains[0]
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const commit = commitEvent(t);
    const effect = commit ? "write" : "read";
    const values = recordedValues(t, job.input, job.choice);
    const redact = redactor(values);
    const digest = buildDigest(t, redact, job.input);
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
        const report = await replaySkill(path.join(stage, "skill.cjs"), t, {
            input: job.input,
            answer: REPLAY_ANSWER,
            browser,
        });
        replayed = { seq: written.seq, report };
        if (!report.ok) failedReplays++;
        return report;
    };
    const blockingErrors = () => written?.findings.filter((f) => f.severity === "error") ?? [];

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
                    content: `<page_data>k=${p.k} is off the site (${p.url}); nothing was kept.</page_data>`,
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
            return { ok: true, content: `<page_data>${cut}</page_data>` };
        },
        async write_skill(args) {
            const cjs = typeof args.skill_cjs === "string" ? args.skill_cjs : "";
            const { manifest, findings } = await checkSkill({
                skillJson: args.skill_json,
                skillCjs: cjs,
                trace: t,
                values,
                domains,
            });
            written = { seq: (written?.seq ?? 0) + 1, manifest, findings };
            mkdirSync(stage, { recursive: true });
            writeFileSync(path.join(stage, "skill.cjs"), cjs);
            const {
                domains: _d,
                assumptions = [],
                untested = [],
                ...fields
            } = manifest ?? ({} as Partial<MintedManifest>);
            writeFileSync(
                path.join(stage, "skill.json"),
                JSON.stringify(
                    {
                        name: slug,
                        version: 1,
                        status: "awaiting_approval",
                        domains,
                        effect,
                        paymentDomains: [],
                        ...fields,
                        minted: {
                            at: null,
                            model: "sonnet",
                            traceId: t.id,
                            verified: {},
                            assumptions,
                            untested,
                            approvedBy: null,
                        },
                    },
                    null,
                    2,
                ),
            );
            const ok = !findings.some((f) => f.severity === "error");
            return { ok, content: JSON.stringify({ saved: ok, findings }) };
        },
        async replay() {
            if (!written) return { ok: false, content: JSON.stringify({ error: "call write_skill first" }) };
            if (blockingErrors().length)
                return {
                    ok: false,
                    content: JSON.stringify({ error: "fix the write_skill errors first", findings: blockingErrors() }),
                };
            const report = await replay();
            return { ok: report.ok, content: redact(JSON.stringify(report)) }; // a failure can quote a typed value
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
                return { ok: false, content: redact(JSON.stringify({ error: "replay must pass", report })) };
            if (report.phases.search !== "pass")
                return { ok: false, content: redact(JSON.stringify({ error: "search must pass replay", report })) };
            // One review call; Haiku is enough for a skill that cannot order.
            reviews++;
            const reviewModel = effect === "read" ? MODELS.HAIKU : MODELS.SONNET;
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
                                `<replay_report>\n${redact(JSON.stringify(report))}\n</replay_report>`,
                                digest,
                            ].join("\n\n"),
                        },
                    ],
                    serverPromptSlug: "site-skill-review",
                    modelOverride: reviewModel,
                    thinkingLevel: "low",
                    responseFormat: "json_object",
                    timeoutMs: 60_000,
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
            m.minted = {
                ...m.minted,
                model: opusTurns ? "opus" : "sonnet",
                verified: Object.fromEntries(
                    Object.entries(report.phases).map(([k, v]) => [k, v === "pass" ? "replay" : "unverified"]),
                ),
                assumptions: (Array.isArray(args.assumptions) ? args.assumptions : []).map(String).slice(0, 20),
                untested: (Array.isArray(args.untested) ? args.untested : []).map(String).slice(0, 20),
            };
            writeFileSync(path.join(stage, "skill.json"), JSON.stringify(m, null, 2));
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

    const messages: ChatCompletionMessageParam[] = [{ role: "user", content: digest }];
    const captures: Array<{ msg: { content: string }; k: unknown }> = []; // read_capture results, oldest first
    let idle = 0;
    const finish = (r: Omit<MintResult, "jobId" | "credits" | "turns">): MintResult => {
        const out = { ...r, jobId, credits, turns };
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
            if (turns >= maxTurns()) return finish({ status: "failed", slug, reason: "max_turns" });
            if (Date.now() - started > WALL_MS) return finish({ status: "failed", slug, reason: "time_limit" });
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
                    tools: MINT_TOOLS,
                    serverPromptSlug: "site-skill-mint",
                    modelOverride: model,
                    thinkingLevel: "medium",
                    timeoutMs: 120_000,
                });
                msg = res.choices[0]?.message;
            } catch (e) {
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
