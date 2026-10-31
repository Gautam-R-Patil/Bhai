// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Can Microsoft-Decision-1 do the tool router's classifier job (which tool categories a
// request needs) faster and cheaper than the gpt-4.1-nano call? Ground truth: the tools
// that passing router runs of scripts/eval-computer-use.ts actually used.
//
//   AZ_ENDPOINT=… AZ_KEY=… DECISION_DEPLOYMENT=<name> RESULTS=<router run .jsonl> \
//     npx tsx scripts/bench-decision.ts
import "../src/config/env-compat.js"; // first: .env + ATLAS_* → BHAI_* mirror
import { readFileSync } from "node:fs";
import { categoryCatalog, initToolRouter, selectTools, setToolRouterLLM } from "../src/tool-router.js";

const RESOURCE = (process.env.AZ_ENDPOINT ?? "").replace(/\/openai\/v1\/?$/, "");
const DEPLOYMENT = process.env.DECISION_DEPLOYMENT ?? "";
const THRESHOLD = Number(process.env.THRESHOLD) || 0.5;

// Prompts from the eval's task list; the tools a passing router run used for each.
const src = readFileSync(new URL("./eval-computer-use.ts", import.meta.url), "utf8");
const prompts = new Map([...src.matchAll(/id: "(\w+)", prompt: "((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2].replace(/\\(.)/g, "$1")]));
const runs = readFileSync(process.env.RESULTS ?? "", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const cats = categoryCatalog().filter((c) => !c.alwaysInclude);
const catOf = (tool: string) => cats.find((c) => c.tools.includes(tool))?.name;
const cases = runs
    .filter((r) => r.ok && prompts.has(r.task))
    .map((r) => ({ id: r.task as string, prompt: prompts.get(r.task) as string, need: [...new Set((r.used as string[]).map(catOf).filter(Boolean))] as string[] }))
    .filter((c) => c.need.length);

async function decide(prompt: string) {
    const questions: Record<string, unknown> = {};
    for (const c of cats)
        questions[c.name] = {
            type: "noul",
            instructions: `Does this request to a computer assistant need tools for: ${c.description}`,
        };
    questions.primary = {
        type: "choice",
        instructions: "Which kind of tools does this request to a computer assistant mainly need?",
        criteria: Object.fromEntries(cats.map((c) => [c.name, c.description.slice(0, 280)])),
    };
    questions.tier = {
        type: "choice",
        instructions: "How much work is this request for a computer assistant?",
        criteria: {
            chat: "No tools at all: small talk, opinions, advice, writing, math, explaining, or general knowledge",
            simple: "One quick action or lookup on the computer or the web",
            standard: "A normal task with a few tool calls",
            complex: "Long multi-step work, coding, deep research, or careful reasoning",
        },
    };
    const t = Date.now();
    const res = await fetch(`${RESOURCE}/providers/microsoft/v1/systemone`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": process.env.AZ_KEY ?? "" },
        body: JSON.stringify({ model: DEPLOYMENT, state: prompt, questions }),
    });
    const j = (await res.json()) as { answers?: Record<string, { noul?: number; choice?: string }>; usage?: { input_tokens?: number }; error?: unknown };
    if (!j.answers) throw new Error(JSON.stringify(j).slice(0, 300));
    // PRIMARY=1: the one main category, plus others at ≥ STRICT (default 0.95), three at most.
    const strict = Number(process.env.STRICT) || 0.95;
    const primary = (j.answers as Record<string, { choice?: string }> | undefined)?.primary?.choice;
    const picked = process.env.PRIMARY === "1"
        ? [...new Set([primary, ...cats.map((c) => c.name).filter((n) => (j.answers?.[n]?.noul ?? 0) >= strict).sort((a, b) => (j.answers?.[b]?.noul ?? 0) - (j.answers?.[a]?.noul ?? 0))].filter(Boolean) as string[])].slice(0, 3)
        : cats.map((c) => c.name).filter((n) => (j.answers?.[n]?.noul ?? 0) >= THRESHOLD);
    return { picked, tier: j.answers?.tier?.choice, ms: Date.now() - t, tokens: j.usage?.input_tokens ?? 0 };
}

setToolRouterLLM({
    chat: async (o: { messages: { role: string; content: string }[]; systemPrompt?: string }) => {
        const r = await fetch(`${process.env.AZ_ENDPOINT}/chat/completions`, {
            method: "POST",
            headers: { "api-key": process.env.AZ_KEY ?? "", "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-4.1-nano", messages: [{ role: "system", content: o.systemPrompt ?? "" }, ...o.messages] }),
        });
        return r.json();
    },
} as never);
process.env.BHAI_TOOL_ROUTER_TIMEOUT_MS = "10000";
await initToolRouter();

// Chat turns must stay chat (the classifier's "chat lane" gets no tools).
for (const m of ["hey how are you", "write me a haiku about rain", "what's 17 times 23?", "explain how a vaccine works", "thanks bro", "which is better, python or javascript?"]) {
    const t = Date.now();
    const sel = await selectTools({ message: m, iteration: 1 });
    const nanoMs = Date.now() - t;
    const d = await decide(m);
    console.log(`CHAT ${m.padEnd(40)} nano tier=${sel.classification?.tier} ${nanoMs}ms | d1 tier=${d.tier} cats=[${d.picked}] ${d.ms}ms`);
}

const tally = { nano: { hit: 0, ms: [] as number[], n: 0 }, d1: { hit: 0, ms: [] as number[], n: 0, tokens: 0 } };
for (const c of cases) {
    const t = Date.now();
    const sel = await selectTools({ message: c.prompt, iteration: 1 });
    const nanoCats = sel.classification?.categories ?? [];
    tally.nano.ms.push(Date.now() - t);
    tally.nano.n += nanoCats.length;
    const nanoHit = c.need.every((n) => nanoCats.includes(n));
    if (nanoHit) tally.nano.hit++;
    const d = await decide(c.prompt).catch((e) => ({ picked: [] as string[], ms: 0, tokens: 0, err: (e as Error).message }));
    tally.d1.ms.push(d.ms);
    tally.d1.n += d.picked.length;
    tally.d1.tokens += d.tokens;
    const d1Hit = c.need.every((n) => d.picked.includes(n));
    if (d1Hit) tally.d1.hit++;
    console.log(`${c.id.padEnd(22)} need=[${c.need}]  nano ${nanoHit ? "✓" : "✗"} [${nanoCats}] ${sel.classification?.tier}  d1 ${d1Hit ? "✓" : "✗"} [${d.picked}] ${"tier" in d ? d.tier : ""} ${d.ms}ms${"err" in d ? ` ERR ${d.err}` : ""}`);
}
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const N = cases.length;
console.log(`\ngpt-4.1-nano classifier: covers ${tally.nano.hit}/${N}, ${(tally.nano.n / N).toFixed(1)} categories/request, median ${med(tally.nano.ms)}ms (whole selectTools)`);
console.log(`Microsoft-Decision-1:    covers ${tally.d1.hit}/${N}, ${(tally.d1.n / N).toFixed(1)} categories/request, median ${med(tally.d1.ms)}ms, ${Math.round(tally.d1.tokens / N)} input tokens/request ($${((tally.d1.tokens / N) * 0.042 / 1e6).toFixed(6)}/request)`);
process.exit(0);
