// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { beforeEach, describe, expect, it, vi } from "vitest";

const approve = vi.fn(async (slug: string) => ({ ok: true, toolName: slug }));
vi.mock("../forge/orchestrator.js", () => ({
    approveDynamicTool: (slug: string) => approve(slug),
    revokeDynamicTool: vi.fn(),
    isForgeReady: () => true,
}));

const { approveDynamicToolTool } = await import("./forge-approval.js");
const { enterAwaitingDynamicToolApproval, exitPlanMode } = await import("../agents/plan-mode.js");
const { _resetConsent, noteOwnerMessage } = await import("../security/consent.js");

const run = async (quote: string) => JSON.parse(await approveDynamicToolTool.handler({ slug: "t", user_quote: quote }));

describe("approve_dynamic_tool", () => {
    beforeEach(() => {
        _resetConsent();
        approve.mockClear();
        exitPlanMode();
        enterAwaitingDynamicToolApproval("t");
    });

    it("accepts a plain yes from the owner's latest message", async () => {
        noteOwnerMessage("yes");
        expect((await run("yes")).ok).toBe(true);
        expect(approve).toHaveBeenCalledWith("t");
    });

    it("refuses a quote taken from a no", async () => {
        noteOwnerMessage("don't approve this tool");
        expect((await run("approve this tool")).ok).toBe(false);
        expect(approve).not.toHaveBeenCalled();
    });

    it("refuses words the owner never wrote", async () => {
        noteOwnerMessage("yes");
        expect((await run("yes turn it on")).ok).toBe(false);
    });

    it("the orchestrator itself refuses a quote from a no", async () => {
        const real = await vi.importActual<typeof import("../forge/orchestrator.js")>("../forge/orchestrator.js");
        noteOwnerMessage("no, don't turn it on");
        expect(await real.approveDynamicTool("t", "turn it on")).toMatchObject({ ok: false, error: /own yes/ });
    });
});
