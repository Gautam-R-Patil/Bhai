// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Regressions from the computer-use review: unconfirmed AXPress, menu-bar replay capture, loose app hint.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findClickTarget = vi.fn();
const click = vi.fn();
const classify = vi.fn(async (..._a: unknown[]) => ({ outcome: "success" }));
const recall = vi.fn((): unknown => null);
const press = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: false, error: "unsupported:AXPress" }));
const captured = vi.fn();
const front = { name: "Google Chrome", bundleName: "Google Chrome.app", bundleId: "com.google.Chrome", pid: 9 };
const window = { x: 200, y: 120, w: 600, h: 500 };

vi.mock("node:child_process", () => ({
    execFile: (cmd: string, args: string[], _o: unknown, cb: (e: Error | null, r?: unknown) => void) => {
        if (cmd === "open") return cb(new Error(`Unable to find application named '${args[1]}'`));
        cb(null, { stdout: "", stderr: "" });
    },
}));
vi.mock("../../screen/frontmost.js", async (orig) => ({
    ...(await orig<typeof import("../../screen/frontmost.js")>()),
    getFrontmostApp: async () => front,
    waitForFrontmost: async () => null,
}));
vi.mock("../../screen/perception-router.js", () => ({ findClickTarget, formatCascadeResult: () => "" }));
vi.mock("../../screen/outcome-classifier.js", () => ({ classifyOutcomeFromImages: classify }));
vi.mock("../../screen/ax-dump.js", () => ({
    dumpAccessibilityTree: async () => ({ app: "Google Chrome", root: {} }),
    axPerformAction: press,
}));
vi.mock("../../screen/click-memory.js", () => ({
    recallClickSite: recall,
    recordClickMiss: () => {},
    recordClickSuccess: () => {},
}));
vi.mock("../../screen/drift-calibration.js", () => ({
    applyCalibration: (_m: string, x: number, y: number) => ({ x, y }),
    recordCalibrationSample: () => {},
}));
vi.mock("../../screen/screen-dimensions.js", () => ({
    getScreenDimensions: async () => ({
        width: 1470,
        height: 956,
        originX: 0,
        originY: 0,
        monitorId: "m",
        focusedWindow: window,
    }),
    isFallbackDims: () => false,
    captureRegion: async (r: unknown) => {
        captured(r);
        return Buffer.from("png");
    },
}));
vi.mock("../platform-bridge.js", () => ({ takeScreenshot: async () => Buffer.from("png") }));
vi.mock("../os-computer-action.js", () => ({
    executeStructuredAction: async (act: { action: string }) => {
        if (act.action !== "mouse_move") click(act);
        return {};
    },
}));

const { osSmartClick } = await import("../os-smart-click.js");
const ax = { pid: 42, path: [0, 3], role: "AXMenuBarItem", bbox: { x: 50, y: 0, w: 30, h: 22 } };

describe("os_smart_click review fixes", () => {
    beforeEach(() => {
        findClickTarget.mockReset();
        click.mockClear();
        classify.mockClear();
        captured.mockClear();
        press.mockClear();
        recall.mockReset();
        recall.mockReturnValue(null);
    });

    it("an AXPress that may have run (timeout / failed:<code>) is not repeated as a pixel click", async () => {
        press.mockResolvedValueOnce({ ok: false, error: "failed:-25204", unconfirmed: true });
        findClickTarget.mockResolvedValueOnce({ x: 65, y: 11, confidence: 0.99, source: "ax_exact", ax, matchedLabel: "File" });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "the File menu" }));
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/ax_press_unconfirmed/);
        expect(click).not.toHaveBeenCalled();
    });

    it("an AXPress refused before acting still falls back to a click", async () => {
        press.mockResolvedValueOnce({ ok: false, error: "unsupported:AXPress", unconfirmed: false });
        findClickTarget.mockResolvedValueOnce({ x: 65, y: 11, confidence: 0.99, source: "ax_exact", ax, matchedLabel: "File" });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "the File menu" }));
        expect(out.success).toBe(true);
        expect(click).toHaveBeenCalledTimes(1);
    });

    it("a menu-bar memory replay is verified on the monitor, not the window it lies outside", async () => {
        recall.mockReturnValue({
            xNorm: 65 / 1470,
            yNorm: 11 / 956,
            confidence: 0.95,
            successCount: 6,
            lastScreenWidth: 1470,
            lastScreenHeight: 956,
        });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "File menu" }));
        expect(out).toMatchObject({ success: true, source: "memory", clicked: { x: 65, y: 11 } });
        expect(captured).toHaveBeenCalledWith({ x: 0, y: 0, w: 1470, h: 956 });
        expect(classify.mock.calls[0].slice(2, 6)).toEqual([65, 11, 1470, 956]);
    });

    it("a loose app hint `open -a` can't resolve clicks in the app already in front", async () => {
        findClickTarget.mockResolvedValueOnce({ x: 300, y: 200, confidence: 0.99, source: "ax_exact" });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "the Reload button", app: "Chrome" }));
        expect(out.success).toBe(true);
        expect(click).toHaveBeenCalledTimes(1);
    });

    it("app: Dock does not wait for the Dock to become frontmost", async () => {
        findClickTarget.mockResolvedValueOnce({ x: 300, y: 900, confidence: 0.99, source: "ax_exact" });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "Safari", app: "Dock" }));
        expect(out.success).toBe(true);
    });

    describe("window-level clicks", () => {
        const row = { pid: 42, path: [1, 0, 0, 0, 6], role: "AXRow", bbox: { x: 303, y: 412, w: 148, h: 32 } };
        const target = () => ({ x: 377, y: 428, confidence: 0.85, source: "ax_fuzzy", ax: { ...row }, matchedLabel: "Downloads" });
        const actions = (byAction: Record<string, unknown>) =>
            press.mockImplementation(async (...a: unknown[]) => byAction[a[2] as string] ?? { ok: false, error: "unsupported:x" });
        afterEach(() => press.mockImplementation(async () => ({ ok: false, error: "unsupported:AXPress" })));

        it("raises the element's window, and refuses to click when another app still covers it", async () => {
            actions({ focus: { ok: true, frame: row.bbox, hitPid: 777 } });
            findClickTarget.mockResolvedValueOnce(target());
            const out = JSON.parse(await osSmartClick.handler({ instruction: "Downloads in the Finder sidebar" }));
            expect(out.error).toMatch(/element_covered/);
            expect(press.mock.calls.map((c) => c[2])).toEqual(["press", "focus"]);
            expect(click).not.toHaveBeenCalled();
        });

        it("clicks once its own window is on top, at the element's current centre; Bhai's windows don't count", async () => {
            for (const hitPid of [42, process.ppid]) {
                click.mockClear();
                actions({ focus: { ok: true, frame: { x: 303, y: 500, w: 148, h: 32 }, hitPid } });
                findClickTarget.mockResolvedValueOnce(target());
                const out = JSON.parse(await osSmartClick.handler({ instruction: "Downloads in the Finder sidebar" }));
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalledTimes(1);
                expect(click.mock.calls[0][0]).toMatchObject({ coord: [377, 516] });
            }
        });
    });
});
