// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { beforeEach, describe, expect, it, vi } from "vitest";

const findClickTarget = vi.fn();
const click = vi.fn(async () => JSON.stringify({ success: true }));
const classify = vi.fn();
const recall = vi.fn((): unknown => null);
let window = { x: 0, y: 0, w: 1000, h: 800 };

vi.mock("../../screen/perception-router.js", () => ({ findClickTarget, formatCascadeResult: () => "" }));
vi.mock("../../screen/outcome-classifier.js", () => ({ classifyOutcomeFromImages: classify }));
vi.mock("../../screen/ax-dump.js", () => ({ dumpAccessibilityTree: async () => ({ app: "Calculator", root: {} }) }));
vi.mock("../../screen/click-memory.js", () => ({ recallClickSite: recall, recordClickMiss: () => {}, recordClickSuccess: () => {} }));
vi.mock("../../screen/drift-calibration.js", () => ({ applyCalibration: (_m: string, x: number, y: number) => ({ x, y }), recordCalibrationSample: () => {} }));
vi.mock("../../screen/screen-dimensions.js", () => ({
    getScreenDimensions: async () => ({ width: 1470, height: 956, originX: 0, originY: 0, monitorId: "m", focusedWindow: window }),
    isFallbackDims: () => false,
}));
vi.mock("../platform-bridge.js", () => ({ takeScreenshot: async () => Buffer.from("png") }));
vi.mock("../os-computer-action.js", () => ({ osComputerAction: { handler: click } }));

const { osSmartClick, setSmartClickLLM } = await import("../os-smart-click.js");
const { MODELS } = await import("../../llm.js");

const cloudHit = (x: number) => ({ x, y: 50, confidence: 0.9, source: "cloud_grounding" });

describe("os_smart_click grounding", () => {
    beforeEach(() => {
        vi.useRealTimers();
        findClickTarget.mockReset();
        click.mockClear();
        classify.mockReset();
        setSmartClickLLM({} as never);
        recall.mockReset();
        recall.mockReturnValue(null);
        window = { x: 0, y: 0, w: 1000, h: 800 };
    });

    it("click memory follows the window, and ignores a resized one", async () => {
        const row = { xNorm: 0.5, yNorm: 0.5, confidence: 0.95, successCount: 6, lastScreenWidth: 400, lastScreenHeight: 300 };
        recall.mockReturnValue(row);
        window = { x: 500, y: 100, w: 400, h: 300 };
        const out = JSON.parse(await osSmartClick.handler({ instruction: "=" }));
        expect(out).toMatchObject({ success: true, source: "memory", clicked: { x: 700, y: 250 } });

        window = { x: 500, y: 100, w: 600, h: 300 }; // resized → re-ground, don't trust the row
        findClickTarget.mockResolvedValueOnce({ x: 10, y: 10, confidence: 0.99, source: "ax_exact" });
        const again = JSON.parse(await osSmartClick.handler({ instruction: "=" }));
        expect(again.source).toBe("ax_exact");
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
        recall.mockReturnValue({ xNorm: 60 / 1470, yNorm: 10 / 956, confidence: 0.95, successCount: 6, lastScreenWidth: 1470, lastScreenHeight: 956 });
        window = { x: 500, y: 300, w: 400, h: 300 };
        const out = JSON.parse(await osSmartClick.handler({ instruction: "File menu" }));
        expect(out.clicked).toEqual({ x: 60, y: 10 });
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
