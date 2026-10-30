// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("offloadIfLarge", () => {
    it("keeps a result inline when the tool's own cap is above the offload line (a finished report)", async () => {
        vi.stubEnv("ATLAS_DATA_DIR", mkdtempSync(join(tmpdir(), "offload-")));
        const { offloadIfLarge } = await import("./tool-output-offload.js");
        const report = JSON.stringify({ status: "completed", report: "finding. ".repeat(1500) }); // ~13.5K
        const r = offloadIfLarge("check_deep_research", "t1", "turn-1", report, 16000);
        expect(r.offloaded).toBe(false);
        expect(r.content).toBe(report);
        vi.unstubAllEnvs();
    });

    it("offloads a report past the tool's own cap, so the model still gets a path to all of it", async () => {
        vi.stubEnv("ATLAS_DATA_DIR", mkdtempSync(join(tmpdir(), "offload-")));
        const { offloadIfLarge } = await import("./tool-output-offload.js");
        const report = JSON.stringify({ status: "completed", report: "finding. ".repeat(3000) }); // ~27K
        const r = offloadIfLarge("check_deep_research", "t2", "turn-2", report, 16000);
        expect(r.offloaded).toBe(true);
        expect(r.content).toContain(r.savedAt);
        expect(readFileSync(r.savedAt as string, "utf-8")).toContain("finding. ".repeat(3000));
        vi.unstubAllEnvs();
    });
});
