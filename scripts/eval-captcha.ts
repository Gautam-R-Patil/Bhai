// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Measures how often Bhai gets past a CAPTCHA on its own, against the public
// demo pages Google, hCaptcha and Cloudflare publish for testing. No owner
// hand-off: a run passes only when the widget holds a response token.
//
// Usage:
//   npx tsx scripts/eval-captcha.ts [--type recaptcha|hcaptcha|turnstile|all] [--runs 20] [--tier waterfall|vision]
// Model for the vision solver: ATLAS_CAPTCHA_MODEL (default Sonnet). Needs a
// Bhai session (ATLAS_OTPLESS_USER_ID). Writes data/captcha-eval/<time>.json.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDataDir } from "../src/config/paths.js";
import { loadConfig } from "../src/config.js";
import { createLLMClient } from "../src/llm.js";
import { initSession } from "../src/session.js";
import { switchToPlaywright } from "../src/tools/browser/browser-backend.js";
import { captchaSolved, detectCaptcha, handleCaptchaIfPresent } from "../src/tools/browser/captcha.js";
import { setCaptchaLLM, solveWithVision } from "../src/tools/browser/captcha-vision.js";
import { getBrowser } from "../src/tools/browser/core.js";

const DEMOS = {
    recaptcha: "https://www.google.com/recaptcha/api2/demo",
    hcaptcha: "https://accounts.hcaptcha.com/demo",
    turnstile: "https://nopecha.com/demo/cloudflare",
} as const;
type Kind = keyof typeof DEMOS;

const arg = (name: string, dflt: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
};
const typeArg = arg("type", "all");
const runs = Number(arg("runs", "20"));
const tier = arg("tier", "waterfall");
const kinds = (typeArg === "all" ? Object.keys(DEMOS) : [typeArg]) as Kind[];

type Run = { kind: Kind; ok: boolean; method: string; ms: number; modelCalls: number; error?: string };

async function main() {
    process.env.ATLAS_CAPTCHA_HANDOFF_MS = "0";
    if (!(await initSession())) throw new Error("initSession failed: set ATLAS_OTPLESS_USER_ID (Bhai sign-in)");
    const llm = createLLMClient(loadConfig());
    let calls = 0;
    setCaptchaLLM({ ...llm, chat: (...a: Parameters<typeof llm.chat>) => (calls++, llm.chat(...a)) });
    switchToPlaywright();
    const ctx = await getBrowser();

    const results: Run[] = [];
    for (const kind of kinds) {
        for (let i = 0; i < runs; i++) {
            calls = 0;
            const start = Date.now();
            const page = await ctx.newPage();
            let run: Run;
            try {
                await page.goto(DEMOS[kind], { waitUntil: "domcontentloaded", timeout: 30_000 });
                await page.waitForTimeout(2500);
                const info = await detectCaptcha(page);
                let method = "none_detected";
                if (info.type !== "none") {
                    if (tier === "vision") {
                        method = (await solveWithVision(page, captchaSolved)) ? "vision" : "unsolved";
                    } else {
                        method = (await handleCaptchaIfPresent(page)).method;
                    }
                }
                const ok = (await captchaSolved(page)) || method === "passive_stealth";
                run = { kind, ok, method, ms: Date.now() - start, modelCalls: calls };
            } catch (err) {
                run = {
                    kind,
                    ok: false,
                    method: "error",
                    ms: Date.now() - start,
                    modelCalls: calls,
                    error: (err as Error).message.slice(0, 200),
                };
            }
            await page.close().catch(() => {});
            results.push(run);
            console.log(
                `${kind} #${i + 1}: ${run.ok ? "PASS" : "FAIL"} via ${run.method} in ${(run.ms / 1000).toFixed(1)}s, ${run.modelCalls} model call(s)${run.error ? ` (${run.error})` : ""}`,
            );
        }
    }

    console.log("\n── Summary ──");
    for (const kind of kinds) {
        const rs = results.filter((r) => r.kind === kind);
        const pass = rs.filter((r) => r.ok).length;
        const methods = Object.entries(
            rs.reduce<Record<string, number>>((m, r) => ((m[r.method] = (m[r.method] ?? 0) + 1), m), {}),
        );
        const avg = (f: (r: Run) => number) => (rs.reduce((s, r) => s + f(r), 0) / rs.length).toFixed(1);
        console.log(
            `${kind}: ${pass}/${rs.length} = ${((100 * pass) / rs.length).toFixed(0)}% | avg ${avg((r) => r.ms / 1000)}s, ${avg((r) => r.modelCalls)} model calls | ${methods.map(([m, n]) => `${m}:${n}`).join(" ")}`,
        );
    }
    const dir = path.join(getDataDir(), "captcha-eval");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ model: process.env.ATLAS_CAPTCHA_MODEL ?? "sonnet", tier, results }, null, 2));
    console.log(`\nSaved ${file}`);
    await ctx.close().catch(() => {});
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
