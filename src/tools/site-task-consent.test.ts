// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Checkout through site_task needs the owner's yes in a new message; a
// confirmed:true the model sets on its own (say, because a page told it to) is refused.
import { describe, expect, it, vi } from "vitest";

const runSiteTask = vi.fn();
vi.mock("../skills/site/runtime.js", () => ({
    runSiteTask,
    mintConsent: () => "tok",
    saveCheckpoint: () => {},
    loadCheckpoint: () => null,
}));
vi.mock("./browser/core.js", () => ({
    getActivePage: async () => ({ url: () => "https://shop.test/", on: () => {} }),
}));
vi.mock("../skills/site/registry.js", () => ({ findSiteSkill: () => "/skills/shop/skill.cjs" }));

const { executeTool } = await import("./index.js");
const { noteOwnerMessage, _resetConsent } = await import("../security/consent.js");
const { withSwarmRun, withSwarmStep, swarmConsentKey, isPaymentHold } = await import("../agents/swarm-context.js");

describe("site_task checkout consent", () => {
    it("refuses confirm until the owner says yes after being asked", async () => {
        _resetConsent();
        noteOwnerMessage("order paneer tikka");
        const first = JSON.parse(await executeTool("site_task", { action: "confirm", amount: 249, confirmed: true }));
        expect(first.needs_confirmation).toBe(true);
        const again = JSON.parse(await executeTool("site_task", { action: "confirm", amount: 249, confirmed: true }));
        expect(again.needs_confirmation).toBe(true); // no new owner message yet
        expect(runSiteTask).not.toHaveBeenCalled();

        noteOwnerMessage("yes go ahead");
        const ok = JSON.parse(await executeTool("site_task", { action: "confirm", amount: 249, confirmed: true }));
        expect(ok.needs_confirmation).toBeUndefined(); // passed the gate (the handler then needs a task)
    });

    it("showing the total counts as asking: one yes then grants the confirm", async () => {
        _resetConsent();
        noteOwnerMessage("order dal makhani");
        runSiteTask.mockReset();
        const pending = { taskId: "t", pendingConfirm: { summary: "Dal ₹199", amount: 199, submit: {} } };
        runSiteTask.mockResolvedValueOnce({ status: "options", options: [{ id: "d1", label: "Dal" }], task: pending });
        runSiteTask.mockResolvedValueOnce({
            status: "confirm",
            confirm: { summary: "Dal ₹199", amount: 199 },
            task: pending,
        });
        runSiteTask.mockResolvedValueOnce({ status: "done", summary: "Order placed #1", task: pending });
        await executeTool("site_task", { action: "search", query: "dal" });
        await executeTool("site_task", { action: "select", option_id: "d1" });
        noteOwnerMessage("yes");
        const r = JSON.parse(await executeTool("site_task", { action: "confirm", amount: 199, confirmed: true }));
        expect(r.status).toBe("done");
    });

    it("a total reached inside a swarm is not an ask: an owner ok sent mid-run grants nothing", async () => {
        _resetConsent();
        noteOwnerMessage("research dal prices");
        runSiteTask.mockReset();
        const pending = { taskId: "t", pendingConfirm: { summary: "Dal ₹199", amount: 199, submit: {} } };
        runSiteTask.mockResolvedValueOnce({
            status: "confirm",
            confirm: { summary: "Dal ₹199", amount: 199 },
            task: pending,
        });
        const run = {
            consentKey: swarmConsentKey("t"),
            consentGranted: false,
            blocked: [],
            approvedSteps: new Set<string>(),
        };
        await withSwarmRun(run, () => executeTool("site_task", { action: "search", query: "dal" }));
        noteOwnerMessage("ok"); // about something else, while the swarm ran
        const r = JSON.parse(await executeTool("site_task", { action: "confirm", amount: 199, confirmed: true }));
        expect(r.needs_confirmation).toBe(true);
        expect(runSiteTask).toHaveBeenCalledTimes(1);
    });

    it("a swarm never places an order: confirm is refused even in an approved step, and reported as a payment", async () => {
        _resetConsent();
        runSiteTask.mockReset();
        const run = {
            consentKey: swarmConsentKey("t2"),
            consentGranted: true,
            blocked: [] as Array<{ step?: string; tool: string; summary: string }>,
            approvedSteps: new Set<string>(["s1"]),
        };
        const r = JSON.parse(
            await withSwarmRun(run, () =>
                withSwarmStep({ stepId: "s1", stepApproved: true }, () =>
                    executeTool("site_task", { action: "confirm", amount: 199, confirmed: true }),
                ),
            ),
        );
        expect(r.needs_owner_approval).toBe(true);
        expect(runSiteTask).not.toHaveBeenCalled();
        expect(run.blocked).toHaveLength(1);
        expect(isPaymentHold(run.blocked[0])).toBe(true);
        expect(run.blocked[0].summary).toContain("199");
    });
});
