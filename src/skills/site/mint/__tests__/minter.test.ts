// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// P2 of the Skill Minter, offline: a scripted LLM (a fake LLMClient that pops
// predetermined replies and checks what it was offered) drives the minter over
// a session recorded on the synthetic shop. The static gate, replay, review,
// install, the owner's approval and a full run of the minted skill all happen
// for real; only the model is scripted. No network, no real model.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMClient } from "../../../../llm.js";
import { _resetConsent, noteOwnerMessage } from "../../../../security/consent.js";
import { SHOP_RESOLVER_ARG, startShop } from "../../__tests__/synthetic-shop.js";
import { SkillHost } from "../../host.js";
import { pageDriver } from "../../page-driver.js";
import { findSiteSkill } from "../../registry.js";
import { mintConsent, runSiteTask } from "../../runtime.js";
import { checkSkill } from "../checks.js";
import { approveSiteSkill, creditCost, MINT_TOOLS, maxMintCredits, mintSiteSkill, recordedValues } from "../minter.js";
import { drainTrace, loadTrace, startTrace, stopTrace } from "../recorder.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "site-mint-p2-"));
const INPUT = { query: "paneer" };
const CHOICE = "Paneer Tikka";
const OTP = "123456";

// The reference skill in the minted shape: what a good minter writes.
const SKILL = `// Minted for shop.test. Pure function of (phase, snapshot).
function interstitials(s, lib) {
    return lib.el(s, { id: "accept" }) ? { actions: [{ op: "click", target: { sel: "#accept" } }] } : null;
}
const phases = {
    search(ctx, lib) {
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
    },
    select(ctx, lib) {
        const s = ctx.snapshot;
        const p = lib.path(s.url);
        if (p === "/cart") {
            if (!lib.el(s, { id: "captcha" })?.checked) return { actions: [{ op: "click", target: { sel: "#captcha" } }] };
            const line = (/(.+₹\\s*[\\d,]+)/.exec(s.text) || [])[1] || "your order";
            return { confirm: { summary: line.trim(), amount: lib.price(s.text) || 0, submit: { op: "click", target: { sel: "#checkout", text: "Place order" } } } };
        }
        if (p === "/results") return { actions: [{ op: "click", target: { sel: '[data-id="' + ctx.input.id + '"]' } }] };
        return { fail: { reason: "unexpected page " + p + " while selecting" } };
    },
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
const mutate = (from: string, to: string) => {
    expect(SKILL.split(from)).toHaveLength(2); // applies exactly once
    return SKILL.replace(from, to);
};

// ── The scripted model ────────────────────────

type Reply = { tools: Array<[string, Record<string, unknown>]> } | { text: string } | { review: object | string };
type ChatParams = Parameters<LLMClient["chat"]>[0];
function scriptedLLM(script: Reply[]) {
    const calls: ChatParams[] = [];
    let n = 0;
    const llm = {
        config: {} as LLMClient["config"],
        async chat(p: ChatParams) {
            calls.push(JSON.parse(JSON.stringify(p))); // the minter edits its history in place later
            const r = script.shift();
            if (!r) throw new Error("script ran out");
            if ("review" in r) {
                // One review call, no tools, JSON out.
                expect([p.serverPromptSlug, p.tools, p.responseFormat]).toEqual([
                    "site-skill-review",
                    undefined,
                    "json_object",
                ]);
                const content = typeof r.review === "string" ? r.review : JSON.stringify(r.review);
                return { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] };
            }
            // Every minting turn: the same slug and byte-identical tools (the prompt cache).
            expect(p.serverPromptSlug).toBe("site-skill-mint");
            expect(JSON.stringify(p.tools)).toBe(JSON.stringify(MINT_TOOLS));
            expect(p.timeoutMs).toBe(120_000);
            if ("text" in r)
                return { choices: [{ message: { role: "assistant", content: r.text }, finish_reason: "stop" }] };
            const tool_calls = r.tools.map(([name, args]) => ({
                id: `c${++n}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
            }));
            return {
                choices: [{ message: { role: "assistant", content: null, tool_calls }, finish_reason: "tool_calls" }],
            };
        },
    } as unknown as LLMClient;
    return { llm, calls, left: () => script.length };
}
const toolResults = (p: ChatParams) =>
    p.messages.filter((m) => m.role === "tool").map((m) => String((m as { content: unknown }).content));
const lastToolResult = (p: ChatParams) => toolResults(p).at(-1) ?? "";
const billed = (calls: ChatParams[]) => calls.reduce((sum, c) => sum + creditCost(c.modelOverride ?? ""), 0);

// A session written by hand (no browser): enough for the gate and the budgets.
function handTrace(): string {
    const dir = path.join(tmp(), "t_hand");
    mkdirSync(path.join(dir, "pages"), { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id: "t_hand", domain: "shop.test" }));
    const d = (id: string, tag = "button") => ({ tag, id, path: `body > ${tag}:nth-child(1)` });
    const pages = [
        {
            url: "http://shop.test/",
            title: "Shop",
            events: [{ op: "fill", target: d("q", "input"), value: "paneer", url: "http://shop.test/" }],
            text: "Search",
        },
        {
            url: "http://shop.test/cart?id=p1",
            title: "Cart",
            events: [
                {
                    op: "click",
                    target: { ...d("checkout"), text: "Place order" },
                    url: "http://shop.test/cart?id=p1",
                    consented: true,
                },
            ],
            text: "Paneer Tikka ₹249 Place order",
        },
        { url: "http://shop.test/done?n=48213", title: "Done", events: [], text: "Order placed #48213" },
    ];
    pages.forEach((p, k) => {
        writeFileSync(
            path.join(dir, "pages", `${k}.json`),
            JSON.stringify({ url: p.url, title: p.title, text: p.text, elements: [{ tag: "input", id: "q" }] }),
        );
        writeFileSync(path.join(dir, "pages", `${k}.html`), "<html><body></body></html>");
    });
    writeFileSync(
        path.join(dir, "trace.jsonl"),
        `${pages.map((p, k) => JSON.stringify({ k, url: p.url, title: p.title, events: p.events })).join("\n")}\n`,
    );
    return dir;
}

// ── The recorded session ──────────────────────

// biome-ignore lint/suspicious/noExplicitAny: playwright is optional here
let browser: any = null;
let traceDir = "";
const store = tmp();
const jobsDir = tmp();
beforeAll(async () => {
    process.env.ATLAS_SPEND_CAP_DAY_INR = "1000000";
    try {
        const { chromium } = await import("playwright");
        browser = await chromium.launch({ headless: true, args: [SHOP_RESOLVER_ARG] });
    } catch (e) {
        if (process.env.CI || process.env.SITE_E2E_REQUIRE_BROWSER) throw e;
        return;
    }
    // The agent's order, with plain Playwright calls standing in for its browser tools.
    const shop = await startShop({ otp: true });
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        traceDir = (await startTrace(context, "shop.test", { root: tmp() })).dir;
        await page.goto(shop.url);
        await drainTrace(page);
        for (const [step, consented] of [
            [() => page.click("#accept"), false],
            [() => page.fill("#q", INPUT.query), false],
            [() => page.click("#search"), false],
            [() => page.click('[data-id="p1"]'), false],
            [() => page.click("#captcha"), false],
            [() => page.click("#checkout"), true],
            [() => page.fill("#otp", OTP), false],
            [() => page.click("#verify"), false],
        ] as Array<[() => Promise<void>, boolean]>) {
            await step();
            await drainTrace(page, { consented });
        }
        await stopTrace(page);
    } finally {
        await context.close();
        await shop.close();
    }
}, 60_000);
afterAll(async () => {
    delete process.env.ATLAS_SPEND_CAP_DAY_INR;
    await browser?.close();
});

describe("minting a skill from the recorded order", () => {
    let installed = "";
    // Said before the skill existed: never counts as approving it.
    const EARLY = "learn this site, and approve the shop skill when it's ready";

    it("gate → replay → review → install as awaiting_approval, for 5 credits, the model never seeing the owner's values", async (ctx) => {
        if (!browser) return ctx.skip();
        _resetConsent();
        noteOwnerMessage(EARLY);
        const hardCoded = mutate('String(ctx.input.query || "")', '"paneer"');
        const { llm, calls, left } = scriptedLLM([
            // 1. the query hard-coded, and a replay in the same reply (skipped: the write failed)
            {
                tools: [
                    ["read_capture", { k: 3 }],
                    ["write_skill", { skill_json: JSON_OK, skill_cjs: hardCoded }],
                    ["replay", {}],
                ],
            },
            // 2. the reference skill, claiming another site's domain
            { tools: [["write_skill", { skill_json: { ...JSON_OK, domains: ["evil.com"] }, skill_cjs: SKILL }]] },
            { tools: [["replay", {}]] }, // 3
            { tools: [["finish", { assumptions: ["one item per order"], untested: ["sold-out item"] }]] }, // 4
            { review: { allow: true, findings: [] } },
        ]);
        const t0 = Date.now();
        const r = await mintSiteSkill({
            traceDir,
            llm,
            input: INPUT,
            choice: CHOICE,
            storeDir: store,
            jobsDir,
            browser,
        });
        const ms = Date.now() - t0;
        expect(left()).toBe(0);
        expect(r).toMatchObject({ status: "installed", slug: "shop-test", turns: 4 });

        const [, second, third, fourth, review] = calls;
        // 1 — the hard-coded query is found and named by its placeholder; the rest of the reply is skipped.
        const firstWrite = JSON.parse(toolResults(second).at(-2) ?? "{}");
        expect(firstWrite.saved).toBe(false);
        expect(firstWrite.findings).toContainEqual(
            expect.objectContaining({ id: "example_literal", severity: "error" }),
        );
        expect(firstWrite.findings[0].detail).toContain("{{input.query}}");
        expect(lastToolResult(second)).toContain("skipped: an earlier call in this reply failed");
        // 2 — the host keeps the session's domain and says so.
        const secondWrite = JSON.parse(lastToolResult(third));
        expect(secondWrite.saved).toBe(true);
        expect(secondWrite.findings.map((f: { id: string }) => f.id)).toEqual(["domains_overridden"]);
        // 3 — replay passes all four phases.
        expect(JSON.parse(lastToolResult(fourth))).toMatchObject({
            ok: true,
            phases: { search: "pass", select: "pass", confirm: "pass", after_confirm: "pass" },
        });
        // 4 — the review saw the skill and the replay report.
        expect(String(review.messages[0].content)).toContain("exports.step");
        expect(review.modelOverride).toMatch(/sonnet/);

        // Installed, waiting: the registry does not use it yet.
        installed = r.dir ?? "";
        expect(installed).toBe(path.join(store, "shop-test"));
        const m = JSON.parse(readFileSync(path.join(installed, "skill.json"), "utf8"));
        expect(m).toMatchObject({
            name: "shop-test",
            status: "awaiting_approval",
            domains: ["shop.test"],
            effect: "write",
            commits: JSON_OK.commits,
            minted: {
                verified: { search: "replay", select: "replay", confirm: "replay", after_confirm: "replay" },
                untested: ["sold-out item"],
                approvedBy: null,
            },
        });
        expect(findSiteSkill("http://shop.test/", [store])).toBeNull();
        expect(existsSync(path.join(store, "_staging", r.jobId))).toBe(false);
        expect(JSON.parse(readFileSync(path.join(jobsDir, `${r.jobId}.json`), "utf8"))).toMatchObject({
            status: "installed",
            credits: 5,
        });

        // Cost: 4 Sonnet turns + 1 Sonnet review = 5 credits, exactly what was billed, under the cap.
        expect(r.credits).toBe(5);
        expect(r.credits).toBe(billed(calls));
        expect(r.credits).toBeLessThanOrEqual(maxMintCredits());
        // Speed: the whole loop, two replays included, is seconds (the model's own time aside).
        expect(ms).toBeLessThan(30_000);
        // Privacy: no user or tool message carries the owner's query, chosen item or code.
        for (const c of calls)
            for (const msg of c.messages.filter((x) => x.role !== "assistant"))
                for (const secret of [/paneer/i, /123456/])
                    expect(String((msg as { content: unknown }).content)).not.toMatch(secret);
    }, 120_000);

    it("goes live only on the owner's own words, sent after it was ready", (ctx) => {
        if (!installed) return ctx.skip();
        expect(approveSiteSkill({ slug: "shop-test", userQuote: "approve the shop skill", storeDir: store }).ok).toBe(
            false,
        ); // said before
        expect(approveSiteSkill({ slug: "shop-test", userQuote: "trust the new shop skill", storeDir: store }).ok).toBe(
            false,
        ); // never said
        expect(findSiteSkill("http://shop.test/", [store])).toBeNull();
        noteOwnerMessage("Yes, approve the shop skill");
        expect(
            approveSiteSkill({ slug: "shop-test", userQuote: "approve the shop skill", storeDir: store }),
        ).toMatchObject({ ok: true });
        expect(findSiteSkill("http://shop.test/", [store])).toBe(path.join(installed, "skill.cjs"));
        expect(JSON.parse(readFileSync(path.join(installed, "skill.json"), "utf8"))).toMatchObject({
            status: "active",
            minted: { approvedBy: "approve the shop skill" },
        });
    });

    it("runs on the shop with no model: search → select → confirm → OTP → done, one order", async (ctx) => {
        if (!browser || !findSiteSkill("http://shop.test/", [store])) return ctx.skip();
        const shop = await startShop({ otp: true });
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            await page.goto(shop.url);
            const driver = pageDriver(page);
            const skillPath = findSiteSkill(shop.url, [store]) as string;
            const s = await runSiteTask({ skillPath, phase: "search", input: { query: "dal" }, driver });
            expect(s.options?.map((o) => o.label)).toEqual(["Dal Makhani — ₹199"]);
            const c = await runSiteTask({ task: s.task, phase: "select", input: { id: "d1" }, driver });
            expect(c.confirm?.amount).toBe(199);
            const ask = await runSiteTask({
                task: c.task,
                phase: "confirm",
                consentToken: mintConsent(c.task),
                driver,
            });
            expect([ask.status, ask.needsUser?.prompt]).toEqual([
                "needs_user",
                "Enter the code the shop sent to your phone",
            ]);
            const done = await runSiteTask({ task: ask.task, phase: "resume", answer: OTP, driver });
            expect([done.status, done.summary, shop.orders()]).toEqual(["done", "Order placed #1", 1]);
        } finally {
            await context.close();
            await shop.close();
        }
    }, 60_000);

    it("a newer version waits beside the live one, and approval swaps it in", async (ctx) => {
        if (!installed || !browser) return ctx.skip();
        const { llm } = scriptedLLM([
            {
                tools: [
                    ["write_skill", { skill_json: JSON_OK, skill_cjs: SKILL }],
                    ["finish", { assumptions: [], untested: [] }],
                ],
            },
            { review: { allow: true, findings: [] } },
        ]);
        const r = await mintSiteSkill({ traceDir, llm, input: INPUT, storeDir: store, jobsDir, browser });
        expect(r).toMatchObject({ status: "installed", dir: path.join(store, "shop-test.v2"), credits: 2 });
        expect(findSiteSkill("http://shop.test/", [store])).toBe(path.join(installed, "skill.cjs")); // v1 still live
        noteOwnerMessage("ok approve the updated shop skill");
        expect(
            approveSiteSkill({ slug: "shop-test", userQuote: "approve the updated shop skill", storeDir: store }).ok,
        ).toBe(true);
        expect(JSON.parse(readFileSync(path.join(installed, "skill.json"), "utf8"))).toMatchObject({
            version: 2,
            status: "active",
        });
        expect(existsSync(path.join(store, "shop-test.v2"))).toBe(false);
    }, 60_000);
});

describe("minted code runs with no require, process or globals of ours", () => {
    it("loads a minted skill in a fresh vm context, a hand-written one with require", async () => {
        const probe =
            "exports.step = () => ({ done: { summary: [typeof require, typeof process, typeof globalThis.process, typeof URL].join() } });";
        const results: unknown[] = [];
        for (const minted of [true, false]) {
            const dir = tmp();
            writeFileSync(path.join(dir, "skill.cjs"), probe);
            writeFileSync(
                path.join(dir, "skill.json"),
                JSON.stringify({ name: "x", domains: ["x.in"], ...(minted && { minted: {} }) }),
            );
            const host = new SkillHost(path.join(dir, "skill.cjs"));
            try {
                results.push(await host.call("search", {}));
            } finally {
                host.close();
            }
        }
        expect(results).toEqual([
            { done: { summary: "undefined,undefined,undefined,function" } },
            { done: { summary: "function,object,object,function" } },
        ]);
    });
});

describe("the static gate", () => {
    const trace = loadTrace(handTrace());
    const values = recordedValues(trace, INPUT, CHOICE);
    const gate = (skillCjs: string, skillJson: object = JSON_OK) =>
        checkSkill({ skillJson, skillCjs, trace, values, domains: ["shop.test"] });

    it("passes the minted reference skill with no findings", async () => {
        expect((await gate(SKILL)).findings).toEqual([]);
    });

    it.for([
        ["a generated class", '{ sel: "#q" }', '{ sel: ".css-1x2y3z input" }', "selector"],
        ["a CSS-module class", '{ sel: "#search" }', '{ sel: "button.Search__btn_3kXq" }', "selector"],
        ["data-atlas-id", '{ sel: "#search" }', '{ sel: "[data-atlas-id=\\"12\\"]" }', "selector"],
        [
            "require",
            "function interstitials(s, lib) {",
            'const fs = require("fs");\nfunction interstitials(s, lib) {',
            "banned",
        ],
        ["process", 'if (p === "/") {', 'if (p === "/") { process.exit(1);', "banned"],
        [
            "the constructor escape",
            "function interstitials(s, lib) {",
            'const f = ({}).constructor.constructor("return 1");\nfunction interstitials(s, lib) {',
            "banned",
        ],
        [
            "a computed constructor",
            "function interstitials(s, lib) {",
            'const f = ({})["constructor"];\nfunction interstitials(s, lib) {',
            "banned",
        ],
        [
            "a loop with no exit",
            "function interstitials(s, lib) {",
            "for (;;) {}\nfunction interstitials(s, lib) {",
            "banned",
        ],
        [
            "a timer",
            "function interstitials(s, lib) {",
            "setTimeout(() => {}, 1);\nfunction interstitials(s, lib) {",
            "banned",
        ],
        ["an undeclared question", 'question: "otp"', 'question: "pin"', "question"],
        ["a computed question", 'question: "otp"', 'question: "o" + "tp"', "question"],
        [
            "the commit clicked in select",
            '{ op: "click", target: { sel: "#captcha" } }',
            '{ op: "click", target: { sel: "#checkout" } }',
            "commit_outside_confirm",
        ],
        [
            "the chosen item hard-coded",
            ".filter((e) => e.dataId)",
            '.filter((e) => e.dataId && e.context.includes("Paneer Tikka"))',
            "example_literal",
        ],
        ["the amount hard-coded", "amount: lib.price(s.text) || 0", "amount: 249", "example_literal"],
        [
            "the order id hard-coded",
            "{ done: { summary: m[0] } }",
            '{ done: { summary: "Order placed #48213" } }',
            "example_literal",
        ],
        ["a phone number", '"your order"', '"call 98765 43210"', "pii_literal"],
        ["a missing phase", "after_confirm(ctx, lib) {", "afterConfirm(ctx, lib) {", "shape"],
    ] as Array<[string, string, string, string]>)("refuses %s", async ([, from, to, id]) => {
        const { findings } = await gate(mutate(from, to));
        expect(findings.filter((f) => f.severity === "error").map((f) => f.id)).toContain(id);
    });

    it("refuses a bad manifest, a missing commit and a payment domain off the allowlist", async () => {
        const ids = async (j: object) => (await gate(SKILL, j)).findings.map((f) => f.id);
        expect(await ids({ ...JSON_OK, confirmPattern: "(" })).toContain("manifest");
        expect(await ids({ ...JSON_OK, questions: [{ id: "OTP code", kind: "otp", prompt: "Code?" }] })).toContain(
            "manifest",
        );
        expect(await ids({ ...JSON_OK, commits: [] })).toContain("commits");
        expect(await ids({ ...JSON_OK, paymentDomains: ["evil-pay.com"] })).toContain("payment_domain");
        expect(await ids({ ...JSON_OK, paymentDomains: ["razorpay.com"] })).toEqual([]);
    });

    it("warns, without refusing, on :nth-child", async () => {
        const { findings } = await gate(mutate('{ sel: "#q" }', '{ sel: "form > input:nth-child(1)" }'));
        expect(findings).toEqual([expect.objectContaining({ id: "selector", severity: "warning" })]);
    });
});

describe("budgets", () => {
    const trace = handTrace();
    const job = (llm: LLMClient) =>
        mintSiteSkill({ traceDir: trace, llm, input: INPUT, storeDir: tmp(), jobsDir: tmp() });

    it("stops at 12 turns, keeping only the 3 newest captures whole", async () => {
        const { llm, calls, left } = scriptedLLM(
            Array.from({ length: 13 }, (_, i) => ({ tools: [["read_capture", { k: i % 3 }]] }) as Reply),
        );
        const r = await job(llm);
        expect(r).toMatchObject({ status: "failed", reason: "max_turns", turns: 12, credits: 12 });
        expect([calls.length, left()]).toEqual([12, 1]);
        const results = toolResults(calls[11]);
        expect(results.filter((c) => c.startsWith("<page_data>"))).toHaveLength(3);
        expect(results.filter((c) => c.startsWith("(read again with read_capture"))).toHaveLength(8);
        expect(results.at(-1)).toContain('"url":"/cart?id=p1"');
        // Redacted: the typed query is a placeholder in every capture.
        expect(results.join("")).not.toMatch(/paneer/i);
    });

    it("ends after two replies in a row with no tool call, nudging once", async () => {
        const { llm, calls } = scriptedLLM([
            { text: "I think it's done." },
            { text: "Done." },
            { tools: [["replay", {}]] },
        ]);
        const r = await job(llm);
        expect(r).toMatchObject({ status: "failed", reason: "no_tool_call", turns: 2 });
        expect(String(calls[1].messages.at(-1)?.content)).toMatch(/^Your reply did not finish the task/);
    });

    it("a tool call between the two texts resets the count", async () => {
        const { llm } = scriptedLLM([
            { text: "Hmm." },
            { tools: [["read_capture", { k: 0 }]] },
            { text: "Hmm." },
            { tools: [["report_blocked", { reason: "trace_incomplete", detail: "never reached results" }]] },
        ]);
        expect(await job(llm)).toMatchObject({
            status: "blocked",
            reason: "trace_incomplete: never reached results",
            turns: 4,
        });
    });

    it("refuses replay and finish before a clean write, and an unknown tool, without crashing", async () => {
        const { llm, calls } = scriptedLLM([
            { tools: [["replay", {}]] },
            { tools: [["finish", { assumptions: [], untested: [] }]] },
            { tools: [["delete_everything", {}]] },
            { tools: [["read_capture", { k: 99 }]] },
            { tools: [["report_blocked", { reason: "other", detail: "x" }]] },
        ]);
        expect(await job(llm)).toMatchObject({ status: "blocked", credits: 5 });
        expect(toolResults(calls[4]).map((c) => JSON.parse(c).error)).toEqual([
            "call write_skill first",
            "write a skill with no errors first",
            "unknown tool delete_everything",
            "no page k=99; k runs 0..2",
        ]);
    });

    it("a review that keeps denying ends the job after 2 rounds, installing nothing", async (ctx) => {
        if (!browser) return ctx.skip();
        const deny = { allow: false, findings: [{ quote: "#checkout", problem: "x", fix: "y" }] };
        const { llm, calls, left } = scriptedLLM([
            { tools: [["write_skill", { skill_json: JSON_OK, skill_cjs: SKILL }]] },
            { tools: [["finish", { assumptions: [], untested: [] }]] },
            { review: deny },
            { tools: [["finish", { assumptions: [], untested: [] }]] },
            { review: "not json at all" }, // unreadable counts as a denial
            { tools: [["finish", { assumptions: [], untested: [] }]] },
            { review: { allow: true, findings: [] } },
        ]);
        const storeDir = tmp();
        const r = await mintSiteSkill({ traceDir, llm, input: INPUT, storeDir, jobsDir, browser });
        expect(r).toMatchObject({ status: "failed", reason: "review_denied", turns: 3, credits: 5 });
        expect(calls.filter((c) => c.serverPromptSlug === "site-skill-review")).toHaveLength(2);
        expect(left()).toBe(2);
        expect(JSON.parse(lastToolResult(calls[3])).review).toEqual(deny.findings);
        expect(findSiteSkill("http://shop.test/", [storeDir])).toBeNull();
        expect(existsSync(path.join(storeDir, "shop-test"))).toBe(false);
    }, 60_000);

    it("escalates to Opus for at most 2 turns after 2 failed replays at turn ≥6, billing each call", async (ctx) => {
        if (!browser) return ctx.skip();
        const bad = (sel: string) => mutate('{ sel: "#q" }', `{ sel: "${sel}" }`);
        const { llm, calls } = scriptedLLM([
            { tools: [["write_skill", { skill_json: JSON_OK, skill_cjs: bad("#nope") }]] }, // 1
            { tools: [["replay", {}]] }, // 2: fails
            { tools: [["write_skill", { skill_json: JSON_OK, skill_cjs: bad("#nope2") }]] }, // 3
            { tools: [["replay", {}]] }, // 4: fails
            { tools: [["read_capture", { k: 1 }]] }, // 5: still Sonnet (turn < 6)
            { tools: [["read_capture", { k: 1 }]] }, // 6: Opus
            { tools: [["read_capture", { k: 1 }]] }, // 7: Opus
            { tools: [["read_capture", { k: 1 }]] }, // 8: Sonnet again (the Opus cap)
            { tools: [["report_blocked", { reason: "other", detail: "gave up" }]] }, // 9
        ]);
        const r = await mintSiteSkill({ traceDir, llm, input: INPUT, storeDir: tmp(), jobsDir, browser });
        expect(JSON.parse(lastToolResult(calls[2]))).toMatchObject({ ok: false, failures: [{ verdict: "mismatch" }] });
        expect(lastToolResult(calls[2])).not.toMatch(/paneer/i); // a failure quoting the typed value is redacted too
        expect(calls.map((c) => (/opus/.test(c.modelOverride ?? "") ? "O" : "S")).join("")).toBe("SSSSSOOSS");
        expect(r).toMatchObject({ status: "blocked", turns: 9, credits: 11 });
        expect(r.credits).toBe(billed(calls));
    }, 60_000);

    it("caps the worst case at 16 credits for 12 turns", () => {
        expect(maxMintCredits(12)).toBe(16);
        expect(creditCost("anthropic/claude-opus-4.6")).toBe(2);
        expect(creditCost("anthropic/claude-haiku-4.5")).toBe(0.25);
        expect(creditCost("anthropic/claude-sonnet-4.6")).toBe(1);
    });
});
