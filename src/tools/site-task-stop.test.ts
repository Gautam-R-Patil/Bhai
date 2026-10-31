// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The owner's Stop reaches site_task as _signal (tools/index.ts STOPPABLE_TOOLS,
// turn-signal.test.ts); here: it goes on to the runtime and the page driver on
// every action, and the result tells the model what Stop left behind.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "bhai-data-"));
const runSiteTask = vi.fn();
const pageDriver = vi.fn(() => ({ snapshot: async () => ({}), act: async () => {} }));
vi.mock("../config/paths.js", async (orig) => ({ ...(await orig<object>()), getDataDir: () => dataDir }));
vi.mock("./browser/core.js", () => ({
    getActivePage: async () => ({ url: () => "https://shop.test/", on: () => {} }),
}));
vi.mock("../skills/site/registry.js", () => ({ findSiteSkill: () => "/s/skill.cjs" }));
vi.mock("../skills/site/page-driver.js", async (orig) => ({ ...(await orig<object>()), pageDriver }));
vi.mock("../skills/site/runtime.js", async (orig) => ({ ...(await orig<object>()), runSiteTask }));

const task = () => ({
    taskId: "t1",
    skillPath: "/s/skill.cjs",
    skillHash: "h",
    phase: "select",
    stepCount: 3,
    repeats: {},
    state: {},
    userPrompts: 0,
    pendingConfirm: {
        summary: "Paneer Tikka ₹249",
        amount: 249,
        submit: { op: "click" },
        page: "https://shop.test/cart",
    },
});
const stopped = (writeStatus: string, t: object) => ({
    status: "aborted",
    reason: "stopped",
    writeStatus,
    retry: writeStatus === "not_attempted" ? "ask_owner" : "never",
    task: t,
});

describe("site_task and the owner's Stop", () => {
    it("hands the turn's signal to the runtime and the driver, and says what Stop left", async () => {
        const { siteTask } = await import("./site-task.js");
        const ctl = new AbortController();
        const call = async (input: Record<string, unknown>) =>
            JSON.parse(await siteTask.handler({ ...input, _signal: ctl.signal }));

        // Stopped before anything was sent.
        runSiteTask.mockResolvedValueOnce(stopped("not_attempted", task()));
        const first = await call({ action: "search", query: "paneer" });
        expect(first.next_step).toMatch(/pressed Stop; nothing was ordered/);

        // A parked task: select, resume and confirm all carry the signal.
        const t = task();
        runSiteTask.mockResolvedValueOnce({ status: "options", options: [], writeStatus: "not_attempted", task: t });
        await call({ action: "search", query: "paneer" });
        runSiteTask.mockResolvedValueOnce({ status: "options", options: [], writeStatus: "not_attempted", task: t });
        await call({ action: "select", option_id: "p1" });
        runSiteTask.mockResolvedValueOnce({ status: "options", options: [], writeStatus: "not_attempted", task: t });
        await call({ action: "resume", answer: "123456" });

        // Stopped after the write-ahead mark: the order may exist.
        runSiteTask.mockResolvedValueOnce(stopped("may_have_applied", { ...t, commit: { hash: "x", state: "sent" } }));
        const late = await call({ action: "confirm", amount: 249 });
        expect(late.next_step).toContain("Do NOT order again");

        expect(runSiteTask).toHaveBeenCalledTimes(5);
        for (const [opts] of runSiteTask.mock.calls) expect(opts.signal).toBe(ctl.signal);
        expect(runSiteTask.mock.calls.map(([o]) => o.phase)).toEqual([
            "search",
            "search",
            "select",
            "resume",
            "confirm",
        ]);
        expect(pageDriver.mock.calls.length).toBe(5);
        for (const args of pageDriver.mock.calls as unknown[][]) expect(args[3]).toBe(ctl.signal);

        // That task stays current, so a new search stops at "may already have been placed".
        const next = await call({ action: "search", query: "dal" });
        expect(next.error).toMatch(/may already have been placed/);
        expect(runSiteTask).toHaveBeenCalledTimes(5);
    });
});
