// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("offloadIfLarge", () => {
    it("keeps a result inline when the tool's own cap is above the offload line (a finished report)", async () => {
        vi.stubEnv("BHAI_DATA_DIR", mkdtempSync(join(tmpdir(), "offload-")));
        const { offloadIfLarge } = await import("./tool-output-offload.js");
        const report = JSON.stringify({ status: "completed", report: "finding. ".repeat(1500) }); // ~13.5K
        const r = offloadIfLarge("check_deep_research", "t1", "turn-1", report, 16000);
        expect(r.offloaded).toBe(false);
        expect(r.content).toBe(report);
        vi.unstubAllEnvs();
    });

    it("offloads a report past the tool's own cap, so the model still gets a path to all of it", async () => {
        vi.stubEnv("BHAI_DATA_DIR", mkdtempSync(join(tmpdir(), "offload-")));
        const { offloadIfLarge } = await import("./tool-output-offload.js");
        const report = JSON.stringify({ status: "completed", report: "finding. ".repeat(3000) }); // ~27K
        const r = offloadIfLarge("check_deep_research", "t2", "turn-2", report, 16000);
        expect(r.offloaded).toBe(true);
        expect(r.content).toContain(r.savedAt);
        expect(readFileSync(r.savedAt as string, "utf-8")).toContain("finding. ".repeat(3000));
        vi.unstubAllEnvs();
    });

    it("a result cut below the offload line still leaves a path to the rest", async () => {
        vi.stubEnv("BHAI_DATA_DIR", mkdtempSync(join(tmpdir(), "offload-")));
        const { keepRestReadable } = await import("./tool-output-offload.js");
        const article = "para. ".repeat(1000); // 6K: over the 4K default cut, under the 8K offload line
        const out = keepRestReadable("browser_extract_article", "t3", "turn-3", article, article.slice(0, 4000));
        const path = /file_path="([^"]+)"/.exec(out)?.[1] as string;
        expect(readFileSync(path, "utf-8")).toBe(article);
        expect(keepRestReadable("x", "t4", "turn-4", "short", "short")).toBe("short"); // nothing cut, nothing saved
        vi.unstubAllEnvs();
    });

    it("a saved JSON result reads line by line: its text keeps real newlines", async () => {
        vi.stubEnv("BHAI_DATA_DIR", mkdtempSync(join(tmpdir(), "offload-")));
        const { offloadIfLarge } = await import("./tool-output-offload.js");
        const page = Array.from({ length: 3000 }, (_, n) => `line ${n}`).join("\n");
        const r = offloadIfLarge("web_read", "t5", "turn-5", JSON.stringify({ success: true, text: page }));
        const saved = readFileSync(r.savedAt as string, "utf-8");
        expect(saved).toContain(`## text\n${page}`);
        expect(saved.split("\n").length).toBeGreaterThan(3000);
        vi.unstubAllEnvs();
    });
});
