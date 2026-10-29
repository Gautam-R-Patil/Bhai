// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { describe, expect, it } from "vitest";
import { osComputerAction } from "../os-computer-action.js";

describe("os_computer_action — input validation (no OS dispatch)", () => {
    it("rejects empty input", async () => {
        const result = JSON.parse(await osComputerAction.handler({} as any));
        expect(result.success).toBe(false);
        expect(result.error).toContain("action");
    });

    it("rejects unknown action", async () => {
        const result = JSON.parse(await osComputerAction.handler({ action: "delete_everything" } as any));
        expect(result.success).toBe(false);
    });

    it("rejects click without coord", async () => {
        const result = JSON.parse(await osComputerAction.handler({ action: "click" } as any));
        expect(result.success).toBe(false);
        expect(result.error).toContain("coord");
    });

    it("rejects click with invalid coord shape", async () => {
        const result = JSON.parse(await osComputerAction.handler({ action: "click", coord: "0.5,0.5" } as any));
        expect(result.success).toBe(false);
    });

    it("rejects click with invalid button", async () => {
        const result = JSON.parse(
            await osComputerAction.handler({ action: "click", coord: [0.5, 0.5], button: "explode" } as any),
        );
        expect(result.success).toBe(false);
    });

    it("rejects drag with single point", async () => {
        const result = JSON.parse(await osComputerAction.handler({ action: "drag", path: [[0.1, 0.1]] } as any));
        expect(result.success).toBe(false);
    });

    it("rejects scroll with zero velocity", async () => {
        const result = JSON.parse(
            await osComputerAction.handler({ action: "scroll", coord: [0.5, 0.5], scrollDx: 0, scrollDy: 0 } as any),
        );
        expect(result.success).toBe(false);
    });

    it("rejects type with empty text", async () => {
        const result = JSON.parse(await osComputerAction.handler({ action: "type", text: "" } as any));
        expect(result.success).toBe(false);
    });

    it("rejects hold_key without duration", async () => {
        const result = JSON.parse(await osComputerAction.handler({ action: "hold_key", text: "shift" } as any));
        expect(result.success).toBe(false);
    });

    it("rejects wait beyond 60s (foot-gun guard)", async () => {
        const result = JSON.parse(await osComputerAction.handler({ action: "wait", durationMs: 120_000 } as any));
        expect(result.success).toBe(false);
    });
});
