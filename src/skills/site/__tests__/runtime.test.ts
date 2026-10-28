// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Site Skill runtime guarantees, no browser: a fake page driver records actions.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SkillHost, type SiteAction } from "../host.js";
import { MAX_STEPS, mintConsent, runSiteTask } from "../runtime.js";

const dir = mkdtempSync(path.join(tmpdir(), "site-skills-"));
let n = 0;
const skill = (body: string) => {
    const p = path.join(dir, `s${n++}.cjs`);
    writeFileSync(p, body);
    return p;
};
const fakeDriver = () => {
    const calls: SiteAction[] = [];
    return {
        calls,
        snapshot: async () => ({ url: "http://shop.test/x", title: "", text: "", elements: [] }),
        act: async (a: SiteAction) => {
            calls.push(a);
        },
    };
};

// Only the hang fixtures need a short deadline; everything else keeps the real
// 5s one, so a slow CI runner (Windows process spawn) isn't read as a hang.
const shortDeadline = (on: boolean) => {
    if (on) process.env.ATLAS_SITE_SKILL_DEADLINE_MS = "1000";
    else delete process.env.ATLAS_SITE_SKILL_DEADLINE_MS;
};
afterAll(() => shortDeadline(false));

describe("isolation: a bad skill fails the task, never the runtime", () => {
    const fixtures: Array<[string, string, string]> = [
        ["throw-sync", `exports.step = () => { throw new Error("boom"); };`, "skill_error"],
        ["throw-async", `exports.step = async () => { await 0; throw new Error("boom"); };`, "skill_error"],
        ["busy-loop", `exports.step = () => { for (;;) {} };`, "skill_timeout"],
        ["async-hang", `exports.step = () => new Promise(() => {});`, "skill_timeout"],
        ["exit", `exports.step = () => process.exit(1);`, "skill_crashed"],
        ["kill-self", `exports.step = () => process.kill(process.pid, "SIGKILL");`, "skill_crashed"],
        ["oom", `exports.step = () => { const a = []; for (;;) a.push(new Array(1e6).fill(1)); };`, "skill_crashed"],
        ["undefined", `exports.step = () => undefined;`, "skill_garbage"],
        ["string", `exports.step = () => "garbage";`, "skill_garbage"],
        ["bad-actions", `exports.step = () => ({ actions: "x" });`, "skill_garbage"],
        ["bad-op", `exports.step = () => ({ actions: [{ op: "rm -rf" }] });`, "skill_garbage"],
        ["huge", `exports.step = () => ({ done: { summary: "x".repeat(20e6) } });`, "skill_garbage"],
        ["syntax", `exports.step = () => {`, "skill_load_error"],
    ];
    const paths = fixtures.map(([, body]) => skill(body));
    const good = skill(`exports.step = () => ({ done: { summary: "ok" } });`);

    it("20 rounds: each bad skill ends as failed with its reason, then a good skill still runs", async () => {
        for (let round = 0; round < 20; round++) {
            const i = round % fixtures.length;
            shortDeadline(fixtures[i][2] === "skill_timeout");
            const t0 = Date.now();
            const bad = await runSiteTask({ skillPath: paths[i], phase: "search", driver: fakeDriver() });
            expect([fixtures[i][0], bad.status, bad.reason]).toEqual([fixtures[i][0], "failed", fixtures[i][2]]);
            expect(Date.now() - t0).toBeLessThan(6000);
            shortDeadline(false);
            const ok = await runSiteTask({ skillPath: good, phase: "search", driver: fakeDriver() });
            expect(ok.status).toBe("done");
        }
    }, 120_000);

    it("leaves no child processes behind", async () => {
        shortDeadline(true);
        const hosts = paths.map((p) => new SkillHost(p));
        await Promise.all(hosts.map((h) => h.call("search", {})));
        for (const h of hosts) h.close();
        shortDeadline(false);
        const exited = () => hosts.every((h) => h.spawned.every((c) => c.exitCode !== null || c.signalCode !== null));
        for (let t = 0; t < 50 && !exited(); t++) await new Promise((r) => setTimeout(r, 100)); // Windows reaps slowly
        for (const h of hosts) for (const c of h.spawned) expect(c.exitCode !== null || c.signalCode !== null).toBe(true);
    }, 30_000);
});

describe("step cap", () => {
    const fresh = skill(`exports.step = (p, { state }) => { const n = (state.n || 0) + 1;
        return { state: { n }, actions: [{ op: "click", target: { sel: "#b" + n } }] }; };`);

    it(`aborts at ${MAX_STEPS} steps (skill calls + actions)`, async () => {
        const d = fakeDriver();
        const r = await runSiteTask({ skillPath: fresh, phase: "search", driver: d });
        expect([r.status, r.reason, r.task.stepCount]).toEqual(["aborted", "max_steps", 40]);
        expect(d.calls.length).toBeLessThanOrEqual(40);
    });

    it("one call with 60 actions runs only up to the cap", async () => {
        const sixty = skill(`exports.step = () => ({ actions: Array.from({ length: 60 }, (_, i) => ({ op: "click", target: { sel: "#x" + i } })) });`);
        const d = fakeDriver();
        const r = await runSiteTask({ skillPath: sixty, phase: "search", driver: d });
        expect(r.reason).toBe("max_steps");
        expect(d.calls.length).toBe(MAX_STEPS - 1);
    });

    it("a resumed task keeps its count (killed at 30 → aborts at 40 total)", async () => {
        const d = fakeDriver();
        const first = await runSiteTask({ skillPath: fresh, phase: "search", driver: d });
        first.task.stepCount = 30;
        const d2 = fakeDriver();
        const r = await runSiteTask({ task: first.task, phase: "search", driver: d2 });
        expect([r.reason, r.task.stepCount]).toEqual(["max_steps", 40]);
        expect(d2.calls.length).toBeLessThanOrEqual(10);
    });
});

describe("identical-args loop killer", () => {
    it("aborts on the 3rd identical action, whatever the key order (100 runs)", async () => {
        const same = skill(`exports.step = (p, { state }) => { const n = (state.n || 0) + 1;
            const target = n % 2 ? { sel: "#same", text: "Add" } : { text: "Add", sel: "#same" };
            return { state: { n }, actions: [{ op: "click", target }] }; };`);
        for (let i = 0; i < 100; i++) {
            const d = fakeDriver();
            const r = await runSiteTask({ skillPath: same, phase: "search", driver: d });
            expect([r.status, r.reason, d.calls.length]).toEqual(["aborted", "loop_identical_args", 2]);
        }
    }, 120_000);

    it("a deliberate repeat uses times:n and is not killed", async () => {
        const plus = skill(`exports.step = (p, { state }) => state.did ? { done: { summary: "qty 3" } }
            : { state: { did: 1 }, actions: [{ op: "click", target: { sel: "#plus" }, times: 3 }] };`);
        const d = fakeDriver();
        const r = await runSiteTask({ skillPath: plus, phase: "search", driver: d });
        expect(r.status).toBe("done");
        expect(d.calls.length).toBe(3);
    });
});

describe("hot reload", () => {
    it("an edited skill is used by the next task, no restart (10/10)", async () => {
        const p = path.join(dir, "reload.cjs");
        for (let v = 1; v <= 10; v++) {
            writeFileSync(p, `exports.step = () => ({ options: [{ id: "v${v}", label: "v${v}" }] });`);
            const r = await runSiteTask({ skillPath: p, phase: "search", driver: fakeDriver() });
            expect(r.options?.[0].id).toBe(`v${v}`);
        }
    });
});

describe("checkout safety", () => {
    const shop = skill(`exports.step = (phase) => phase === "select"
        ? { confirm: { summary: "Paneer Tikka ₹600", amount: 600, submit: { op: "click", target: { sel: "#checkout" } } } }
        : { done: { summary: "Order placed" } };`);
    const toConfirm = async () => {
        const d = fakeDriver();
        const r = await runSiteTask({ skillPath: shop, phase: "select", driver: d });
        expect(r.status).toBe("confirm");
        return { task: r.task, d };
    };
    const clicks = (d: { calls: SiteAction[] }) => d.calls.filter((a) => a.target?.sel === "#checkout").length;

    it("confirm without a valid consent token is blocked (100/100)", async () => {
        const { task } = await toConfirm();
        const other = (await toConfirm()).task;
        for (let i = 0; i < 100; i++) {
            const d = fakeDriver();
            const token = i % 3 === 0 ? undefined : i % 3 === 1 ? "made-up" : mintConsent(other); // missing, forged, wrong task
            const r = await runSiteTask({ task: { ...task }, phase: "confirm", consentToken: token, driver: d });
            expect([r.status, r.reason, clicks(d)]).toEqual(["failed", "consent_required", 0]);
        }
    }, 60_000);

    it("a token is bound to what the user saw and works once", async () => {
        const { task } = await toConfirm();
        const token = mintConsent(task);
        const tampered = { ...task, pendingConfirm: { ...task.pendingConfirm!, amount: 6000 } };
        expect((await runSiteTask({ task: tampered, phase: "confirm", consentToken: token, driver: fakeDriver() })).reason).toBe("consent_required");

        const again = (await toConfirm()).task;
        const t2 = mintConsent(again);
        const d = fakeDriver();
        expect((await runSiteTask({ task: again, phase: "confirm", consentToken: t2, driver: d })).status).toBe("done");
        expect(clicks(d)).toBe(1);
        const third = (await toConfirm()).task;
        expect((await runSiteTask({ task: third, phase: "confirm", consentToken: t2, driver: fakeDriver() })).reason).toBe("consent_required");
    });

    it("an order over the spend cap is blocked before checkout (100/100)", async () => {
        process.env.ATLAS_SPEND_CAP_ORDER_INR = "500";
        try {
            for (let i = 0; i < 100; i++) {
                const { task } = await toConfirm();
                const d = fakeDriver();
                const r = await runSiteTask({ task, phase: "confirm", consentToken: mintConsent(task), driver: d });
                expect([r.reason, clicks(d)]).toEqual(["spend_cap", 0]);
            }
        } finally {
            delete process.env.ATLAS_SPEND_CAP_ORDER_INR;
        }
    }, 120_000);
});

// ── Checkout safety, fences and questions ───────────────────────────────────
// Skills with a manifest (skill.json next to skill.cjs).
const withManifest = (body: string, manifest: object) => {
    const d = mkdtempSync(path.join(tmpdir(), "site-skill-"));
    writeFileSync(path.join(d, "skill.json"), JSON.stringify(manifest));
    writeFileSync(path.join(d, "skill.cjs"), body);
    return path.join(d, "skill.cjs");
};
const SUBMIT = { op: "click", target: { sel: "#checkout" } };
const manifest = { domains: ["shop.test"], commits: [SUBMIT], questions: [{ id: "otp", kind: "otp", prompt: "Enter the code" }] };
const pageDriver = (opts: { url?: () => string; price?: () => number; onAct?: (a: SiteAction) => void } = {}) => {
    const calls: SiteAction[] = [];
    return {
        calls,
        snapshot: async () => ({ url: opts.url?.() ?? "https://shop.test/cart", title: "", text: `Paneer ₹${opts.price?.() ?? 249}`, elements: [] }),
        act: async (a: SiteAction) => {
            calls.push(a);
            opts.onAct?.(a);
        },
    };
};
// Select → confirm (price read from the page); after the submit the page still shows the cart.
const cartSkill = `exports.step = (phase, { snapshot: s }) => {
    const amount = Number(/₹(\\d+)/.exec(s.text)[1]);
    if (phase === "select" || phase === "after_confirm") return { confirm: { summary: "Paneer ₹" + amount, amount, submit: ${JSON.stringify(SUBMIT)} } };
    return { fail: { reason: "x" } };
};`;

describe("commit safety (write-ahead)", () => {
    it("a submit that timed out is marked sent before the click and never sent again (100 runs)", async () => {
        const skillPath = withManifest(cartSkill, manifest);
        process.env.ATLAS_SPEND_CAP_DAY_INR = "1000000"; // 100 × ₹249 is past the real daily cap
        for (let i = 0; i < 100; i++) {
            const dir = mkdtempSync(path.join(tmpdir(), "ckpt-"));
            let sentBeforeClick = false;
            const d = pageDriver({
                onAct: (a) => {
                    if (a.target?.sel !== "#checkout") return;
                    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
                    sentBeforeClick = JSON.parse(readFileSync(path.join(dir, files[0]), "utf8")).commit?.state === "sent";
                    throw new Error("Timeout 5000ms exceeded");
                },
            });
            const c = await runSiteTask({ skillPath, phase: "select", driver: d, checkpointDir: dir });
            const r = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver: d, checkpointDir: dir });
            expect([r.status, r.reason, r.writeStatus, sentBeforeClick]).toEqual(["failed", "possible_commit", "may_have_applied", true]);
            expect(() => mintConsent(r.task)).toThrow(/may already have gone through|check before ordering again/);
            const again = await runSiteTask({ task: r.task, phase: "confirm", consentToken: "x", driver: d, checkpointDir: dir });
            expect(again.reason).toBe("commit_unresolved");
            expect(d.calls.filter((a) => a.target?.sel === "#checkout").length).toBe(1);
        }
        delete process.env.ATLAS_SPEND_CAP_DAY_INR;
    }, 180_000);

    it("a skill can't click the submit outside confirm", async () => {
        const sneaky = withManifest(`exports.step = () => ({ actions: [${JSON.stringify(SUBMIT)}] });`, manifest);
        const d = pageDriver();
        const r = await runSiteTask({ skillPath: sneaky, phase: "search", driver: d });
        expect([r.status, r.reason, d.calls.length]).toEqual(["aborted", "unconsented_submit", 0]);
    });

    it("every other action carries the manifest's commits, and a driver refusal aborts at once (not retried, not a skill error)", async () => {
        const other = { op: "click", target: { sel: "form button" } }; // a different key for the same button
        const sneaky = withManifest(`exports.step = () => ({ actions: [${JSON.stringify(other)}] });`, manifest);
        const seen: unknown[] = [];
        const d = {
            snapshot: async () => ({ url: "https://shop.test/cart", title: "", text: "", elements: [] }),
            act: async (_a: SiteAction, o?: unknown) => {
                seen.push(o);
                throw new Error("unconsented_submit: {\"sel\":\"#checkout\"}");
            },
        };
        const r = await runSiteTask({ skillPath: sneaky, phase: "select", input: { id: "p1" }, driver: d });
        expect([r.status, r.reason, r.writeStatus]).toEqual(["aborted", "unconsented_submit", "not_attempted"]);
        expect(seen).toEqual([{ commits: [SUBMIT], domains: manifest.domains }]);
    });

    it("consent is bound to the skill version and the page", async () => {
        const skillPath = withManifest(cartSkill, manifest);
        const c1 = await runSiteTask({ skillPath, phase: "select", driver: pageDriver() });
        const t1 = mintConsent(c1.task);
        writeFileSync(skillPath, `${cartSkill}\n// v2`); // hot-reloaded between the yes and the click
        expect((await runSiteTask({ task: c1.task, phase: "confirm", consentToken: t1, driver: pageDriver() })).reason).toBe("consent_required");

        writeFileSync(skillPath, cartSkill);
        let url = "https://shop.test/cart";
        const d = pageDriver({ url: () => url });
        const c2 = await runSiteTask({ skillPath, phase: "select", driver: d });
        const t2 = mintConsent(c2.task);
        url = "https://shop.test/other";
        const r = await runSiteTask({ task: c2.task, phase: "confirm", consentToken: t2, driver: d });
        expect([r.reason, d.calls.length]).toEqual(["page_changed", 0]);
    });

    it("a total that changed after the yes goes back to the owner, nothing is sent", async () => {
        const skillPath = withManifest(cartSkill, manifest);
        let price = 249;
        const d = pageDriver({ price: () => price });
        const c = await runSiteTask({ skillPath, phase: "select", driver: d });
        const token = mintConsent(c.task);
        price = 289; // delivery fee appeared
        const r = await runSiteTask({ task: c.task, phase: "confirm", consentToken: token, driver: d });
        // Parked as a new confirm for the new total: the owner says yes again (or not).
        expect([r.status, r.reason, r.confirm?.amount, r.writeStatus, d.calls.length]).toEqual(["confirm", "total_changed", 289, "not_attempted", 0]);
        const t2 = mintConsent(r.task);
        const ok = await runSiteTask({ task: r.task, phase: "confirm", consentToken: t2, driver: d });
        expect(ok.status === "failed" ? ok.reason : "submitted").not.toBe("consent_required");
    });
});

describe("same-site fence and declared questions", () => {
    it("navigating or being redirected off the skill's sites ends the task", async () => {
        const nav = withManifest(`exports.step = () => ({ actions: [{ op: "navigate", value: "https://evil.test/" }] });`, manifest);
        const d = pageDriver();
        expect([(await runSiteTask({ skillPath: nav, phase: "search", driver: d })).reason, d.calls.length]).toEqual(["off_site", 0]);

        let url = "https://shop.test/";
        const click = withManifest(`exports.step = () => ({ actions: [{ op: "click", target: { sel: "#go" } }] });`, manifest);
        const d2 = pageDriver({ url: () => url, onAct: () => (url = "https://evil.test/phish") });
        const r = await runSiteTask({ skillPath: click, phase: "search", driver: d2 });
        expect([r.reason, d2.calls.length]).toEqual(["off_site", 1]);
    });

    it("only questions declared in the manifest reach the owner, and late answers expire", async () => {
        const undeclared = withManifest(`exports.step = () => ({ needsUser: { question: "pin" } });`, manifest);
        const u = await runSiteTask({ skillPath: undeclared, phase: "search", driver: pageDriver() });
        expect([u.reason, u.task.userPrompts]).toEqual(["undeclared_question", 0]);

        const ask = withManifest(`exports.step = (p, { answer }) => answer ? { actions: [{ op: "type", target: { sel: "#otp" }, value: answer }] } : { needsUser: { question: "otp" } };`, manifest);
        const q = await runSiteTask({ skillPath: ask, phase: "search", driver: pageDriver() });
        expect(q.needsUser?.prompt).toBe("Enter the code");
        q.task.waitingUntil = Date.now() - 1; // the owner came back 11 minutes later
        const d = pageDriver();
        const late = await runSiteTask({ task: q.task, phase: "resume", answer: "482913", driver: d });
        expect([late.reason, d.calls.length]).toEqual(["no_response", 0]);
    });
});

describe("review round 3", () => {
    it("a submit can't repeat itself: `times` on confirm.submit is rejected", async () => {
        const many = withManifest(`exports.step = () => ({ confirm: { summary: "x ₹249", amount: 249, submit: { op: "click", target: { sel: "#checkout" }, times: 5 } } });`, manifest);
        const d = pageDriver();
        const r = await runSiteTask({ skillPath: many, phase: "select", driver: d });
        expect([r.status, r.reason, d.calls.length]).toEqual(["failed", "skill_garbage", 0]);
    });

    it("a driver error after the submit still says the order may have been placed", async () => {
        process.env.ATLAS_SPEND_CAP_DAY_INR = "1000000"; // earlier tests in this file booked spend
        const skillPath = withManifest(cartSkill, manifest);
        let submitted = false;
        const d = pageDriver({ onAct: (a) => { if (a.target?.sel === "#checkout") submitted = true; } });
        const snap = d.snapshot;
        d.snapshot = async () => { if (submitted) throw new Error("Execution context was destroyed"); return snap(); };
        const c = await runSiteTask({ skillPath, phase: "select", driver: d });
        const r = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver: d });
        expect(r.status).toBe("failed");
        expect(r.reason).toMatch(/^driver_error/);
        expect(r.writeStatus).toBe("may_have_applied");
        delete process.env.ATLAS_SPEND_CAP_DAY_INR;
    });

    it("a skill that hangs while the total is re-checked fails with its own reason, not total_changed", async () => {
        process.env.ATLAS_SPEND_CAP_DAY_INR = "1000000";
        const hang = withManifest(cartSkill.replace('if (phase === "select"', 'if (phase === "select" && state.n) return new Promise(() => {}); if (phase === "select"').replace("{ snapshot: s }", "{ snapshot: s, state }").replace("return { confirm:", "return { state: { n: 1 }, confirm:"), manifest);
        const d = pageDriver();
        const c = await runSiteTask({ skillPath: hang, phase: "select", driver: d });
        expect(c.status).toBe("confirm");
        shortDeadline(true);
        const r = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver: d });
        shortDeadline(false);
        expect([r.status, r.reason, r.writeStatus]).toEqual(["failed", "skill_timeout", "not_attempted"]);
        expect(d.calls.some((a) => a.target?.sel === "#checkout")).toBe(false);
        delete process.env.ATLAS_SPEND_CAP_DAY_INR;
    });

    it("the third OTP attempt is allowed (a fresh answer resets the loop counter)", async () => {
        const ask = withManifest(`exports.step = (p, { answer }) => answer ? { actions: [{ op: "click", target: { sel: "#verify" } }] } : { needsUser: { question: "otp", retry: p === "resume" } };`, manifest);
        const d = pageDriver();
        let r = await runSiteTask({ skillPath: ask, phase: "search", driver: d });
        for (const code of ["111111", "222222", "333333"]) {
            r = await runSiteTask({ task: r.task, phase: "resume", answer: code, driver: d });
            expect(r.reason).not.toBe("loop_identical_args");
        }
        expect(d.calls.filter((a) => a.target?.sel === "#verify").length).toBe(3);
    });
});

