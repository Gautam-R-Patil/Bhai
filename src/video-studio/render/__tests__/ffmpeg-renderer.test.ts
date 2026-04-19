// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CropFrame } from "../../effects/auto-crop.js";
import type { EditPlan } from "../../plan/schema.js";
import {
    buildSendcmdScript,
    classifyRenderError,
    compilePlanAsync,
    RenderErrorCategory,
    renderPlan,
} from "../ffmpeg-renderer.js";

vi.mock("../../effects/bg-remove.js", () => ({
    generateAlphaMatte: vi.fn(async () => "/fake/matte.mov"),
}));

const FIXTURE = resolve("src/video-studio/__fixtures__/1s.mp4");
const TEST_ROOT = join(tmpdir(), `atlas-renderer-test-${process.pid}`);

function makePlan(overrides: Partial<EditPlan> = {}): EditPlan {
    const base: EditPlan = {
        projectId: "vid_render_test",
        output: { path: "renders/out.mp4", aspect: "16:9", fps: 30, resolution: "640x360" },
        sources: [{ id: "s1", path: FIXTURE, duration: 1 }],
        tracks: {
            video: [{ id: "v1", source: "s1", in: 0, out: 1 }],
            audio: [],
            overlays: [],
        },
        transitions: [],
        export_targets: ["mp4"],
    };
    return { ...base, ...overrides };
}

beforeAll(async () => {
    if (!existsSync(FIXTURE)) {
        throw new Error(`Missing test fixture: ${FIXTURE}. Generate with the Task 14 fixture command.`);
    }
    await fs.mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("classifyRenderError", () => {
    it("classifies 'Decoder not found' as CodecMissing", () => {
        expect(classifyRenderError("Decoder vp9 not found")).toBe(RenderErrorCategory.CodecMissing);
    });

    it("classifies 'No such filter' as InvalidFilterGraph", () => {
        expect(classifyRenderError("No such filter: 'badfilter'")).toBe(RenderErrorCategory.InvalidFilterGraph);
    });

    it("classifies 'No such file or directory' as SourceUnreadable", () => {
        expect(classifyRenderError("ENOENT: no such file or directory 'missing.mp4'")).toBe(
            RenderErrorCategory.SourceUnreadable,
        );
    });

    it("classifies unknown text as Unknown", () => {
        expect(classifyRenderError("totally random output")).toBe(RenderErrorCategory.Unknown);
    });
});

describe("renderPlan — pre-render failures", () => {
    it("throws SourceUnreadable when a source path does not exist", async () => {
        const plan = makePlan({
            sources: [{ id: "s1", path: "/nonexistent/clip.mp4", duration: 1 }],
        });
        await expect(renderPlan(plan, TEST_ROOT)).rejects.toMatchObject({
            name: "RenderError",
            category: RenderErrorCategory.SourceUnreadable,
        });
    });

    it("throws InvalidFilterGraph when clip.in >= clip.out", async () => {
        const plan = makePlan({
            tracks: {
                video: [{ id: "v1", source: "s1", in: 1, out: 0 }],
                audio: [],
                overlays: [],
            },
        });
        await expect(renderPlan(plan, TEST_ROOT)).rejects.toMatchObject({
            category: RenderErrorCategory.InvalidFilterGraph,
        });
    });

    it("throws InvalidFilterGraph when transition references unknown video id", async () => {
        const plan = makePlan({
            transitions: [{ between: ["v1", "ghost"], type: "xfade", kind: "fade", duration: 0.3 }],
        });
        await expect(renderPlan(plan, TEST_ROOT)).rejects.toMatchObject({
            category: RenderErrorCategory.InvalidFilterGraph,
        });
    });
});

describe("renderPlan — integration happy path", () => {
    it("produces an mp4 file that is readable", async () => {
        const plan = makePlan();
        const result = await renderPlan(plan, TEST_ROOT);
        expect(existsSync(result.outputPath)).toBe(true);
        const stat = await fs.stat(result.outputPath);
        expect(stat.size).toBeGreaterThan(0);
        expect(existsSync(result.logPath)).toBe(true);
    }, 30_000);

    it("reports progress percentage values in [0, 100]", async () => {
        const progressValues: number[] = [];
        const plan = makePlan({
            output: { path: "renders/out2.mp4", aspect: "16:9", fps: 30, resolution: "640x360" },
        });
        await renderPlan(plan, TEST_ROOT, {
            onProgress: (pct) => progressValues.push(pct),
        });
        expect(progressValues.length).toBeGreaterThan(0);
        for (const v of progressValues) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(100);
        }
    }, 30_000);
});

describe("buildSendcmdScript", () => {
    it("produces one sendcmd line per CropFrame", () => {
        const frames: CropFrame[] = [
            { t: 0.0, x: 420, y: 0, w: 607, h: 1080 },
            { t: 0.033, x: 422, y: 0, w: 607, h: 1080 },
        ];
        const script = buildSendcmdScript(frames);
        const lines = script.trim().split("\n");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/^0 crop w 607/);
        expect(lines[0]).toContain("crop h 1080");
        expect(lines[0]).toContain("crop x 420");
        expect(lines[0]).toContain("crop y 0");
        expect(lines[1]).toMatch(/^0\.033/);
    });

    it("each line ends with a semicolon", () => {
        const frames: CropFrame[] = [{ t: 0.0, x: 0, y: 0, w: 607, h: 1080 }];
        expect(buildSendcmdScript(frames).trim()).toMatch(/;$/);
    });

    it("returns empty string for empty input", () => {
        expect(buildSendcmdScript([])).toBe("");
    });
});

describe("compilePlanAsync — effects dispatch", () => {
    it("dispatches color_grade:warm to addColorGrade", async () => {
        const plan = makePlan({
            tracks: {
                video: [{ id: "v1", source: "s1", in: 0, out: 1, effects: ["color_grade:warm"] }],
                audio: [],
                overlays: [],
            },
        });
        const compiled = await compilePlanAsync(plan, TEST_ROOT);
        expect(compiled.filterGraph).toContain("colortemperature=temperature=5500");
    });

    it("dispatches bg_replace to addAlphaMerge and extends inputs", async () => {
        const bgPath = join(TEST_ROOT, "bg.jpg");
        await fs.writeFile(bgPath, "fake-jpg-bytes");
        const plan = makePlan({
            tracks: {
                video: [{ id: "v1", source: "s1", in: 0, out: 1, effects: [`bg_replace:${bgPath}`] }],
                audio: [],
                overlays: [],
            },
        });
        const compiled = await compilePlanAsync(plan, TEST_ROOT);
        expect(compiled.inputs).toContain("/fake/matte.mov");
        expect(compiled.inputs).toContain(bgPath);
        expect(compiled.filterGraph).toContain("alphamerge");
        expect(compiled.filterGraph).toContain("overlay");
    });

    it("warns and skips unknown effect kinds without throwing", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const plan = makePlan({
            tracks: {
                video: [{ id: "v1", source: "s1", in: 0, out: 1, effects: ["sharpen:2x"] }],
                audio: [],
                overlays: [],
            },
        });
        const compiled = await compilePlanAsync(plan, TEST_ROOT);
        expect(warnSpy).toHaveBeenCalled();
        expect(compiled.filterGraph).not.toContain("alphamerge");
        expect(compiled.filterGraph).not.toContain("colortemperature");
        warnSpy.mockRestore();
    });
});
