// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The real page driver on a fake page, for what the browser E2E files can't
// tell apart: a reopened tab never goes back to its last page once an order may
// exist (global rule 2), and Stop keeps a press, a navigate or a code from
// being dispatched (those ops have no unblock() of their own to stop them).
import { describe, expect, it } from "vitest";
import { pageDriver } from "../page-driver.js";

const URL0 = "https://shop.test/cart?id=p1";
// biome-ignore lint/suspicious/noExplicitAny: a fake Playwright Page
const fake = (log: string[], onEvaluate: (a: unknown[]) => unknown = () => ({ url: URL0 })): any => {
    let shut = false;
    return {
        isClosed: () => shut,
        close: () => {
            shut = true;
        },
        evaluate: async (...a: unknown[]) => {
            log.push("evaluate");
            return onEvaluate(a);
        },
        goto: async (u: string) => void log.push(`goto ${u}`),
        keyboard: { press: async (k: string) => void log.push(`press ${k}`) },
    };
};

describe("a closed tab is reopened, and goes back to its last page only while no order may exist", () => {
    const reopened = async (afterCommit?: () => boolean, submit = false) => {
        const log: string[] = [];
        const first = fake(log);
        const d = pageDriver(first, 5000, async () => fake(log), undefined, afterCommit);
        await d.snapshot(); // remembers the cart's URL
        if (submit) await d.act({ op: "press", value: "Enter" }, { submit: true });
        first.close();
        log.length = 0;
        await d.snapshot();
        return log.filter((l) => l.startsWith("goto"));
    };
    it("before any order: back to the cart (the control: revive does navigate)", async () => {
        expect(await reopened()).toEqual([`goto ${URL0}`]);
        expect(await reopened(() => false)).toEqual([`goto ${URL0}`]);
    });
    it("after this driver's submit: never", async () => {
        expect(await reopened(undefined, true)).toEqual([]);
    });
    it("after an earlier call's submit (a fresh driver per site_task call): never", async () => {
        expect(await reopened(() => true)).toEqual([]);
    });
});

describe("Stop: no press, navigate or code goes out after it", () => {
    const acts = [
        { op: "press", value: "Enter" },
        { op: "press", value: "Tab" },
        { op: "navigate", value: "https://shop.test/" },
        { op: "typeCode", target: { sel: "#otp" }, value: "123456" },
    ] as const;
    for (const a of acts) {
        it(`${a.op} ${a.value}, stopped before the call`, async () => {
            const log: string[] = [];
            const ac = new AbortController();
            ac.abort();
            const d = pageDriver(fake(log), 5000, undefined, ac.signal);
            await expect(d.act(a, { commits: [] })).rejects.toThrow("stopped");
            expect(log).toEqual([]);
        });
    }
    it("press Enter, stopped while its commit guard reads the page", async () => {
        const log: string[] = [];
        const ac = new AbortController();
        // The Chrome-proxy guard path (no evaluateHandle): one read of the focused form's controls.
        const page = fake(log, () => {
            ac.abort();
            return [];
        });
        const d = pageDriver(page, 5000, undefined, ac.signal);
        await expect(d.act({ op: "press", value: "Enter" }, { commits: [] })).rejects.toThrow("stopped");
        expect(log).toEqual(["evaluate"]); // the guard's read, then nothing
    });
});
