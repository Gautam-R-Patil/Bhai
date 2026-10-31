// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// vault_authorize_payment binds the owner's OK to the MERCHANT: the consent prompt
// names the live host, and a yes for one site can't authorize paying on another
// (the tab can't be swapped between the ask and the confirm). Finding #1.
import { beforeEach, describe, expect, it, vi } from "vitest";

let liveHost = "https://checkout.zomato.com/pay";
vi.mock("./browser/core.js", () => ({ getActivePage: async () => ({}) }));
vi.mock("./browser/vault-typing.js", () => ({ liveUrl: async () => liveHost }));
vi.mock("../hooks/index.js", async (orig) => ({
    ...(await orig<object>()),
    firePreToolUse: async (_n: string, input: Record<string, unknown>) => ({ modifiedInput: input }),
    firePostToolUse: async () => ({}),
}));

const { executeTool } = await import("./index.js");
const { handleDesktopLine } = await import("../security/vault.js");
const { _resetConsent, noteOwnerMessage } = await import("../security/consent.js");
const { withSwarmRun, withSwarmStep } = await import("../agents/swarm-context.js");

beforeEach(() => {
    delete process.env.BHAI_NO_VAULT;
    _resetConsent();
    liveHost = "https://checkout.zomato.com/pay";
    handleDesktopLine(`##BHAI_VAULT##${JSON.stringify([{ id: "gpay", label: "GPay", kind: "upi", vpa: "me@okhdfcbank" }])}`);
});

const pay = (confirmed = false) =>
    executeTool("vault_authorize_payment", { entry_id: "gpay", item: "Dinner", amount: 499, ...(confirmed ? { confirmed: true } : {}) });

describe("vault_authorize_payment binds to the live merchant", () => {
    it("the consent prompt names the live host", async () => {
        const r = JSON.parse(await pay());
        expect(r.needs_confirmation).toBe(true);
        expect(r.error).toContain("checkout.zomato.com");
    });

    it("a yes for one site does not authorize paying on a look-alike that was swapped in", async () => {
        JSON.parse(await pay()); // asks — recorded against checkout.zomato.com
        noteOwnerMessage("yes");
        liveHost = "https://evil-pay.example/checkout"; // attacker swaps the tab after approval
        const swapped = JSON.parse(await pay(true));
        expect(swapped.needs_confirmation).toBe(true); // refused: the owner never approved this host
        liveHost = "https://checkout.zomato.com/pay"; // back on the approved host
        const ok = JSON.parse(await pay(true));
        expect(ok).toMatchObject({ authorized: true, site: "checkout.zomato.com" });
    });

    it("inside an approved swarm step an unconfirmed payment is held and reported, not dead-ended", async () => {
        const run = { consentKey: "k", consentGranted: false, blocked: [] as Array<{ step?: string; tool: string; summary: string }> };
        const r = JSON.parse(
            await withSwarmRun(run, () => withSwarmStep({ stepId: "s1", stepApproved: true }, () => pay())),
        );
        expect(r.needs_owner_approval).toBe(true);
        expect(run.blocked).toEqual([
            expect.objectContaining({ step: "s1", tool: "vault_authorize_payment", summary: expect.stringContaining("checkout.zomato.com") }),
        ]);
    });

    it("inside a swarm a payment records no ask, so a later unrelated 'ok' grants nothing", async () => {
        const run = { consentKey: "k", consentGranted: false, blocked: [] as Array<{ step?: string; tool: string; summary: string }> };
        const inSwarm = (confirmed: boolean) =>
            withSwarmRun(run, () => withSwarmStep({ stepId: "s1", stepApproved: true }, () => pay(confirmed)));
        expect(JSON.parse(await inSwarm(false)).needs_owner_approval).toBe(true);
        noteOwnerMessage("ok");
        expect(JSON.parse(await inSwarm(true)).needs_owner_approval).toBe(true); // still refused
        expect(JSON.parse(await pay(true)).needs_confirmation).toBe(true); // no ask was pending to grant
    });
});
