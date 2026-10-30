// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Read a background app by name: the model has a name, not a pid.
import { describe, expect, it, vi } from "vitest";

const dump = vi.fn(async (_o: { pid?: number }) => ({ error: "stop here" }));
vi.mock("../../screen/ax-dump.js", async (orig) => ({ ...(await orig<object>()), dumpAccessibilityTree: dump }));
vi.mock("../../screen/frontmost.js", async (orig) => ({
    ...(await orig<object>()),
    pidOfApp: async (name: string) => (name === "Finder" ? 4242 : 0),
}));
const { osInspect, windowTitles } = await import("../os-inspect.js");

describe.skipIf(process.platform !== "darwin")("os_inspect app", () => {
    it("inspects a running app by name, without a pid", async () => {
        await osInspect.handler({ app: "Finder" });
        expect(dump.mock.calls.at(-1)?.[0]).toMatchObject({ pid: 4242 });
    });
    it("says when the app isn't running", async () => {
        const r = JSON.parse(String(await osInspect.handler({ app: "Nope" })));
        expect(r).toMatchObject({ success: false, error: "Nope isn't running." });
    });
});

describe("os_inspect window titles", () => {
    it("lists the app's window titles, not its buttons", () => {
        const n = (role: string, label: string, children: unknown[] = []) => ({ role, label, x: 0, y: 0, w: 0, h: 0, focusable: false, enabled: true, children });
        const root = n("AXApplication", "Finder", [n("AXWindow", "dist", [n("AXButton", "Back")]), n("AXMenuBar", "")]);
        expect(windowTitles(root as never)).toEqual(["dist"]);
    });
});
