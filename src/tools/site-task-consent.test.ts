// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Checkout through site_task needs the owner's yes in a new message; a
// confirmed:true the model sets on its own (say, because a page told it to) is refused.
import { describe, expect, it, vi } from "vitest";

const runSiteTask = vi.fn();
vi.mock("../skills/site/runtime.js", () => ({ runSiteTask, mintConsent: () => "tok", saveCheckpoint: () => {}, loadCheckpoint: () => null }));
vi.mock("./browser/core.js", () => ({ getActivePage: async () => ({ url: () => "https://shop.test/", on: () => {} }) }));
vi.mock("../skills/site/registry.js", () => ({ findSiteSkill: () => "/skills/shop/skill.cjs" }));

const { executeTool } = await import("./index.js");
const { noteOwnerMessage, _resetConsent } = await import("../security/consent.js");

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
        runSiteTask.mockResolvedValueOnce({ status: "confirm", confirm: { summary: "Dal ₹199", amount: 199 }, task: pending });
        runSiteTask.mockResolvedValueOnce({ status: "done", summary: "Order placed #1", task: pending });
        await executeTool("site_task", { action: "search", query: "dal" });
        await executeTool("site_task", { action: "select", option_id: "d1" });
        noteOwnerMessage("yes");
        const r = JSON.parse(await executeTool("site_task", { action: "confirm", amount: 199, confirmed: true }));
        expect(r.status).toBe("done");
    });
});

