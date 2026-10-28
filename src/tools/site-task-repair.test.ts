// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// site_task when the site changed under a learned skill: the agent is told to
// tell the user and to go on by hand only if they want, a fresh recording
// starts (so its session begins after the failure, even if one was already
// running), and a skill that drifted out of the registry is still offered for
// repair instead of a new mint. Offline: the runtime, browser, recorder and
// drift store are stubbed.
import { describe, expect, it, vi } from "vitest";

const runSiteTask = vi.fn();
const startTrace = vi.fn(async () => ({ id: "t_2", dir: "/tmp/t_2" }));
const findSiteSkill = vi.fn((): string | null => "/skills/shop/skill.cjs");
const pendingRepair = vi.fn((): unknown => null);
const repairBlocked = vi.fn((): string | null => null);
vi.mock("../skills/site/runtime.js", () => ({
    runSiteTask,
    mintConsent: () => "tok",
    saveCheckpoint: () => {},
    loadCheckpoint: () => null,
}));
vi.mock("./browser/core.js", () => ({
    getActivePage: async () => ({ url: () => "https://shop.test/", context: () => ({}), on: () => {} }),
}));
vi.mock("../skills/site/registry.js", () => ({ findSiteSkill }));
vi.mock("../skills/site/mint/recorder.js", () => ({
    startTrace,
    drainTrace: async () => {},
    tracing: () => "shop.test", // already recording this site
}));
vi.mock("../skills/site/drift.js", () => ({ pendingRepair, repairBlocked }));

const { siteTask } = await import("./site-task.js");
const search = async () => JSON.parse(await siteTask.handler({ action: "search", query: "dal" }));

describe("site_task when the site changed under a learned skill", () => {
    it("drift: tell the user, go on by hand only if they want, in a recording that starts now", async () => {
        runSiteTask.mockResolvedValueOnce({
            status: "aborted",
            reason: "loop_identical_args",
            writeStatus: "not_attempted",
            repairQueued: true,
            task: { taskId: "t", stepCount: 3 },
        });
        const out = await search();
        expect(out.next_step).toMatch(/^The site changed .*Tell the user\. Only if they want, finish the task/);
        expect(out.next_step).toContain("site_skill_mint with action repair");
        expect(startTrace).toHaveBeenCalledTimes(1); // restarted though the site was being recorded
    });

    it("a drifted skill (skipped by the registry) with a capture waiting is offered for repair, not a new mint", async () => {
        startTrace.mockClear();
        findSiteSkill.mockReturnValue(null);
        pendingRepair.mockReturnValue({ captureDir: "/c", capture: { skill: "shop-test", skillDir: "/s/shop-test" } });
        expect((await search()).next_step).toMatch(/^The site changed .*action repair/);
        expect(startTrace).toHaveBeenCalledTimes(1);
        // Already tried today: no repair now, and no offer to learn the site from scratch either.
        repairBlocked.mockReturnValueOnce("rate_limited");
        expect((await search()).next_step).toBeUndefined();
        // No learned skill at all: the usual offer to learn the site.
        pendingRepair.mockReturnValue(null);
        expect((await search()).next_step).toMatch(/offer to learn this site/);
    });
});
