// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Regressions from the computer-use review: Dock order, disabled stop, label-word ties, menus past the window.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AxDump, AxNode } from "../ax-dump.js";

const dumpDock = vi.fn(async (): Promise<AxDump | null> => null);
const cloudGroundClick = vi.fn();
vi.mock("../ax-dump.js", async (orig) => ({ ...(await orig<typeof import("../ax-dump.js")>()), dumpDock }));
vi.mock("../cloud-grounding.js", () => ({ cloudGroundClick }));

const { findClickTarget } = await import("../perception-router.js");
const { flattenInteractive, matchElementByLabel } = await import("../ax-dump.js");

const n = (role: string, label: string | null, x: number, y: number, kids: AxNode[] = [], enabled = true, w = 80, h = 24): AxNode => ({
    role, label, value: null, x, y, w, h, focusable: false, enabled, children: kids,
});
const dump = (app: string, kids: AxNode[], root = n("AXWindow", "w", 0, 0, kids, true, 800, 600)): AxDump => ({
    app, pid: 7, trusted: true, depth: 20, elapsedMs: 0, source: "swift", root,
});
const dock = dump("Dock", [], n("AXApplication", "Dock", 0, 0, [n("AXDockItem", "Mail", 400, 900, [], true, 44, 56)], true, 0, 0));
const opts = (axDumpHint: AxDump) => ({
    axDumpHint,
    forceProfile: "lite" as const,
    screenshot: async () => ({ path: "/tmp/x.png" }),
    llm: {} as never,
});

describe("cascade order", () => {
    beforeEach(() => {
        process.env.ATLAS_NO_AX_RETRY = "true";
        dumpDock.mockReset();
        dumpDock.mockResolvedValue(dock);
        cloudGroundClick.mockReset();
    });

    it("a front-app miss goes to vision before a same-named Dock item", async () => {
        cloudGroundClick.mockResolvedValue({ x: 50, y: 60, confidence: 0.9 });
        const r = await findClickTarget("click Mail", opts(dump("Chrome", [n("AXButton", "Reload", 10, 10)])));
        expect(r?.source).toBe("cloud_grounding");
        expect(dumpDock).not.toHaveBeenCalled();
    });

    it("the Dock is still the last resort when vision misses too", async () => {
        cloudGroundClick.mockResolvedValue({ error: "not_found", confidence: 0 });
        const r = await findClickTarget("click Mail", opts(dump("Chrome", [n("AXButton", "Reload", 10, 10)])));
        expect(r?.ax?.pid).toBe(7);
        expect(r?.matchedLabel).toBe("Mail");
    });

    it("the Dock fallback doesn't take the front app's own icon for a target inside it", async () => {
        cloudGroundClick.mockResolvedValue({ error: "not_found", confidence: 0 });
        dumpDock.mockResolvedValue(
            dump("Dock", [], n("AXApplication", "Dock", 0, 0, [n("AXDockItem", "Finder", 341, 895, [], true, 44, 56)], true, 0, 0)),
        );
        const r = await findClickTarget("Downloads in the Finder sidebar", opts(dump("Finder", [n("AXButton", "Close", 10, 10)])));
        expect(r).toBeNull();
        // Asking for the app itself still finds its icon.
        expect((await findClickTarget("Finder in the Dock", opts(dump("Finder", []))))?.matchedLabel).toBe("Finder");
    });

    it("a disabled-only AX match stops before vision clicks the greyed-out pixels", async () => {
        cloudGroundClick.mockResolvedValue({ x: 50, y: 60, confidence: 0.9 });
        let reason: string | undefined;
        const r = await findClickTarget("Send", {
            ...opts(dump("Mail", [n("AXButton", "Send", 10, 10, [], false)])),
            onMiss: (m) => (reason = m.reason),
        });
        expect(r).toBeNull();
        expect(reason).toBe("disabled");
        expect(cloudGroundClick).not.toHaveBeenCalled();
    });

    it("a disabled fuzzy near-match ('Send Later' for 'Send') does not stop the cascade", async () => {
        cloudGroundClick.mockResolvedValue({ x: 50, y: 60, confidence: 0.9 });
        const d = dump("Mail", [n("AXButton", "Send Later", 10, 10, [], false)]);
        expect(matchElementByLabel(flattenInteractive(d), "Send", 0.8, "Mail").disabled?.label).toBe("Send Later");
        const r = await findClickTarget("Send", opts(d));
        expect(r?.source).toBe("cloud_grounding");
    });

    it("an exact disabled match is not swapped for an enabled fuzzy one", async () => {
        const r = await findClickTarget(
            "Send",
            opts(dump("Mail", [n("AXButton", "Send", 10, 10, [], false), n("AXButton", "Send Later", 10, 50)])),
        );
        expect(r).toBeNull();
    });
});

describe("label matching", () => {
    it("a label word ('Last Name') is not read as a position: the tie stays ambiguous", () => {
        const els = flattenInteractive(
            dump("Safari", [n("AXTextField", "Last Name", 10, 100), n("AXTextField", "Last Name", 10, 400)]),
        );
        expect(matchElementByLabel(els, "Last Name field in the billing section").ambiguous).toHaveLength(2);
        expect(matchElementByLabel(els, "the bottom Last Name field").el?.center.y).toBe(412);
    });

    it("an open pop-up menu hanging past its window is not offscreen", () => {
        const menu = n("AXMenu", null, 10, 500, [n("AXMenuItem", "Large", 10, 650)], true, 120, 200);
        const els = flattenInteractive(dump("App", [n("AXPopUpButton", "Size", 10, 480, [menu])])); // window ends at y=600
        expect(els.find((e) => e.label === "Large")?.offscreen).toBeUndefined();
    });

    it("a web role=menu list scrolled past the window still marks its items offscreen", () => {
        const menu = n("AXMenu", null, 0, 100, [n("AXMenuItem", "Billing", 10, 900)], true, 200, 1200);
        const web = n("AXWebArea", null, 0, 0, [menu], true, 800, 2000);
        const els = flattenInteractive(dump("Chrome", [web])); // window ends at y=600
        expect(els.find((e) => e.label === "Billing")?.offscreen).toBe(true);
    });
});
