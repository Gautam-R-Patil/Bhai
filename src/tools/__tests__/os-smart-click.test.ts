// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { beforeEach, describe, expect, it, vi } from "vitest";

const findClickTarget = vi.fn();
const click = vi.fn();
const classify = vi.fn();
const recall = vi.fn((): unknown => null);
const recordMiss = vi.fn();
const press = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: false, error: "unsupported:AXPress" }));
let window = { x: 0, y: 0, w: 1000, h: 800 };

vi.mock("../../screen/perception-router.js", () => ({ findClickTarget, formatCascadeResult: () => "" }));
vi.mock("../../screen/outcome-classifier.js", () => ({ classifyOutcomeFromImages: classify }));
vi.mock("../../screen/ax-dump.js", () => ({
    dumpAccessibilityTree: async () => ({ app: "Calculator", root: {} }),
    axPerformAction: press,
}));
vi.mock("../../screen/click-memory.js", () => ({
    recallClickSite: recall,
    recordClickMiss: recordMiss,
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
    captureRegion: async () => Buffer.from("png"),
}));
vi.mock("../platform-bridge.js", () => ({ takeScreenshot: async () => Buffer.from("png") }));
// Clicks are counted; the hover-first mouse_move before a verified click is not.
vi.mock("../os-computer-action.js", () => ({
    executeStructuredAction: async (act: { action: string }) => {
        if (act.action !== "mouse_move") click(act);
        return {};
    },
}));

const { osSmartClick, setSmartClickLLM } = await import("../os-smart-click.js");
const { MODELS } = await import("../../llm.js");

const cloudHit = (x: number) => ({ x, y: 50, confidence: 0.9, source: "cloud_grounding" });

describe("os_smart_click grounding", () => {
    beforeEach(() => {
        vi.useRealTimers();
        findClickTarget.mockReset();
        click.mockClear();
        classify.mockReset();
        classify.mockResolvedValue({ outcome: "success" });
        recordMiss.mockClear();
        press.mockClear();
        setSmartClickLLM({} as never);
        recall.mockReset();
        recall.mockReturnValue(null);
        window = { x: 0, y: 0, w: 1000, h: 800 };
    });

    it("click memory follows the window, and ignores a resized one", async () => {
        const row = {
            xNorm: 0.5,
            yNorm: 0.5,
            confidence: 0.95,
            successCount: 6,
            lastScreenWidth: 400,
            lastScreenHeight: 300,
        };
        recall.mockReturnValue(row);
        window = { x: 500, y: 100, w: 400, h: 300 };
        const out = JSON.parse(await osSmartClick.handler({ instruction: "=" }));
        expect(out).toMatchObject({ success: true, source: "memory", clicked: { x: 700, y: 250 } });

        window = { x: 500, y: 100, w: 600, h: 300 }; // resized → re-ground, don't trust the row
        findClickTarget.mockResolvedValueOnce({ x: 10, y: 10, confidence: 0.99, source: "ax_exact" });
        const again = JSON.parse(await osSmartClick.handler({ instruction: "=" }));
        expect(again.source).toBe("ax_exact");
    });

    it("app hint Dock tells the cascade to search the Dock first; other apps do not", async () => {
        findClickTarget.mockResolvedValue({ x: 10, y: 10, confidence: 0.99, source: "ax_exact" });
        await osSmartClick.handler({ instruction: "Safari", app: "Dock" });
        expect(findClickTarget.mock.calls[0][1].dockFirst).toBe(true);
        await osSmartClick.handler({ instruction: "Safari" });
        expect(findClickTarget.mock.calls[1][1].dockFirst).toBe(false);
    });

    it("re-grounds a verified Haiku miss once with Sonnet", async () => {
        findClickTarget.mockResolvedValueOnce(cloudHit(100)).mockResolvedValueOnce(cloudHit(140));
        classify.mockResolvedValueOnce({ outcome: "no_op" }).mockResolvedValueOnce({ outcome: "success" });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "the 2 button" }));
        expect(out.success).toBe(true);
        expect(findClickTarget).toHaveBeenCalledTimes(2);
        expect(findClickTarget.mock.calls[0][1].groundingModel).toBeUndefined(); // Haiku default
        expect(findClickTarget.mock.calls[1][1].groundingModel).toBe(MODELS.SONNET);
        expect(findClickTarget.mock.calls[1][1].skipTiers).not.toContain("cloud_grounding");
        expect(click).toHaveBeenCalledTimes(2);
    });

    it("a click that changed something elsewhere (wrong_target) is not clicked again", async () => {
        findClickTarget.mockResolvedValueOnce(cloudHit(100)).mockResolvedValueOnce(cloudHit(300));
        classify.mockResolvedValueOnce({ outcome: "wrong_target" });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "Send" }));
        expect(out.success).toBe(false);
        expect(click).toHaveBeenCalledTimes(1);
    });

    it("a menu-bar click outside the window is remembered against the monitor", async () => {
        recall.mockReturnValue({
            xNorm: 60 / 1470,
            yNorm: 10 / 956,
            confidence: 0.95,
            successCount: 6,
            lastScreenWidth: 1470,
            lastScreenHeight: 956,
        });
        window = { x: 500, y: 300, w: 400, h: 300 };
        const out = JSON.parse(await osSmartClick.handler({ instruction: "File menu" }));
        expect(out.clicked).toEqual({ x: 60, y: 10 });
    });

    it("a remembered spot that does nothing is forgotten and re-grounded", async () => {
        recall.mockReturnValue({
            xNorm: 0.5,
            yNorm: 0.5,
            confidence: 0.95,
            successCount: 6,
            lastScreenWidth: 1000,
            lastScreenHeight: 800,
        });
        classify.mockResolvedValueOnce({ outcome: "no_op" });
        findClickTarget.mockResolvedValueOnce({ x: 10, y: 10, confidence: 0.99, source: "ax_exact" });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "=" }));
        expect(recordMiss).toHaveBeenCalledTimes(1);
        expect(out.source).toBe("ax_exact");
        expect(click).toHaveBeenCalledTimes(2);
    });

    it("a remembered spot that hit something else is not clicked again", async () => {
        recall.mockReturnValue({
            xNorm: 0.5,
            yNorm: 0.5,
            confidence: 0.95,
            successCount: 6,
            lastScreenWidth: 1000,
            lastScreenHeight: 800,
        });
        classify.mockResolvedValueOnce({ outcome: "wrong_target" });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "Send" }));
        expect(out).toMatchObject({ success: false, error: "click_unverified", source: "memory" });
        expect(recordMiss).toHaveBeenCalledTimes(1);
        expect(click).toHaveBeenCalledTimes(1);
        expect(findClickTarget).not.toHaveBeenCalled();
    });

    it("an AX hit is pressed via AXPress when the element supports it", async () => {
        press.mockResolvedValueOnce({ ok: true, frame: { x: 0, y: 0, w: 20, h: 20 } });
        const ax = { pid: 42, path: [0, 3], role: "AXButton", bbox: { x: 0, y: 0, w: 20, h: 20 } };
        findClickTarget.mockResolvedValueOnce({ x: 10, y: 10, confidence: 0.99, source: "ax_exact", ax });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "OK" }));
        expect(out).toMatchObject({ success: true, verified: "ax_press" });
        expect(press).toHaveBeenCalledWith(42, ax, "press");
        expect(click).not.toHaveBeenCalled();
    });

    it("an off-screen AX element that can't be revealed is an error, not an edge click", async () => {
        const ax = { pid: 42, path: [0], role: "AXRow", bbox: { x: 0, y: 2000, w: 20, h: 20 }, offscreen: true };
        findClickTarget.mockResolvedValueOnce({
            x: 10,
            y: 2010,
            confidence: 0.99,
            source: "ax_exact",
            ax,
            matchedLabel: "Row",
        });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "Row" }));
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/element_offscreen/);
        expect(click).not.toHaveBeenCalled();
    });

    it("never clicks once grounding outlives the deadline", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        findClickTarget.mockImplementationOnce(async () => {
            vi.setSystemTime(Date.now() + 41_000); // grounding took 41s
            return cloudHit(100);
        });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "Send" }));
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/nothing was clicked/);
        expect(click).not.toHaveBeenCalled();
    });
});
