// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// SPA primitives without a browser: the expect outcome reaching the skill, the
// refused result and the pick refusal, retry classes, and the submit's verdict
// (judgeCommit) reverting "sent" once. A fake page driver stands in for the page.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SiteAction } from "../host.js";
import { judgeCommit } from "../page-driver.js";
import { type ActResult, type CommitVerdict, mintConsent, PAY_ON_PAGE, retryOf, runSiteTask } from "../runtime.js";

const withManifest = (body: string, manifest: object = {}) => {
    const d = mkdtempSync(path.join(tmpdir(), "site-p3-"));
    writeFileSync(path.join(d, "skill.json"), JSON.stringify({ domains: ["shop.test"], commits: [], questions: [], ...manifest }));
    writeFileSync(path.join(d, "skill.cjs"), body);
    return path.join(d, "skill.cjs");
};
const driver = (act: (a: SiteAction, o?: { submit?: boolean }) => Promise<ActResult> = async () => undefined) => {
    const calls: SiteAction[] = [];
    return {
        calls,
        snapshot: async () => ({ url: "https://shop.test/cart", title: "", text: "Paneer ₹249", elements: [] }),
        act: async (a: SiteAction, o?: { submit?: boolean }) => {
            calls.push(a);
            return act(a, o);
        },
    };
};

beforeAll(() => {
    process.env.BHAI_SITE_SKILL_DEADLINE_MS = "2000";
});
afterAll(() => {
    delete process.env.BHAI_SITE_SKILL_DEADLINE_MS;
});

describe("expect and pick reach the skill", () => {
    it("the outcome that won reaches the next step as lastOutcome, and is cleared by the next action", async () => {
        const skillPath = withManifest(`exports.step = (p, { lastOutcome, state }) => {
            if (!state.n) return { state: { n: 1 }, actions: [{ op: "click", target: { sel: "#search" }, expect: { results: { sel: "li" }, empty: { text: "No results" } } }] };
            if (state.n === 1) return { state: { n: 2, first: lastOutcome }, actions: [{ op: "click", target: { sel: "#other" } }] };
            return { done: { summary: state.first + "/" + String(lastOutcome) } };
        };`);
        const d = driver(async (a) => (a.expect ? { outcome: "results" } : undefined));
        const r = await runSiteTask({ skillPath, phase: "search", driver: d });
        expect([r.status, r.summary]).toEqual(["done", "results/undefined"]);
        expect(d.calls[0].expect).toEqual({ results: { sel: "li" }, empty: { text: "No results" } }); // passed to the driver intact
    });

    it("a malformed expect or pick is garbage, never acted on", async () => {
        for (const a of [
            { op: "pick", value: "Indiranagar" }, // no list to pick from
            { op: "pick", target: { sel: "li" } }, // nothing to pick
            { op: "click", target: { sel: "#a" }, expect: { done: { url: "(" } } }, // not a regex
            { op: "click", target: { sel: "#a" }, expect: {} }, // no outcome
            { op: "click", target: { sel: "#a" }, expect: { "Bad Name": { sel: "x" } } },
            { op: "click", target: { sel: "#a" }, expect: { x: { gone: { sel: "x" }, url: "/" } } }, // two kinds in one
        ]) {
            const d = driver();
            const r = await runSiteTask({ skillPath: withManifest(`exports.step = () => ({ actions: [${JSON.stringify(a)}] });`), phase: "search", driver: d });
            expect([r.status, r.reason, d.calls.length]).toEqual(["failed", "skill_garbage", 0]);
        }
    });

    it("a pick the page can't satisfy ends refused, naming the action's field and what the page offers", async () => {
        const skillPath = withManifest(`exports.step = () => ({ actions: [{ op: "pick", target: { sel: "[role=option]" }, value: "Indiranagar", field: "location" }] });`);
        const d = driver(async () => {
            throw new Error('refused: ["Indiranagar, Bengaluru","Indiranagar 2nd Stage, Bengaluru"]');
        });
        const r = await runSiteTask({ skillPath, phase: "search", input: { query: "x", location: "Indiranagar" }, driver: d });
        expect([r.status, r.writeStatus, r.retry]).toEqual(["refused", "not_attempted", "fix_input"]);
        expect(r.refused).toEqual({ field: "location", available: ["Indiranagar, Bengaluru", "Indiranagar 2nd Stage, Bengaluru"] });
        expect(d.calls.length).toBe(1); // not retried
    });
});

describe("refused, fail.kind and retry classes", () => {
    const run = async (result: object) =>
        runSiteTask({ skillPath: withManifest(`exports.step = () => (${JSON.stringify(result)});`), phase: "select", input: { id: "p1" }, driver: driver() });

    it("each way a task stops says who can move it on", async () => {
        const cases: Array<[object, string, string]> = [
            [{ refused: { field: "id", available: ["Dal Makhani — ₹199"] } }, "refused", "fix_input"],
            [{ fail: { reason: "sold out", kind: "input_rejected" } }, "failed", "fix_input"],
            [{ fail: { reason: "input_rejected: no such place" } }, "failed", "fix_input"], // the prompt's reason prefix
            [{ fail: { reason: "captcha", kind: "needs_owner" } }, "failed", "ask_owner"],
            [{ fail: { reason: "needs_owner: captcha" } }, "failed", "ask_owner"],
            [{ fail: { reason: "503 page", kind: "site_error" } }, "failed", "later"],
            [{ fail: { reason: "unexpected page /x", kind: "unexpected_page" } }, "failed", "manual"],
            [{ fail: { reason: "something else" } }, "failed", "manual"],
            [{ actions: [] }, "failed", "manual"], // skill_no_progress: the site outgrew the skill
        ];
        for (const [result, status, retry] of cases) {
            const r = await run(result);
            expect([JSON.stringify(result), r.status, r.retry, r.writeStatus]).toEqual([JSON.stringify(result), status, retry, "not_attempted"]);
        }
        const ok = await run({ options: [{ id: "p1", label: "Paneer" }] });
        expect(ok.retry).toBeUndefined(); // only stopped tasks carry one
    });

    it("once the order may exist the class is never, whatever the reason", () => {
        for (const reason of ["input_rejected: x", "network_error", "spend_cap", "possible_commit"]) {
            expect(retryOf("failed", reason, "may_have_applied")).toBe("never");
        }
        expect(retryOf("refused", undefined, "may_have_applied")).toBe("never");
        expect(retryOf("failed", "network_error", "not_attempted")).toBe("later");
        expect(retryOf("failed", "driver_error: net::ERR_CONNECTION_RESET", "not_attempted")).toBe("later");
        expect(retryOf("failed", "spend_cap", "not_attempted")).toBe("ask_owner");
        expect(retryOf("aborted", "loop_identical_args", "not_attempted")).toBe("manual");
        expect(retryOf("done", undefined, "applied")).toBeUndefined();
    });
});

describe("judgeCommit: what the site answered to the submit", () => {
    const J = "application/json";
    it.each<[number, string, string, CommitVerdict["verdict"]]>([
        [400, J, `{"ok":false,"error":"Payment declined"}`, "not_done"],
        [200, J, `{"success":false,"message":"Slot full"}`, "not_done"],
        [422, J, `{"errors":[{"message":"Address required"}]}`, "not_done"],
        [200, J, `{"data":null,"errors":[{"message":"Item unavailable"}]}`, "not_done"], // GraphQL
        [200, J, `{"status":"DECLINED"}`, "not_done"],
        [200, J, `{"ok":true,"next":"/done?n=1"}`, "done"],
        [201, J, `{"orderId":"NS-48213"}`, "done"],
        [200, J, `{"data":{"status":"confirmed"}}`, "done"],
        // Every doubt is unclear (it never clears "sent"):
        [500, J, `{"ok":false}`, "unclear"], // a 5xx may have run halfway
        [504, "text/html", "Gateway Timeout", "unclear"],
        [303, "", "", "unclear"], // a form post's redirect: the next page tells
        [400, "text/html", "<p>Please tick the box</p>", "unclear"], // HTML says nothing reliable
        [409, J, `{"ok":false,"error":"Duplicate order: already placed"}`, "unclear"], // an order exists
        [200, J, `{"ok":false,"orderId":"NS-1"}`, "unclear"], // both signs
        [400, J, `{"ok":true}`, "unclear"], // a 4xx that says it worked
        [200, J, "not json", "unclear"],
        [200, J, `[1,2]`, "unclear"],
        [0, "", "", "unclear"], // no response
        // A "no error" code and an order nested in the body: an order exists.
        [200, J, `{"error":0,"msg":"success","data":{"orderDetails":{"id":"A1"}}}`, "unclear"],
        [200, J, `{"error":"0","errors":{},"data":{"order":{"id":"A1"}}}`, "unclear"],
        [200, J, `{"status":"failed","data":{"order":{"id":"A1"}}}`, "unclear"],
        [200, J, `{"ok":false,"message":"Order placed but payment failed","order":{"id":"A1"}}`, "unclear"],
        [200, J, `{"success":false,"booking":{"ref":"B-1"}}`, "unclear"],
        [400, J, `{"ok":false,"error":"Payment declined","order":null}`, "not_done"], // an empty order field is no order
    ])("%i %s %s → %s", (status, type, body, verdict) => {
        expect(judgeCommit(status, type, body).verdict).toBe(verdict);
    });

    it("keeps the site's own message as the detail", () => {
        expect(judgeCommit(400, J, `{"ok":false,"error":"Payment declined"}`).detail).toBe("Payment declined");
        expect(judgeCommit(422, J, `{"errors":[{"message":"Address required"}]}`).detail).toBe("Address required");
    });
});

describe("the submit's verdict", () => {
    const SUBMIT = { op: "click", target: { sel: "#checkout" } };
    const skillPath = withManifest(
        `exports.step = (phase, { snapshot: s }) => phase === "select"
            ? { confirm: { summary: "Paneer ₹249", amount: 249, submit: ${JSON.stringify(SUBMIT)} } }
            : /done/.test(s.url) ? { done: { summary: "Order placed #1" } } : { fail: { reason: "unexpected page after confirm" } };`,
        { commits: [SUBMIT] },
    );
    const shop = (verdicts: CommitVerdict["verdict"][]) => {
        let url = "https://shop.test/cart";
        let submits = 0;
        return {
            submits: () => submits,
            snapshot: async () => ({ url, title: "", text: "Paneer ₹249", elements: [] }),
            act: async (_a: SiteAction, o?: { submit?: boolean }): Promise<ActResult> => {
                if (!o?.submit) return undefined;
                const v = verdicts[submits++] ?? "unclear";
                if (v !== "not_done") url = "https://shop.test/done";
                return { verdict: { verdict: v, detail: v === "not_done" ? "Payment declined" : undefined } };
            },
        };
    };

    it("not_done clears 'sent' and refunds the spend: the owner may say yes once more", async () => {
        process.env.BHAI_SPEND_CAP_DAY_INR = "300"; // room for one ₹249 order: a kept booking would block the retry
        try {
            const d = shop(["not_done", "done"]);
            const c = await runSiteTask({ skillPath, phase: "select", driver: d });
            const r1 = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver: d });
            expect([r1.status, r1.reason, r1.writeStatus, r1.confirm?.amount]).toEqual(["confirm", "commit_rejected: Payment declined", "not_attempted", 249]);
            const r2 = await runSiteTask({ task: r1.task, phase: "confirm", consentToken: mintConsent(r1.task), driver: d });
            expect([r2.status, r2.writeStatus, d.submits()]).toEqual(["done", "applied", 2]);
        } finally {
            delete process.env.BHAI_SPEND_CAP_DAY_INR;
        }
    });

    it("a second not_done keeps 'sent': no third submit, ever", async () => {
        const d = shop(["not_done", "not_done"]);
        const c = await runSiteTask({ skillPath, phase: "select", driver: d });
        const r1 = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver: d });
        expect(r1.reason).toMatch(/^commit_rejected/);
        const r2 = await runSiteTask({ task: r1.task, phase: "confirm", consentToken: mintConsent(r1.task), driver: d });
        expect([r2.status, r2.writeStatus, r2.retry]).toEqual(["failed", "may_have_applied", "never"]);
        expect(() => mintConsent(r2.task)).toThrow(/may have gone through/);
        expect((await runSiteTask({ task: r2.task, phase: "confirm", consentToken: "x", driver: d })).reason).toBe("commit_unresolved");
        expect(d.submits()).toBe(2);
    });

    it("a 'no' never clears 'sent' when the page moved on or shows the confirmation", async () => {
        // The "no" was some other request's: the page went on to the confirmation.
        const moved = shop(["not_done"]);
        const act = moved.act;
        moved.act = async (a, o) => {
            const r = await act(a, o);
            if (o?.submit) moved.snapshot = async () => ({ url: "https://shop.test/done", title: "", text: "Order placed #1", elements: [] });
            return r;
        };
        const c = await runSiteTask({ skillPath, phase: "select", driver: moved });
        const r = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver: moved });
        expect([r.status, r.writeStatus, r.task.commitReverted]).toEqual(["done", "applied", undefined]);

        // Same URL, but the page quotes the order id (confirmPattern).
        const shown = withManifest(
            `exports.step = (phase) => phase === "select"
                ? { confirm: { summary: "Paneer ₹249", amount: 249, submit: ${JSON.stringify(SUBMIT)} } }
                : { fail: { reason: "unexpected page after confirm" } };`,
            { commits: [SUBMIT], confirmPattern: "Order placed #\\d+" },
        );
        let text = "Paneer ₹249";
        const same = {
            snapshot: async () => ({ url: "https://shop.test/cart", title: "", text, elements: [] }),
            act: async (_a: SiteAction, o?: { submit?: boolean }): Promise<ActResult> => {
                if (!o?.submit) return undefined;
                text = "Order placed #7";
                return { verdict: { verdict: "not_done", detail: "bad event" } };
            },
        };
        const c2 = await runSiteTask({ skillPath: shown, phase: "select", driver: same });
        const r2 = await runSiteTask({ task: c2.task, phase: "confirm", consentToken: mintConsent(c2.task), driver: same });
        expect([r2.status, r2.writeStatus, r2.retry, r2.task.commitReverted]).toEqual(["failed", "may_have_applied", "never", undefined]);
        expect(() => mintConsent(r2.task)).toThrow(/may have gone through/);
    });

    it("unclear and done never clear 'sent'", async () => {
        for (const v of ["unclear", "done"] as const) {
            const d = shop([v]);
            const c = await runSiteTask({ skillPath, phase: "select", driver: d });
            const r = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver: d });
            expect([v, r.status, r.writeStatus]).toEqual([v, "done", "applied"]);
            expect(r.task.commitReverted).toBeUndefined();
        }
    });
});

describe("paymentDomains", () => {
    const SUBMIT = { op: "click", target: { sel: "#checkout" } };
    const skill = (manifest: object) =>
        withManifest(
            `exports.step = (phase, { snapshot: s }) => phase === "select"
                ? (/razorpay/.test(s.url) ? { actions: [{ op: "click", target: { sel: "#x" } }] }
                  : { confirm: { summary: "Paneer ₹249", amount: 249, submit: ${JSON.stringify(SUBMIT)} } })
                : /done/.test(s.url) ? { done: { summary: "Order placed #1" } } : { fail: { reason: "unexpected page after confirm" } };`,
            { commits: [SUBMIT], ...manifest },
        );
    // The submit redirects to the gateway; the owner pays and the site shows /done.
    const gateway = () => {
        let url = "https://shop.test/cart";
        return {
            go: (u: string) => (url = u),
            snapshot: async () => ({ url, title: "", text: "Paneer ₹249", elements: [] }),
            act: async (_a: SiteAction, o?: { submit?: boolean }): Promise<ActResult> => {
                if (o?.submit) url = "https://api.razorpay.com/v1/checkout?o=1";
                return undefined;
            },
        };
    };

    it("after the consented submit, the gateway hands the page to the owner; back on the site it ends done", async () => {
        const d = gateway();
        const skillPath = skill({ paymentDomains: ["razorpay.com"] });
        const c = await runSiteTask({ skillPath, phase: "select", driver: d });
        const r = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver: d });
        expect([r.status, r.needsUser, r.writeStatus]).toEqual(["needs_user", { kind: "payment", prompt: PAY_ON_PAGE }, "may_have_applied"]);
        expect(() => mintConsent(r.task)).toThrow(/may have gone through/); // never a second order
        d.go("https://shop.test/done?n=1");
        const done = await runSiteTask({ task: r.task, phase: "resume", driver: d });
        expect([done.status, done.writeStatus]).toEqual(["done", "applied"]);
    });

    it("before the submit the gateway is off site, and without paymentDomains it always is", async () => {
        const before = gateway();
        before.go("https://api.razorpay.com/v1/checkout?o=1");
        const r = await runSiteTask({ skillPath: skill({ paymentDomains: ["razorpay.com"] }), phase: "select", driver: before });
        expect([r.status, r.reason, r.writeStatus]).toEqual(["aborted", "off_site", "not_attempted"]);

        const d = gateway();
        const skillPath = skill({});
        const c = await runSiteTask({ skillPath, phase: "select", driver: d });
        const after = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver: d });
        expect([after.status, after.reason, after.writeStatus]).toEqual(["aborted", "off_site", "may_have_applied"]);
    });
});

describe("the submit is the declared commit itself", () => {
    it("a pick as confirm.submit is garbage: nothing marked sent, nothing clicked", async () => {
        const submit = { op: "pick", target: { sel: "button" }, value: "Place order" };
        const skillPath = withManifest(`exports.step = () => ({ confirm: { summary: "Paneer ₹249", amount: 249, submit: ${JSON.stringify(submit)} } });`, {
            commits: [submit],
        });
        const d = driver();
        const r = await runSiteTask({ skillPath, phase: "select", driver: d });
        expect([r.status, r.reason, r.writeStatus, r.retry, d.calls.length]).toEqual(["failed", "skill_garbage", "not_attempted", "manual", 0]);
    });
});
