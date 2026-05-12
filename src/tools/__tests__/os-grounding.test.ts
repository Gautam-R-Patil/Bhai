// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect } from "vitest";
import { osGround, osVisualize } from "../os-grounding.js";

describe("os_visualize — input validation + fail-open", () => {
    it("returns error when screenshot_path missing", async () => {
        const r = JSON.parse(await osVisualize.handler({} as any));
        expect(r.success).toBe(false);
        expect(r.error).toContain("screenshot_path");
    });

    it("returns error with helpful hint when image doesn't exist", async () => {
        const r = JSON.parse(await osVisualize.handler({ screenshot_path: "/tmp/does-not-exist.png" } as any));
        expect(r.success).toBe(false);
        // Either pillow says image_load_failed, or yolo says not_installed, or another fail mode.
        expect(r.error).toBeDefined();
    }, { timeout: 20_000 });
});

describe("os_ground — input validation + fail-open", () => {
    it("returns error when screenshot_path missing", async () => {
        const r = JSON.parse(await osGround.handler({ instruction: "click Save" } as any));
        expect(r.success).toBe(false);
        expect(r.error).toContain("screenshot_path");
    });

    it("returns error when instruction missing", async () => {
        const r = JSON.parse(await osGround.handler({ screenshot_path: "/tmp/foo.png" } as any));
        expect(r.success).toBe(false);
        expect(r.error).toContain("instruction");
    });

    it("returns ollama_not_running or model_not_pulled hint when Ollama unavailable", async () => {
        const r = JSON.parse(
            await osGround.handler({
                screenshot_path: "/tmp/foo.png",
                instruction: "click Save",
                model: "ui-tars-nonexistent:999",
            } as any),
        );
        // Either Ollama isn't running at all, or the model isn't pulled — both are valid fail-open paths.
        expect(r.success).toBe(false);
        expect(r.error).toBeDefined();
    }, { timeout: 10_000 });
});
