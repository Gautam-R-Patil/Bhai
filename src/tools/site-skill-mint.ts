// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// site_skill_mint / approve_site_skill: the agent's side of the Skill Minter
// (src/skills/site/mint). After Bhai finished a task on a site with the browser
// tools (site_task had no skill, so the session was recorded locally), the
// owner can say "learn this site": start mints a skill from that recording in
// the background (one job at a time), status reports it, and once it is
// installed the owner sees an approval card. Only the owner's own words, sent
// after the card, make it live (approve_site_skill → ownerSaid).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { LLMClient } from "../llm.js";
import { approveSiteSkill, maxMintCredits, mintJobsDir, mintSiteSkill } from "../skills/site/mint/minter.js";
import { loadTrace, stopTrace, tracesDir, tracing } from "../skills/site/mint/recorder.js";
import { getActivePage } from "./browser/core.js";
import { isQuoteAcceptable } from "./forge-approval.js";
import type { ToolDefinition } from "./get-current-time.js";

let llm: LLMClient | null = null;
export function setSiteMintLLM(client: LLMClient): void {
    llm = client;
}

// ponytail: one mint at a time, in this process; a restart drops the running job (its trace stays on disk).
let running: { id: string; ctrl: AbortController } | null = null;

const readJson = (p: string) => {
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    } catch {
        return null;
    }
};
const hostOf = (url: string) => {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
};

/** The newest recorded session on `domain` (or a subdomain of it). */
function latestTrace(domain: string): string | null {
    const root = tracesDir();
    if (!existsSync(root)) return null;
    return (
        readdirSync(root)
            .map((id) => path.join(root, id))
            .filter((d) => {
                const m = readJson(path.join(d, "meta.json"));
                return (
                    m &&
                    (domain === m.domain || domain.endsWith(`.${m.domain}`)) &&
                    existsSync(path.join(d, "trace.jsonl"))
                );
            })
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null
    );
}

/** What the owner approves: the site, what it may click and ask, and what was and wasn't checked. */
function approvalCard(dir: string) {
    const m = readJson(path.join(dir, "skill.json"));
    if (!m) return null;
    return {
        slug: m.name,
        site: m.domains?.join(", "),
        places_orders: m.effect === "write",
        commit_button: m.commits?.map(
            (c: { target?: { text?: string; sel?: string } }) => c.target?.text ?? c.target?.sel,
        ),
        may_ask: m.questions?.map((q: { prompt: string }) => q.prompt),
        verified: m.minted?.verified,
        untested: m.minted?.untested,
        assumptions: m.minted?.assumptions,
    };
}

export const siteSkillMintTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "site_skill_mint",
            description:
                "Learn the site open in the browser from the session Bhai just completed there with the browser tools, so next time site_task does it in ~3 steps. Only when the user agreed to it (it costs credits). start runs in the background; status reports it and, when ready, the approval card to show the user; cancel stops it.",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["start", "status", "cancel"] },
                    query: {
                        type: "string",
                        description:
                            "start: what the user searched for in that session (default: the first text typed)",
                    },
                    choice: { type: "string", description: "start: the name of the item the user picked, if any" },
                    job_id: { type: "string", description: "status: a job id (default: the latest)" },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        const action = String(input.action ?? "");
        if (action === "cancel") {
            if (!running) return JSON.stringify({ error: "No site skill is being learned." });
            running.ctrl.abort();
            return JSON.stringify({ ok: true, job_id: running.id, status: "cancelling" });
        }
        if (action === "status") {
            const dir = mintJobsDir();
            const id =
                (input.job_id as string | undefined) ??
                (existsSync(dir)
                    ? readdirSync(dir)
                          .filter((f) => f.endsWith(".json"))
                          .sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)[0]
                          ?.replace(/\.json$/, "")
                    : undefined);
            const job = id && /^m_[a-f0-9]+$/.test(id) ? readJson(path.join(dir, `${id}.json`)) : null;
            if (!job) return JSON.stringify({ error: "No site skill job found." });
            const card = job.status === "installed" && job.dir ? approvalCard(job.dir) : null;
            const next =
                job.status === "running"
                    ? "Still learning; check again in a minute."
                    : card
                      ? "Show the user this card and ask whether to trust this skill. Only after they reply yes, call approve_site_skill with the slug and their exact words."
                      : "Tell the user it couldn't learn this site, and why; the browser tools still work.";
            return JSON.stringify({
                job_id: job.id,
                status: job.status,
                reason: job.reason,
                credits: job.credits,
                turns: job.turns,
                card,
                next_step: next,
            });
        }
        if (action !== "start") return JSON.stringify({ error: `Unknown action: ${action}` });

        if (process.env.ATLAS_NO_SITE_MINT === "true")
            return JSON.stringify({ error: "Learning sites is turned off." });
        if (!llm) return JSON.stringify({ error: "The model client isn't ready yet." });
        if (running)
            return JSON.stringify({ error: `Already learning a site (job ${running.id}). Wait for it or cancel it.` });
        const page = await getActivePage();
        const domain = tracing(page) ?? hostOf(page.url());
        if (tracing(page)) await stopTrace(page); // the session ends here
        const traceDir = domain ? latestTrace(domain) : null;
        if (!traceDir) {
            return JSON.stringify({
                error: `No recorded session on ${domain || "this site"}. Do the task with the browser tools first (site_task starts recording when it has no skill).`,
            });
        }
        const query =
            (input.query as string | undefined) ??
            loadTrace(traceDir)
                .pages.flatMap((p) => p.events)
                .find((e) => e.op === "fill" && typeof e.value === "string" && e.value)?.value;
        if (!query) return JSON.stringify({ error: "Pass query: what the user searched for in that session." });

        const ctrl = new AbortController();
        const id = `m_${Date.now().toString(16)}`;
        const done = mintSiteSkill({
            traceDir,
            llm,
            input: { query: String(query) },
            choice: input.choice as string | undefined,
            jobId: id,
            signal: ctrl.signal,
        });
        running = { id, ctrl };
        void done.finally(() => {
            if (running?.id === id) running = null;
        });
        return JSON.stringify({
            job_id: id,
            status: "running",
            max_credits: maxMintCredits(),
            next_step: `Tell the user Bhai is learning ${domain} in the background (at most ${maxMintCredits()} credits, usually 4-8). Check with site_skill_mint status in a minute or two.`,
        });
    },
};

export const approveSiteSkillTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "approve_site_skill",
            description:
                "Make a learned site skill live after the user saw its approval card and said yes. user_quote MUST be the user's verbatim reply (≥10 chars); generic words like 'ok' are rejected.",
            parameters: {
                type: "object",
                properties: {
                    slug: { type: "string", description: "The skill's slug from the card, e.g. shop-test" },
                    user_quote: { type: "string", description: "The user's own approval words, verbatim" },
                },
                required: ["slug", "user_quote"],
            },
        },
    },
    async handler(input) {
        const quote = String(input.user_quote ?? "");
        const check = isQuoteAcceptable(quote);
        if (!check.ok) return JSON.stringify({ ok: false, error: check.reason });
        return JSON.stringify(approveSiteSkill({ slug: String(input.slug ?? ""), userQuote: quote }));
    },
};
