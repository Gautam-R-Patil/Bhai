// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// site_skill_mint start returns at once; when the background mint ends, the
// owner gets one proactive message on the channel they asked on: the approval
// card when it was installed, else why not and the credits it used. Offline:
// the minter, the browser and the dispatcher are stubbed.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MintResult } from "../skills/site/mint/minter.js";

const dispatch = vi.fn(async (_channel: string, _text: string, _mode: string) => {});
vi.mock("../proactive/dispatch.js", () => ({ dispatchProactiveMessage: dispatch }));
vi.mock("./browser/core.js", () => ({ getActivePage: async () => ({ url: () => "http://shop.test/cart?id=p1" }) }));
vi.mock("./forge-approval.js", () => ({ isQuoteAcceptable: () => ({ ok: true }) }));
let next: MintResult;
vi.mock("../skills/site/mint/minter.js", async (orig) => ({
    ...(await orig<typeof import("../skills/site/mint/minter.js")>()),
    mintSiteSkill: vi.fn(async () => next),
}));

const dataDir = mkdtempSync(path.join(tmpdir(), "site-mint-notify-"));
const prevDataDir = process.env.ATLAS_DATA_DIR;
process.env.ATLAS_DATA_DIR = dataDir;
const trace = path.join(dataDir, "site-mint", "traces", "t_1");
mkdirSync(path.join(trace, "pages"), { recursive: true });
writeFileSync(path.join(trace, "meta.json"), JSON.stringify({ id: "t_1", domain: "shop.test" }));
writeFileSync(
    path.join(trace, "pages", "0.json"),
    JSON.stringify({ url: "http://shop.test/", title: "Shop", text: "", elements: [] }),
);
writeFileSync(path.join(trace, "pages", "0.html"), "<html><body></body></html>");
writeFileSync(
    path.join(trace, "trace.jsonl"),
    `${JSON.stringify({ k: 0, url: "http://shop.test/", title: "Shop", events: [{ op: "fill", target: { tag: "input", path: "x" }, value: "dal", url: "http://shop.test/" }] })}\n`,
);
const skillDir = path.join(dataDir, "store", "shop-test");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
    path.join(skillDir, "skill.json"),
    JSON.stringify({
        name: "shop-test",
        domains: ["shop.test"],
        effect: "write",
        commits: [{ op: "click", target: { sel: "#checkout", text: "Place order" } }],
        questions: [{ id: "otp", kind: "otp", prompt: "Enter the code the shop sent to your phone" }],
        minted: {
            verified: { search: "replay", select: "replay", confirm: "replay", after_confirm: "unverified" },
            untested: ["sold-out item"],
        },
    }),
);

const { setActiveChannel } = await import("./channel-send.js");
const { setSiteMintLLM, siteSkillMintTool } = await import("./site-skill-mint.js");
const { mintSiteSkill } = await import("../skills/site/mint/minter.js");
setSiteMintLLM({} as never);

async function start(r: MintResult) {
    next = r;
    const calls = vi.mocked(mintSiteSkill).mock.results.length;
    const out = JSON.parse(await siteSkillMintTool.handler({ action: "start" }));
    expect(out).toMatchObject({ status: "running" });
    await vi.mocked(mintSiteSkill).mock.results[calls].value; // the mint has ended
    await new Promise((res) => setTimeout(res, 20)); // and its notice was sent
}

beforeEach(() => dispatch.mockClear());
afterAll(() => {
    if (prevDataDir === undefined) delete process.env.ATLAS_DATA_DIR;
    else process.env.ATLAS_DATA_DIR = prevDataDir;
});

describe("the owner is told when a mint ends", () => {
    it("installed: the approval card, on the channel they asked on, as a review", async () => {
        setActiveChannel("whatsapp");
        await start({ status: "installed", jobId: "m_1", slug: "shop-test", dir: skillDir, credits: 5, turns: 4 });
        expect(dispatch).toHaveBeenCalledTimes(1);
        const [channel, text, mode] = dispatch.mock.calls[0];
        expect([channel, mode]).toEqual(["whatsapp", "review"]);
        expect(text).toContain("I learned shop.test");
        expect(text).toContain('clicking "Place order" after you say yes to the total');
        expect(text).toContain("Enter the code the shop sent to your phone");
        expect(text).toContain("Checked by replaying your session: search, select, confirm");
        expect(text).toContain("Not tested: sold-out item");
        expect(text).toContain('reply "approve the shop-test skill"');
    });

    it("failed or blocked: why, and the credits it used", async () => {
        setActiveChannel(null);
        await start({ status: "failed", jobId: "m_2", slug: "shop-test", reason: "max_turns", credits: 12, turns: 12 });
        await start({
            status: "blocked",
            jobId: "m_3",
            slug: "shop-test",
            reason: "trace_incomplete: never reached results",
            credits: 2,
            turns: 2,
        });
        expect(dispatch.mock.calls.map(([c, t, m]) => [c, m, t])).toEqual([
            [
                "telegram",
                "fyi",
                "I couldn't learn shop.test: it ran out of attempts. That used 12 credits. The browser tools still work there.",
            ],
            [
                "telegram",
                "fyi",
                "I couldn't learn shop.test: trace_incomplete: never reached results. That used 2 credits. The browser tools still work there.",
            ],
        ]);
    });

    it("cancelled: nothing is sent; a dispatch error never breaks the tool", async () => {
        await start({ status: "failed", jobId: "m_4", slug: "shop-test", reason: "cancelled", credits: 1, turns: 1 });
        expect(dispatch).not.toHaveBeenCalled();
        dispatch.mockRejectedValueOnce(new Error("no sender registered for channel: telegram"));
        await start({ status: "failed", jobId: "m_5", slug: "shop-test", reason: "time_limit", credits: 3, turns: 3 });
        expect(dispatch).toHaveBeenCalledTimes(1);
        // The job slot was freed: another start is accepted.
        await start({ status: "failed", jobId: "m_6", slug: "shop-test", reason: "time_limit", credits: 3, turns: 3 });
    });

    it("a job that throws is caught (no unhandled rejection), and its slot is freed", async () => {
        const unhandled = vi.fn();
        process.on("unhandledRejection", unhandled);
        try {
            vi.mocked(mintSiteSkill).mockRejectedValueOnce(new Error("skill.cjs has no phases.search"));
            const out = JSON.parse(await siteSkillMintTool.handler({ action: "start" }));
            expect(out).toMatchObject({ status: "running" });
            await new Promise((res) => setTimeout(res, 20));
            expect(unhandled).not.toHaveBeenCalled();
            expect(dispatch).not.toHaveBeenCalled();
            await start({
                status: "failed",
                jobId: "m_7",
                slug: "shop-test",
                reason: "time_limit",
                credits: 1,
                turns: 1,
            });
        } finally {
            process.off("unhandledRejection", unhandled);
        }
    });
});
