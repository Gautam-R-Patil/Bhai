// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// A CAPTCHA mid-task that the pipeline (solvers, then the owner) didn't clear:
// site_task stops before the skill sees it (the skill must never click it), and
// `resume` re-runs the phase it stopped in with the same input.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "bhai-data-"));
const captchaOn = { value: true };
const runSiteTask = vi.fn();
vi.mock("../config/paths.js", async (orig) => ({ ...(await orig<object>()), getDataDir: () => dataDir }));
const snap = { url: "https://shop.test/", title: "Shop", text: "", elements: [] };
vi.mock("./browser/core.js", () => ({
    getActivePage: async () => ({ url: () => snap.url, evaluate: async () => snap }),
}));
// A CAPTCHA the solvers can't get past (when they can, the skill never sees it at all).
vi.mock("./browser/captcha.js", () => ({
    clearCaptchaIfAny: async () =>
        captchaOn.value ? { present: true, cleared: false, detail: {} } : { present: false },
}));
vi.mock("../skills/site/registry.js", () => ({ findSiteSkill: () => "/s/skill.cjs" }));
vi.mock("../skills/site/runtime.js", async (orig) => ({ ...(await orig<object>()), runSiteTask }));

const task = {
    taskId: "t1",
    skillPath: "/s/skill.cjs",
    skillHash: "h",
    phase: "search",
    stepCount: 3,
    repeats: { a: 2 },
    state: {},
    userPrompts: 0,
};

// What the runtime does with a snapshot that throws: the task ends as a driver error.
async function runtimeLike(opts: { driver: { snapshot(): Promise<unknown> } }) {
    try {
        await opts.driver.snapshot();
    } catch (e) {
        return {
            status: "failed",
            reason: `driver_error: ${(e as Error).message}`,
            writeStatus: "not_attempted",
            task,
        };
    }
    return { status: "options", options: [{ id: "1", label: "Pizza" }], writeStatus: "not_attempted", task };
}

describe("site_task on a CAPTCHA the pipeline couldn't clear", () => {
    it("stops for the owner, then resumes the same phase", async () => {
        const { siteTask } = await import("./site-task.js");
        runSiteTask.mockImplementationOnce(runtimeLike);
        const paused = JSON.parse(await siteTask.handler({ action: "search", query: "pizza" }));
        expect(paused.status).toBe("needs_user");
        expect(paused.needsUser.kind).toBe("human_check");
        expect(paused.next_step).toContain("only the owner can finish");
        expect(paused.next_step).toContain("action resume");

        captchaOn.value = false; // the owner ticked it
        runSiteTask.mockImplementationOnce(runtimeLike);
        const out = JSON.parse(await siteTask.handler({ action: "resume" }));
        expect(out.status).toBe("options");
        expect(runSiteTask.mock.calls[1][0]).toMatchObject({
            phase: "search",
            input: { query: "pizza" },
            task: { taskId: "t1", repeats: {} },
        });
    });
});
