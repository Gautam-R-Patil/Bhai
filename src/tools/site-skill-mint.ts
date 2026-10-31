// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// site_skill_mint / approve_site_skill: the agent's side of the Skill Minter
// (src/skills/site/mint). After Bhai finished a task on a site with the browser
// tools (site_task had no skill, so the session was recorded locally), the
// owner can say "learn this site": start mints a skill from that recording in
// the background (one job at a time), status reports it, and when the job
// ends the owner is told through proactive dispatch, on the channel they asked
// on: the approval card when it was installed, else why not and what it cost.
// Only the owner's own words, sent after the card, make it live
// (approve_site_skill → ownerSaid).
//
// repair: after site_task reported that the site changed under a learned skill
// (repairQueued) and Bhai finished that task by hand while recording, re-mints
// just the broken phase in the background (repairSiteSkill). A repair that
// leaves what the skill may click and ask unchanged goes live by itself; any
// other comes back as an approval card.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { LLMClient } from "../llm.js";
import type { Channel } from "../proactive/intent.js";
import { pendingRepair } from "../skills/site/drift.js";
import {
    approveSiteSkill,
    type MintResult,
    maxMintCredits,
    mintJobsDir,
    mintSiteSkill,
    repairSiteSkill,
} from "../skills/site/mint/minter.js";
import { loadTrace, stopTrace, sweepTraces, tracesDir, tracing } from "../skills/site/mint/recorder.js";
import { getActivePage } from "./browser/core.js";
import { getActiveChannel } from "./channel-send.js";
import { isQuoteAcceptable } from "./forge-approval.js";
import type { ToolDefinition } from "./get-current-time.js";

let llm: LLMClient | null = null;
/** At boot: the model for minting, and old recorded sessions cleared out. */
export function setSiteMintLLM(client: LLMClient): void {
    llm = client;
    try {
        sweepTraces();
    } catch {}
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

const CHANNELS: Channel[] = ["whatsapp", "telegram", "discord", "slack", "matrix", "email", "overlay"];
const WHY: Record<string, string> = {
    max_turns: "it ran out of attempts",
    time_limit: "it ran out of time",
    review_denied: "the safety review didn't pass it",
    no_tool_call: "the model stopped before finishing",
    rate_limited: "it already had a repair attempt today",
    archived: "its last 3 repairs failed (ask me to learn the site again)",
    repairs_off: "repairs are turned off",
};

/** The message the owner gets when a mint ends (null: nothing to say, e.g. it was cancelled). */
export function mintNotice(r: MintResult, domain: string): string | null {
    if (r.reason === "cancelled") return null;
    if (r.status === "activated")
        return `${domain} changed, so I fixed my skill for it; it's working again (checked against your sessions there). That used ${r.credits} credits.`;
    const card = r.status === "installed" && r.dir ? approvalCard(r.dir) : null;
    if (!card) {
        const why = WHY[r.reason ?? ""] ?? (r.reason || "it couldn't finish");
        return `I couldn't learn ${domain}: ${why}. That used ${r.credits} credits. The browser tools still work there.`;
    }
    const list = (xs: unknown) => (Array.isArray(xs) && xs.length ? xs.map(String).join("; ") : "none");
    const verified = Object.entries(card.verified ?? {})
        .filter(([, v]) => v === "replay")
        .map(([k]) => k);
    return [
        `I learned ${card.site}: next time an order there takes about 3 steps. Before I use it, please check:`,
        `- Places orders: ${card.places_orders ? `yes, only by clicking "${list(card.commit_button)}" after you say yes to the total` : "no"}`,
        `- May ask you: ${list(card.may_ask)}`,
        `- Checked by replaying your session: ${verified.join(", ") || "nothing"}`,
        `- Not tested: ${list(card.untested)}`,
        `It used ${r.credits} credits. To turn it on, reply "approve the ${card.slug} skill".`,
    ].join("\n");
}

/** Tells the owner how a mint ended; never throws. */
async function notifyOwner(r: MintResult, domain: string, channel: Channel): Promise<void> {
    const text = mintNotice(r, domain);
    if (!text) return;
    try {
        const { dispatchProactiveMessage } = await import("../proactive/dispatch.js");
        await dispatchProactiveMessage(channel, text, r.status === "installed" ? "review" : "fyi");
    } catch (e) {
        console.warn(`[site-mint] couldn't notify the owner: ${(e as Error).message}`);
    }
}

export const siteSkillMintTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "site_skill_mint",
            description:
                "Learn the site open in the browser from the session Bhai just completed there with the browser tools, so next time site_task does it in ~3 steps. Only when the user agreed to it (it costs credits). start runs in the background; status reports it and, when ready, the approval card to show the user; cancel stops it. repair: only when site_task said the site changed (repairQueued) and you then finished the task with the browser tools; fixes that skill in the background.",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["start", "status", "cancel", "repair"] },
                    query: {
                        type: "string",
                        description:
                            "start: what the user searched for in that session (default: the first text typed)",
                    },
                    choice: {
                        type: "string",
                        description: "start: the name of the item the user picked (default: read from the session)",
                    },
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
                    : job.status === "activated"
                      ? "The skill was repaired and is live again; site_task works on that site."
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
        if (action !== "start" && action !== "repair") return JSON.stringify({ error: `Unknown action: ${action}` });

        if (process.env.BHAI_NO_SITE_MINT === "true")
            return JSON.stringify({ error: "Learning sites is turned off." });
        if (!llm) return JSON.stringify({ error: "The model client isn't ready yet." });
        if (running)
            return JSON.stringify({ error: `Already learning a site (job ${running.id}). Wait for it or cancel it.` });
        const page = await getActivePage();
        const domain = tracing(page) ?? hostOf(page.url());
        if (tracing(page)) await stopTrace(page); // the session ends here
        const traceDir = domain ? latestTrace(domain) : null;
        const ctrl = new AbortController();
        const id = `m_${Date.now().toString(16)}`;
        const asked = getActiveChannel() ?? process.env.PRIMARY_CHANNEL ?? "telegram";
        const channel: Channel = CHANNELS.includes(asked as Channel) ? (asked as Channel) : "telegram";
        const launch = (done: Promise<MintResult>) => {
            running = { id, ctrl };
            void done
                .then((r) => notifyOwner(r, domain, channel))
                .catch((e) => console.warn(`[site-mint] job ${id} broke: ${(e as Error)?.message ?? e}`))
                .finally(() => {
                    if (running?.id === id) running = null;
                });
        };

        if (action === "repair") {
            const pending = domain ? pendingRepair(domain) : null;
            if (!pending)
                return JSON.stringify({
                    error: `No learned skill on ${domain || "this site"} is waiting for a repair.`,
                });
            // Only a session recorded after the skill failed shows the changed site.
            if (
                !traceDir ||
                Date.parse(readJson(path.join(traceDir, "meta.json"))?.startedAt ?? "") < pending.capture.at
            )
                return JSON.stringify({
                    error: "No session recorded since the skill failed. Finish the task with the browser tools first, then call repair.",
                });
            launch(
                repairSiteSkill({
                    traceDir,
                    llm,
                    skillDir: pending.capture.skillDir,
                    captureDir: pending.captureDir,
                    jobId: id,
                    signal: ctrl.signal,
                }),
            );
            return JSON.stringify({
                job_id: id,
                status: "running",
                max_credits: maxMintCredits(6),
                next_step: `Bhai is fixing its ${domain} skill in the background; it messages the user when done. Nothing to tell them unless they ask.`,
            });
        }
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

        launch(
            mintSiteSkill({
                traceDir,
                llm,
                input: { query: String(query) },
                choice: input.choice as string | undefined,
                jobId: id,
                signal: ctrl.signal,
            }),
        );
        return JSON.stringify({
            job_id: id,
            status: "running",
            max_credits: maxMintCredits(),
            next_step: `Tell the user Bhai is learning ${domain} in the background (at most ${maxMintCredits()} credits, usually 4-8) and will message them when it's ready to approve.`,
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
