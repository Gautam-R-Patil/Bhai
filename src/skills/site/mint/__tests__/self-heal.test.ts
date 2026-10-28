// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// P4 of the Skill Minter, offline: a minted skill on the synthetic shop stops
// fitting the site (a renamed button), the run leaves a capture, Bhai finishes
// the task by hand while recording, and a scripted LLM re-mints only the broken
// phase. The runtime, capture, replay, gate, splice, activation, approval and
// rollback all run for real; only the model is scripted. No network, no real model.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMClient } from "../../../../llm.js";
import { _resetConsent, noteOwnerMessage } from "../../../../security/consent.js";
import { SHOP_RESOLVER_ARG, startShop } from "../../__tests__/synthetic-shop.js";
import { captureDrift, MAX_FAILED_REPAIRS, pendingRepair, repairBlocked, repairsDir, runLogPath } from "../../drift.js";
import type { SiteAction } from "../../host.js";
import { pageDriver } from "../../page-driver.js";
import { findSiteSkill } from "../../registry.js";
import { mintConsent, type PageDriver, runSiteTask } from "../../runtime.js";
import {
    approveSiteSkill,
    creditCost,
    fixturesDir,
    MINT_TOOLS,
    maxMintCredits,
    mintSiteSkill,
    phaseSource,
    REPAIR_TOOLS,
    repairSiteSkill,
    splicePhase,
} from "../minter.js";
import { drainTrace, startTrace, stopTrace } from "../recorder.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "site-mint-p4-"));
const INPUT = { query: "paneer" };
// The repairs run on another order than the mint's (paneer, Paneer Tikka): neither may reach the model.
const LATER = { query: "dal" };
const SECRETS = /paneer|\bdal\b|makhani/i;

// A minted skill whose search clicks #search by its id alone, and whose select
// checks the checkout button is there before it asks to pay.
const SEARCH = `search(ctx, lib) {
        const s = ctx.snapshot;
        const p = lib.path(s.url);
        if (p === "/results") {
            const options = s.elements
                .filter((e) => e.dataId)
                .map((e) => ({ id: e.dataId, label: (e.context || e.text).replace(/\\s*Add$/, ""), price: lib.price(e.context) }));
            return options.length ? { options } : { fail: { reason: "input_rejected: no results" } };
        }
        if (p === "/") {
            return { actions: [
                { op: "type", target: { sel: "#q" }, value: String(ctx.input.query || "") },
                { op: "click", target: { sel: "#search" } },
            ] };
        }
        return { actions: [{ op: "navigate", value: new URL("/", s.url).href }] };
    }`;
const select = (btn: string) => `select(ctx, lib) {
        const s = ctx.snapshot;
        const p = lib.path(s.url);
        if (p === "/cart") {
            if (!lib.el(s, { id: "${btn}" })) return { fail: { reason: "unexpected page /cart: no checkout button", kind: "unexpected_page" } };
            if (!lib.el(s, { id: "captcha" })?.checked) return { actions: [{ op: "click", target: { sel: "#captcha" } }] };
            const line = (/(.+₹\\s*[\\d,]+)/.exec(s.text) || [])[1] || "your order";
            return { confirm: { summary: line.trim(), amount: lib.price(s.text) || 0, submit: { op: "click", target: { sel: "#${btn}", text: "Place order" } } } };
        }
        if (p === "/results") return { actions: [{ op: "click", target: { sel: '[data-id="' + ctx.input.id + '"]' } }] };
        return { fail: { reason: "unexpected page " + p + " while selecting", kind: "unexpected_page" } };
    }`;
const SKILL = `// Minted for shop.test. Pure function of (phase, snapshot).
function interstitials(s, lib) {
    return lib.el(s, { id: "accept" }) ? { actions: [{ op: "click", target: { sel: "#accept" } }] } : null;
}
const phases = {
    ${SEARCH},
    ${select("checkout")},
    after_confirm(ctx, lib) {
        const s = ctx.snapshot;
        const p = lib.path(s.url);
        if (p === "/otp") {
            if (ctx.answer) return { actions: [{ op: "type", target: { sel: "#otp" }, value: ctx.answer }, { op: "click", target: { sel: "#verify" } }] };
            return { needsUser: { question: "otp", retry: /wrong code/i.test(s.text) } };
        }
        if (p === "/done") {
            const m = /Order placed #\\d+/.exec(s.text);
            return m ? { done: { summary: m[0] } } : { fail: { reason: "no order id on the page" } };
        }
        return { fail: { reason: "unexpected page " + p + " after confirm" } };
    },
};
exports.step = (phase, ctx, lib) =>
    interstitials(ctx.snapshot, lib) || phases[phase === "resume" ? "after_confirm" : phase](ctx, lib);
`;
const JSON_OK = {
    input: { query: { type: "string", required: true } },
    commits: [{ op: "click", target: { sel: "#checkout", text: "Place order" } }],
    questions: [{ id: "otp", kind: "otp", prompt: "Enter the code the shop sent to your phone" }],
    confirmPattern: "Order placed #\\d+",
};
// The repair of test 1: the search button found by the text the session showed.
const SEARCH_BY_TEXT = SEARCH.replace('{ sel: "#search" }', '{ text: "Search" }');

// ── The scripted model ────────────────────────

type Reply = { tools: Array<[string, Record<string, unknown>]> } | { review: object };
type ChatParams = Parameters<LLMClient["chat"]>[0];
function scriptedLLM(offered: unknown, script: Reply[]) {
    const calls: ChatParams[] = [];
    let n = 0;
    const llm = {
        config: {} as LLMClient["config"],
        async chat(p: ChatParams) {
            calls.push(JSON.parse(JSON.stringify(p)));
            const r = script.shift();
            if (!r) throw new Error("script ran out");
            if ("review" in r) {
                expect([p.serverPromptSlug, p.tools]).toEqual(["site-skill-review", undefined]);
                return { choices: [{ message: { role: "assistant", content: JSON.stringify(r.review) } }] };
            }
            // Every turn: the same slug and byte-identical tools (the prompt cache).
            expect(p.serverPromptSlug).toBe("site-skill-mint");
            expect(JSON.stringify(p.tools)).toBe(JSON.stringify(offered));
            const tool_calls = r.tools.map(([name, args]) => ({
                id: `c${++n}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
            }));
            return { choices: [{ message: { role: "assistant", content: null, tool_calls } }] };
        },
    } as unknown as LLMClient;
    return { llm, calls, left: () => script.length };
}
const toolResults = (p: ChatParams) =>
    p.messages.filter((m) => m.role === "tool").map((m) => String((m as { content: unknown }).content));
const billed = (calls: ChatParams[]) => calls.reduce((sum, c) => sum + creditCost(c.modelOverride ?? ""), 0);
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const neverSaw = (calls: ChatParams[], secret: RegExp) => {
    for (const c of calls)
        for (const m of c.messages.filter((x) => x.role !== "assistant"))
            expect(String((m as { content: unknown }).content)).not.toMatch(secret);
};

// ── Sessions ──────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: playwright is optional here
let browser: any = null;
let mintTrace = "";

/** Browser steps as the agent's tools would make them, drained after each; `commitAt` is the one the owner said yes to. */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page
async function recordByHand(page: any, steps: Array<() => Promise<unknown>>, commitAt = -1): Promise<string> {
    const dir = (await startTrace(page.context(), "shop.test", { root: tmp() })).dir;
    await drainTrace(page);
    for (const [i, step] of steps.entries()) {
        await step();
        await drainTrace(page, { consented: i === commitAt });
    }
    await stopTrace(page);
    return dir;
}

/** Mints SKILL from the recorded order into `store` and approves it, as the owner would. */
async function mintAndApprove(store: string): Promise<string> {
    const { llm } = scriptedLLM(MINT_TOOLS, [
        {
            tools: [
                ["write_skill", { skill_json: JSON_OK, skill_cjs: SKILL }],
                ["finish", { assumptions: ["one item per order"], untested: [] }],
            ],
        },
        { review: { allow: true, findings: [] } },
    ]);
    const r = await mintSiteSkill({ traceDir: mintTrace, llm, input: INPUT, storeDir: store, jobsDir: tmp(), browser });
    expect(r.status).toBe("installed");
    noteOwnerMessage("yes, approve the shop skill");
    expect(approveSiteSkill({ slug: "shop-test", userQuote: "approve the shop skill", storeDir: store }).ok).toBe(true);
    return r.dir as string;
}

beforeAll(async () => {
    process.env.ATLAS_SPEND_CAP_DAY_INR = "1000000";
    try {
        const { chromium } = await import("playwright");
        browser = await chromium.launch({ headless: true, args: [SHOP_RESOLVER_ARG] });
    } catch (e) {
        if (process.env.CI || process.env.SITE_E2E_REQUIRE_BROWSER) throw e;
        return;
    }
    const shop = await startShop();
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await page.goto(shop.url);
        mintTrace = await recordByHand(page, [
            () => page.click("#accept"),
            () => page.fill("#q", INPUT.query),
            () => page.click("#search"),
            () => page.click('[data-id="p1"]'),
            () => page.click("#captcha"),
            () => page.click("#checkout"),
        ]);
    } finally {
        await context.close();
        await shop.close();
    }
}, 60_000);
beforeEach(() => {
    process.env.ATLAS_DATA_DIR = tmp(); // run log, captures, repair history, fixtures: per test
    _resetConsent();
});
afterAll(async () => {
    delete process.env.ATLAS_SPEND_CAP_DAY_INR;
    delete process.env.ATLAS_DATA_DIR;
    await browser?.close();
});

// biome-ignore lint/suspicious/noExplicitAny: Playwright Page
async function order(page: any, store: string, url: string) {
    await page.goto(url);
    const driver = pageDriver(page);
    const s = await runSiteTask({
        skillPath: findSiteSkill(url, [store]) as string,
        phase: "search",
        input: { query: "dal" },
        driver,
    });
    expect(s.options?.map((o) => o.id)).toEqual(["d1"]);
    const c = await runSiteTask({ task: s.task, phase: "select", input: { id: "d1" }, driver });
    expect(c.confirm?.amount).toBe(199);
    return runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver });
}

/** A search on the shop with the renamed button drifts; Bhai then finishes a dal order by hand, recorded. */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page
async function searchDrift(page: any, shop: Awaited<ReturnType<typeof startShop>>, store: string) {
    await page.goto(shop.url);
    const skillPath = findSiteSkill(shop.url, [store]) as string;
    const r = await runSiteTask({ skillPath, phase: "search", input: LATER, driver: pageDriver(page) });
    const pending = pendingRepair("shop.test");
    const traceDir = await recordByHand(
        page,
        [
            () => page.fill("#q", LATER.query),
            () => page.click("#go"),
            () => page.click('[data-id="d1"]'),
            () => page.click("#captcha"),
            () => page.click("#checkout"),
        ],
        4,
    );
    return { r, pending, traceDir };
}
const SEARCH_FIX: Reply[] = [
    {
        tools: [
            ["write_phase", { phase: "search", source: SEARCH_BY_TEXT }],
            ["replay", {}],
        ],
    },
    { tools: [["finish", { assumptions: [], untested: [] }]] },
    { review: { allow: true, findings: [] } },
];

describe("self-healing a minted skill", () => {
    it("1. a renamed search button: drift → capture → repair of search only → live again by itself; the next run is done", async (ctx) => {
        if (!browser) return ctx.skip();
        const store = tmp();
        const skillDir = await mintAndApprove(store);
        const shop = await startShop({ renameSearch: true });
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            const { r, pending, traceDir } = await searchDrift(page, shop, store);
            // #search is gone: the skill can't get past the home page, and nothing was sent.
            expect([r.status, r.reason, r.writeStatus, r.retry, r.repairQueued]).toEqual([
                "aborted",
                "loop_identical_args",
                "not_attempted",
                "manual",
                true,
            ]);
            // The run log: one line, structure only.
            const log = readFileSync(runLogPath(), "utf8");
            expect(JSON.parse(log)).toMatchObject({ skill: "shop-test", phase: "search", drift: true, pagePath: "/" });
            expect(log).not.toMatch(SECRETS);
            // The capture: the failing page, its error and what the skill asked for.
            expect(pending?.capture).toMatchObject({ phase: "search", input: LATER, pagePath: "/", skillDir });
            expect(pending?.capture.lastError).toMatch(/^not_found: .*#search/);
            expect(readFileSync(path.join(pending?.captureDir ?? "", "page.html"), "utf8")).toContain('id="go"');
            expect(shop.orders()).toBe(1);

            const { llm, calls, left } = scriptedLLM(REPAIR_TOOLS, structuredClone(SEARCH_FIX));
            const t0 = Date.now();
            const fixed = await repairSiteSkill({
                traceDir,
                llm,
                skillDir,
                captureDir: pending?.captureDir ?? "",
                jobsDir: tmp(),
                browser,
            });
            const ms = Date.now() - t0;
            expect(left()).toBe(0);
            // Cost and speed: 2 Sonnet turns + 1 review, billed exactly, in seconds.
            expect(fixed).toMatchObject({
                status: "activated",
                slug: "shop-test",
                dir: skillDir,
                turns: 2,
                credits: 3,
            });
            expect(fixed.credits).toBe(billed(calls));
            expect(fixed.credits).toBeLessThanOrEqual(maxMintCredits(6));
            expect(ms).toBeLessThan(30_000);
            // The model was told what broke and given the phase's code; never the owner's values,
            // from this session (dal, Dal Makhani) or the one the skill was minted from (paneer).
            expect(String(calls[0].messages[0].content)).toMatch(/^REPAIR the shop-test skill/);
            expect(String(calls[0].messages[0].content)).toContain('{ sel: "#search" }');
            expect(String(calls[0].messages[0].content)).toContain("{{choice.label}}");
            neverSaw(calls, SECRETS);
            // Replay passed the new session from search and the session the skill was minted from.
            expect(JSON.parse(toolResults(calls[1]).at(-1) ?? "")).toMatchObject({
                ok: true,
                phases: { search: "pass", select: "pass", confirm: "pass", after_confirm: "pass" },
            });

            // Live at once: the manifest's safety fields are as they were. Only search changed.
            const old = readFileSync(path.join(skillDir, "skill.cjs.prev"), "utf8");
            const now = readFileSync(path.join(skillDir, "skill.cjs"), "utf8");
            expect(old).toBe(SKILL);
            expect(now).toBe(SKILL.replace(SEARCH, SEARCH_BY_TEXT));
            for (const p of ["select", "after_confirm", "interstitials"])
                expect(phaseSource(now, p)).toBe(phaseSource(old, p));
            expect(readJson(path.join(skillDir, "skill.json"))).toMatchObject({
                version: 2,
                status: "active",
                commits: JSON_OK.commits,
                minted: { approvedBy: "approve the shop skill", assumptions: ["one item per order"] },
            });
            expect(pendingRepair("shop.test")).toBeNull(); // the capture is used up

            // The next order on the changed site runs with no model.
            const done = await order(page, store, shop.url);
            expect([done.status, done.summary, shop.orders()]).toEqual(["done", "Order placed #2", 2]);
        } finally {
            await context.close();
            await shop.close();
        }
    }, 120_000);

    it("1b. with no earlier session left to check the other phases against, a repair waits for the owner", async (ctx) => {
        if (!browser) return ctx.skip();
        const store = tmp();
        const skillDir = await mintAndApprove(store);
        rmSync(fixturesDir(), { recursive: true, force: true }); // e.g. a skill minted before sessions were kept
        const shop = await startShop({ renameSearch: true });
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            const { pending, traceDir } = await searchDrift(page, shop, store);
            const { llm } = scriptedLLM(REPAIR_TOOLS, structuredClone(SEARCH_FIX));
            const fixed = await repairSiteSkill({
                traceDir,
                llm,
                skillDir,
                captureDir: pending?.captureDir ?? "",
                jobsDir: tmp(),
                browser,
            });
            // The safety fields are unchanged, but no earlier session was replayed: not live by itself.
            expect(fixed).toMatchObject({ status: "installed", dir: path.join(store, "shop-test.v2") });
            expect(readJson(path.join(store, "shop-test.v2", "skill.json")).status).toBe("awaiting_approval");
            expect(readFileSync(path.join(skillDir, "skill.cjs"), "utf8")).toBe(SKILL);
        } finally {
            await context.close();
            await shop.close();
        }
    }, 120_000);

    it("2. a renamed checkout button: the repair changes commits, so it waits for the owner's approval", async (ctx) => {
        if (!browser) return ctx.skip();
        const store = tmp();
        const skillDir = await mintAndApprove(store);
        const shop = await startShop({ renameIds: true });
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            await page.goto(shop.url);
            const driver = pageDriver(page);
            const s = await runSiteTask({
                skillPath: findSiteSkill(shop.url, [store]) as string,
                phase: "search",
                input: LATER,
                driver,
            });
            const r = await runSiteTask({ task: s.task, phase: "select", input: { id: "d1" }, driver });
            expect([r.status, r.reason, r.writeStatus, r.repairQueued]).toEqual([
                "failed",
                "unexpected page /cart: no checkout button",
                "not_attempted",
                true,
            ]);
            const pending = pendingRepair("shop.test");
            // The item picked, as the site named it: the hand session starts on the cart, past any typing.
            expect(pending?.capture).toMatchObject({
                phase: "select",
                input: { id: "d1" },
                searchInput: LATER,
                choice: "Dal Makhani — ₹199",
                pagePath: "/cart",
            });

            // Bhai finishes on the cart page by hand.
            const traceDir = await recordByHand(
                page,
                [() => page.click("#captcha"), () => page.click("#place-order-v2")],
                1,
            );
            const fixedSelect = select("place-order-v2");
            const { llm, calls } = scriptedLLM(REPAIR_TOOLS, [
                // Only the broken phase may change.
                { tools: [["write_phase", { phase: "search", source: SEARCH_BY_TEXT }]] },
                {
                    tools: [
                        [
                            "write_phase",
                            {
                                phase: "select",
                                source: fixedSelect,
                                skill_json: {
                                    commits: [{ op: "click", target: { sel: "#place-order-v2", text: "Place order" } }],
                                },
                            },
                        ],
                        ["replay", {}],
                    ],
                },
                { tools: [["finish", { assumptions: [], untested: [] }]] },
                { review: { allow: true, findings: [] } },
            ]);
            const fixed = await repairSiteSkill({
                traceDir,
                llm,
                skillDir,
                captureDir: pending?.captureDir ?? "",
                jobsDir: tmp(),
                browser,
            });
            expect(JSON.parse(toolResults(calls[1])[0]).error).toBe(
                "only phases.select (or interstitials) may change in this repair",
            );
            // The new session from select passes; on the old one only select's stale page fails.
            expect(JSON.parse(toolResults(calls[2]).at(-1) ?? "")).toMatchObject({
                ok: true,
                phases: { search: "pass", select: "pass", confirm: "pass", after_confirm: "pass" },
            });
            expect(fixed).toMatchObject({
                status: "installed",
                dir: path.join(store, "shop-test.v2"),
                turns: 3,
                credits: 4,
            });
            neverSaw(calls, SECRETS); // the cart's "Dal Makhani ₹199" included

            // Waiting beside the live one, which the registry still uses, unchanged.
            const waiting = readJson(path.join(store, "shop-test.v2", "skill.json"));
            expect(waiting).toMatchObject({
                status: "awaiting_approval",
                version: 2,
                commits: [{ target: { sel: "#place-order-v2" } }],
            });
            expect(findSiteSkill(shop.url, [store])).toBe(path.join(skillDir, "skill.cjs"));
            expect(readFileSync(path.join(skillDir, "skill.cjs"), "utf8")).toBe(SKILL);

            // The owner's yes, sent after the card, swaps it in; the order then goes through.
            expect(
                approveSiteSkill({ slug: "shop-test", userQuote: "approve the fixed shop skill", storeDir: store }).ok,
            ).toBe(false);
            noteOwnerMessage("ok, approve the fixed shop skill");
            expect(
                approveSiteSkill({ slug: "shop-test", userQuote: "approve the fixed shop skill", storeDir: store }).ok,
            ).toBe(true);
            expect(readFileSync(path.join(skillDir, "skill.cjs"), "utf8")).toBe(
                SKILL.replace(select("checkout"), fixedSelect),
            );
            const done = await order(page, store, shop.url);
            expect([done.status, shop.orders()]).toEqual(["done", 2]);
        } finally {
            await context.close();
            await shop.close();
        }
    }, 120_000);

    it("3. a failure after the submit (the order may exist) is never repaired", async (ctx) => {
        if (!browser) return ctx.skip();
        const store = tmp();
        const skillDir = await mintAndApprove(store);
        const shop = await startShop({ otp: true });
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            const ask = await order(page, store, shop.url);
            expect(ask.status).toBe("needs_user");
            await page.goto(`${shop.url}cart?id=d1`); // the page is not what after_confirm knows
            const r = await runSiteTask({
                task: ask.task,
                phase: "resume",
                answer: "123456",
                driver: pageDriver(page),
            });
            expect([r.status, r.reason, r.writeStatus, r.retry]).toEqual([
                "failed",
                "unexpected page /cart after confirm",
                "may_have_applied",
                "never",
            ]);
            expect(r.repairQueued).toBeUndefined();
            expect(pendingRepair("shop.test")).toBeNull();
            expect(existsSync(repairsDir())).toBe(false);
            const lines = readFileSync(runLogPath(), "utf8")
                .trim()
                .split("\n")
                .map((l) => JSON.parse(l));
            expect(lines.at(-1)).toMatchObject({ phase: "resume", writeStatus: "may_have_applied", drift: false });
            expect(readJson(path.join(skillDir, "skill.json")).status).toBe("active");
        } finally {
            await context.close();
            await shop.close();
        }
    }, 120_000);
});

// ── Without a browser ─────────────────────────

// A page where every action misses: each run drifts (loop_identical_args).
const missing: PageDriver = {
    snapshot: async () => ({ url: "http://shop.test/", title: "Shop", text: "", elements: [] }),
    act: async (a: SiteAction) => {
        throw new Error(`not_found: ${JSON.stringify(a.target)}`);
    },
};
function minted(store: string, extra: Record<string, unknown> = {}, prev?: string): string {
    const dir = path.join(store, "shop-test");
    mkdirSync(dir, { recursive: true });
    const m = {
        name: "shop-test",
        version: prev ? 2 : 1,
        status: "active",
        domains: ["shop.test"],
        effect: "write",
        paymentDomains: [],
        ...JSON_OK,
    };
    writeFileSync(path.join(dir, "skill.json"), JSON.stringify({ ...m, minted: { traceId: "t_none" }, ...extra }));
    writeFileSync(path.join(dir, "skill.cjs"), prev ? SKILL.replace("// Minted", "// Repaired, minted") : SKILL);
    if (prev) {
        writeFileSync(path.join(dir, "skill.cjs.prev"), prev);
        writeFileSync(
            path.join(dir, "skill.json.prev"),
            JSON.stringify({ ...m, version: 1, status: "drifted", minted: { traceId: "t_none" } }),
        );
    }
    return path.join(dir, "skill.cjs");
}
const drift = (skillPath: string) => runSiteTask({ skillPath, phase: "search", input: INPUT, driver: missing });

describe("marking and rollback", () => {
    it("4. a repaired version whose first 2 runs drift rolls back to .prev", async () => {
        const skillPath = minted(tmp(), {}, SKILL);
        const dir = path.dirname(skillPath);
        expect((await drift(skillPath)).repairQueued).toBe(true);
        expect(readFileSync(skillPath, "utf8")).not.toBe(SKILL); // one drift: kept
        await drift(skillPath);
        expect(readFileSync(skillPath, "utf8")).toBe(SKILL);
        expect([existsSync(`${skillPath}.prev`), existsSync(path.join(dir, "skill.json.prev"))]).toEqual([
            false,
            false,
        ]);
        expect(readJson(path.join(dir, "skill.json"))).toMatchObject({
            version: 1,
            status: "active",
            minted: { rolledBackAt: expect.any(String) },
        });
    });

    it("2 drifts in a skill's last 5 runs mark it drifted, and the registry skips it", async () => {
        const store = tmp();
        const skillPath = minted(store);
        await drift(skillPath);
        expect(findSiteSkill("http://shop.test/", [store])).toBe(skillPath);
        await drift(skillPath);
        expect(readJson(path.join(store, "shop-test", "skill.json")).status).toBe("drifted");
        expect(findSiteSkill("http://shop.test/", [store])).toBeNull();
    });

    it("a hand-written skill (no minted field) is never logged, captured or marked", async () => {
        const skillPath = minted(tmp(), { minted: undefined });
        for (let i = 0; i < 2; i++) expect((await drift(skillPath)).repairQueued).toBeUndefined();
        expect(existsSync(runLogPath())).toBe(false);
        expect(readJson(path.join(path.dirname(skillPath), "skill.json")).status).toBe("active");
    });
});

// A session written by hand: enough to start a repair that never replays.
function handTrace(text = "", dir = path.join(tmp(), "t_hand")): string {
    mkdirSync(path.join(dir, "pages"), { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id: path.basename(dir), domain: "shop.test" }));
    writeFileSync(
        path.join(dir, "pages", "0.json"),
        JSON.stringify({ url: "http://shop.test/", title: "Shop", text, elements: [] }),
    );
    writeFileSync(path.join(dir, "pages", "0.html"), "<html><body></body></html>");
    writeFileSync(
        path.join(dir, "trace.jsonl"),
        `${JSON.stringify({ k: 0, url: "http://shop.test/", title: "Shop", events: [] })}\n`,
    );
    return dir;
}

describe("repair limits", () => {
    const setup = async () => {
        const skillPath = minted(tmp());
        const captureDir = await captureDrift(
            skillPath,
            { skillHash: "h", phase: "search", input: INPUT, searchInput: INPUT, lastActions: [], pagePath: "/" },
            missing,
        );
        return {
            skillDir: path.dirname(skillPath),
            captureDir: captureDir as string,
            traceDir: handTrace(),
            jobsDir: tmp(),
        };
    };
    const history = (lines: Array<{ ago: number; status: string }>) => {
        mkdirSync(path.join(repairsDir(), "shop-test"), { recursive: true });
        writeFileSync(
            path.join(repairsDir(), "shop-test", "history.jsonl"),
            `${lines.map((l) => JSON.stringify({ at: Date.now() - l.ago, status: l.status })).join("\n")}\n`,
        );
    };

    it("one repair a day: a second is refused before any model call, costing nothing, and no capture is kept for it", async () => {
        const job = await setup();
        history([{ ago: 3_600_000, status: "activated" }]);
        const { llm, calls } = scriptedLLM(REPAIR_TOOLS, []);
        expect(await repairSiteSkill({ ...job, llm })).toMatchObject({
            status: "failed",
            reason: "rate_limited",
            credits: 0,
            turns: 0,
        });
        expect(calls).toHaveLength(0);
        expect(
            await captureDrift(
                path.join(job.skillDir, "skill.cjs"),
                { skillHash: "h", phase: "search", lastActions: [], pagePath: "/" },
                missing,
            ),
        ).toBeNull();
    });

    it(`archives the skill after ${MAX_FAILED_REPAIRS} failed repairs in a row`, async () => {
        const job = await setup();
        history([
            { ago: 3 * 86_400_000, status: "failed" },
            { ago: 2 * 86_400_000, status: "blocked" },
        ]);
        const { llm } = scriptedLLM(REPAIR_TOOLS, [
            { tools: [["report_blocked", { reason: "site_lacks_capability", detail: "the search is gone" }]] },
        ]);
        expect(await repairSiteSkill({ ...job, llm })).toMatchObject({ status: "blocked", credits: 1 });
        expect(readJson(path.join(job.skillDir, "skill.json")).status).toBe("archived");
        expect(findSiteSkill("http://shop.test/", [path.dirname(job.skillDir)])).toBeNull();
        expect(repairBlocked("shop-test", job.skillDir)).toBe("archived");
        expect(existsSync(job.captureDir)).toBe(false);
    });

    it("a drifted skill keeps its capture and is retried a day later; only the 3rd real failed repair archives it", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            const store = tmp();
            const skillPath = minted(store);
            const skillDir = path.dirname(skillPath);
            const status = () => readJson(path.join(skillDir, "skill.json")).status;
            expect((await drift(skillPath)).repairQueued).toBe(true);
            const captureDir = pendingRepair("shop.test")?.captureDir as string;
            for (let i = 1; i <= MAX_FAILED_REPAIRS; i++) {
                const { llm } = scriptedLLM(REPAIR_TOOLS, []); // the model call fails
                expect(
                    await repairSiteSkill({ traceDir: handTrace(), llm, skillDir, captureDir, jobsDir: tmp() }),
                ).toMatchObject({ status: "failed", reason: expect.stringMatching(/^llm_error/), credits: 1 });
                if (i === 1) {
                    // The next drift the same day marks it drifted (2 in its last 5 runs); no new
                    // capture can be made (rate limited), and the registry skips the skill.
                    expect((await drift(skillPath)).repairQueued).toBeUndefined();
                    expect(status()).toBe("drifted");
                    expect(findSiteSkill("http://shop.test/", [store])).toBeNull();
                }
                if (i === MAX_FAILED_REPAIRS) break;
                // The capture waits for the next day's repair.
                expect(pendingRepair("shop.test")?.captureDir).toBe(captureDir);
                expect(repairBlocked("shop-test", skillDir)).toBe("rate_limited");
                vi.setSystemTime(Date.now() + 86_400_000 + 60_000);
                expect(repairBlocked("shop-test", skillDir)).toBeNull();
            }
            expect(status()).toBe("archived");
            expect(repairBlocked("shop-test", skillDir)).toBe("archived");
            expect([existsSync(captureDir), pendingRepair("shop.test")]).toEqual([false, null]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("a resume that drifts is not captured: a repair can't re-mint after_confirm", async () => {
        const skillPath = minted(tmp());
        const r = await runSiteTask({ skillPath, phase: "resume", answer: "123456", driver: missing });
        expect([r.status, r.reason, r.writeStatus, r.repairQueued]).toEqual([
            "failed",
            "unexpected page / after confirm",
            "not_attempted",
            undefined,
        ]);
        expect(JSON.parse(readFileSync(runLogPath(), "utf8"))).toMatchObject({ phase: "resume", drift: true });
        expect(pendingRepair("shop.test")).toBeNull();
    });

    it("a live skill.cjs a repair can't read ends the job, before any model call", async () => {
        const job = await setup();
        writeFileSync(path.join(job.skillDir, "skill.cjs"), "exports.step = () => null;\n");
        const { llm, calls } = scriptedLLM(REPAIR_TOOLS, []);
        expect(await repairSiteSkill({ ...job, llm })).toMatchObject({
            status: "failed",
            reason: "repair_unreadable: skill.cjs has no phases.search",
            credits: 0,
        });
        expect(calls).toHaveLength(0);
    });

    it("a select repair hides the item the failing run picked, and an earlier select session's option id is not a value", async () => {
        const skillPath = minted(tmp(), { minted: { traceId: "t_none", repairTraceId: "t_sel" } });
        const text = "Your cart: Dal Makhani — ₹199. Also try Paneer Tikka — ₹249.";
        // An earlier select repair's session, kept with its option id as input.
        const sel = handTrace(text, path.join(fixturesDir(), "t_sel"));
        writeFileSync(path.join(sel, "replay.json"), JSON.stringify({ input: { id: "49" }, phase: "select" }));
        const cart: PageDriver = {
            ...missing,
            snapshot: async () => ({ url: "http://shop.test/cart", title: "Cart", text, elements: [] }),
        };
        const captureDir = (await captureDrift(
            skillPath,
            {
                skillHash: "h",
                phase: "select",
                input: { id: "d1" },
                searchInput: { query: "something" },
                choice: "Dal Makhani — ₹199",
                lastError: 'not_found: {"sel":"#checkout"} near Dal Makhani',
                lastActions: [{ op: "click", target: { sel: "#checkout", text: "Dal Makhani" } }],
                pagePath: "/cart",
            },
            cart,
        )) as string;
        const { llm, calls } = scriptedLLM(REPAIR_TOOLS, [
            { tools: [["read_capture", { k: 0 }]] },
            { tools: [["report_blocked", { reason: "other", detail: "test" }]] },
        ]);
        await repairSiteSkill({
            traceDir: handTrace(text),
            llm,
            skillDir: path.dirname(skillPath),
            captureDir,
            jobsDir: tmp(),
        });
        neverSaw(calls, /makhani/i);
        const page = toolResults(calls[1]).at(-1) ?? "";
        expect(page).toContain("{{choice.label}}");
        expect(page).toContain("₹249"); // not "₹2{{input.id}}"
        expect(page).not.toContain("{{input.id}}");
    });

    it("stops at 6 turns", async () => {
        const job = await setup();
        const { llm, calls, left } = scriptedLLM(
            REPAIR_TOOLS,
            Array.from({ length: 7 }, () => ({ tools: [["read_capture", { k: 0 }]] }) as Reply),
        );
        expect(await repairSiteSkill({ ...job, llm })).toMatchObject({
            status: "failed",
            reason: "max_turns",
            turns: 6,
            credits: 6,
        });
        expect([calls.length, left()]).toEqual([6, 1]);
    });
});

describe("splicing one phase", () => {
    it("replaces exactly that function, and refuses anything that is not exactly it", () => {
        const fresh = 'search(ctx, lib) { return { fail: { reason: "x" } }; }';
        const out = splicePhase(SKILL, "search", `${fresh},`);
        expect(phaseSource(out, "search")).toBe(fresh);
        expect(out.replace(fresh, SEARCH)).toBe(SKILL);
        const inter = "function interstitials(s, lib) { return null; }";
        expect(phaseSource(splicePhase(SKILL, "interstitials", inter), "interstitials")).toBe(inter);
        for (const bad of [
            "select(ctx, lib) { return null; }", // another phase
            'search(ctx, lib) { return null; } }), require("fs"), ({ x() {}', // breaks out of phases
            "search(ctx, lib) { return null; }, select(ctx, lib) { return null; }", // two members
            "search(ctx, lib) {", // does not parse
        ])
            expect(() => splicePhase(SKILL, "search", bad)).toThrow(/source/);
        expect(() => splicePhase(SKILL, "interstitials", "function interstitials() {} exports.step = 1;")).toThrow(
            /source/,
        );
        expect(() => splicePhase(SKILL, "checkout", fresh)).toThrow(/no phases.checkout/);
    });

    it("a comment around the function stays out, so the spliced file still parses (and the next write_phase works)", () => {
        const fresh = 'search(ctx, lib) { return { fail: { reason: "x" } }; }';
        const out = splicePhase(SKILL, "search", `// by text now\n${fresh} // by text now`);
        expect(phaseSource(out, "search")).toBe(fresh);
        expect(out).toBe(SKILL.replace(SEARCH, fresh));
        expect(phaseSource(splicePhase(out, "search", SEARCH_BY_TEXT), "select")).toBe(phaseSource(SKILL, "select"));
        const inter = "function interstitials(s, lib) { return null; } // none on this site";
        expect(phaseSource(splicePhase(SKILL, "interstitials", inter), "interstitials")).toBe(
            "function interstitials(s, lib) { return null; }",
        );
    });
});
