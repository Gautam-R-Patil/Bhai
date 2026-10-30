// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Regressions from the computer-use review: os_click_id re-check after os_inspect.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AxDump, AxNode } from "../../screen/ax-dump.js";

let tree: AxDump;
const dumps = vi.fn(async (_o?: unknown) => tree);
let frontPid = 100;
const click = vi.fn(async (_i: unknown) => JSON.stringify({ success: true }));
vi.mock("../../screen/ax-dump.js", async (orig) => ({
    ...(await orig<typeof import("../../screen/ax-dump.js")>()),
    dumpAccessibilityTree: dumps,
}));
vi.mock("../../screen/frontmost.js", () => ({
    getFrontmostApp: async () => ({ name: "Finder", bundleName: "Finder.app", bundleId: "com.apple.finder", pid: frontPid }),
}));
vi.mock("../os-computer-action.js", () => ({ osComputerAction: { handler: click } }));

const { osInspect, osClickId } = await import("../os-inspect.js");

const n = (role: string, label: string | null, value: string | null, y: number, kids: AxNode[] = []): AxNode => ({
    role, label, value, x: 10, y, w: 80, h: 24, focusable: false, enabled: true, children: kids,
});
const app = (name: string, pid: number, kids: AxNode[]): AxDump => ({
    app: name, pid, trusted: true, depth: 20, elapsedMs: 0, source: "swift",
    root: { ...n("AXWindow", "w", null, 0, kids), w: 800, h: 600 },
});
const later = () => vi.setSystemTime(Date.now() + 5_000); // past the 3s fresh window

describe("os_click_id after os_inspect", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        click.mockClear();
        dumps.mockClear();
        frontPid = 100;
    });

    it("clicks an element of an explicitly inspected background pid (the Dock)", async () => {
        tree = app("Dock", 55, [n("AXDockItem", "Safari", null, 500)]);
        await osInspect.handler({ pid: 55 });
        const out = JSON.parse(await osClickId.handler({ id: 1 }));
        expect(out.success).toBe(true);
    });

    it("still refuses when the inspected frontmost app lost focus", async () => {
        frontPid = 55;
        tree = app("Notes", 55, [n("AXButton", "New", null, 10)]);
        await osInspect.handler({});
        frontPid = 100;
        const out = JSON.parse(await osClickId.handler({ id: 1 }));
        expect(out.error).toMatch(/frontmost app changed/);
    });

    it("re-checks at the depth the inspect used", async () => {
        frontPid = 55;
        tree = app("Safari", 55, [n("AXLink", "Docs", null, 10)]);
        await osInspect.handler({ depth: 28 });
        later();
        await osClickId.handler({ id: 1 });
        expect(dumps.mock.calls[1][0]).toMatchObject({ depth: 28 });
    });

    it("a toggled checkbox is the same element on the re-check", async () => {
        frontPid = 55;
        tree = app("App", 55, [n("AXCheckBox", "Remember me", "0", 10)]);
        await osInspect.handler({});
        tree = app("App", 55, [n("AXCheckBox", "Remember me", "1", 10)]);
        later();
        const out = JSON.parse(await osClickId.handler({ id: 1 }));
        expect(out.success).toBe(true);
    });
});

// From the model-ladder eval: the Calculator result lives in an AXStaticText value,
// and without it a model re-pressed "=" (540 → 6,480) to "check".
describe("os_inspect shows on-screen text but not field contents", () => {
    it("shows a static text's value and hides a text field's", async () => {
        frontPid = 55;
        tree = app("Calculator", 55, [
            n("AXStaticText", "Edit field", "540", 10),
            n("AXTextField", "Password hint", "hunter2", 40),
        ]);
        const out = JSON.parse(await osInspect.handler({}));
        expect(out.elements).toContain('"Edit field" = "540"');
        expect(out.elements).not.toContain("hunter2");
    });
});
